// @vitest-environment jsdom
/**
 * FeedbackDialog — the one dialog behind "Send feedback".
 *
 * What is worth pinning down here is the behaviour a user would notice if it
 * regressed: the copy swapping with the kind, the canvas checkbox only being
 * offered for a bug, Escape closing, the readiness meter moving locally when
 * the screenshot is attached (no round trip), a confident duplicate taking the
 * form over, and the exact `submitFeedback` payload the host receives.
 *
 * The canvas capture is the dialog's only image route — there is no picker, no
 * drop zone and no paste handler to test, because GitHub takes no image through
 * a prefilled form and the dialog says so instead of pretending otherwise.
 *
 * The store and the message bus are mocked because this is a component test:
 * the store's own transitions live in editorStore.test.ts, and the host end of
 * every message lives in semanticEditorProvider.feedback.test.ts.
 *
 * Assertions use raw DOM (`textContent`, `className`, `hasAttribute`) — there
 * is no jest-dom here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

import {
  ANALYSIS_DEBOUNCE_MS,
  FEEDBACK_COPY,
  FEEDBACK_PRE_ANALYSIS_TITLE,
  type FeedbackAnalysis,
  type FeedbackCapabilities,
  type FeedbackDiagnosticsView,
} from '../../src/types/feedback';

// ---------------------------------------------------------------------------
// Mocks — hoisted, because the component imports them at module load
// ---------------------------------------------------------------------------

const send = vi.hoisted(() => vi.fn());
const busListeners = vi.hoisted(() => [] as Array<(message: unknown) => void>);

vi.mock('../../webview/hooks/useMessageBus', () => ({
  useSend: () => send,
  useMessageBus: (handler: (message: unknown) => void) => {
    busListeners.push(handler);
  },
}));

// html-to-image needs a real canvas; the capture path is covered in
// screenshot.test.ts, so it is stubbed out here.
const captureScreenshot = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ dataUrl: null, onClipboard: false, error: 'no canvas in jsdom' }),
);
const copyImageToClipboard = vi.hoisted(() => vi.fn().mockResolvedValue(false));

vi.mock('../../webview/lib/screenshot', () => ({
  captureScreenshot,
  copyImageToClipboard,
  copyPngToClipboard: vi.fn().mockResolvedValue(false),
  MAX_PNG_BYTES: 12 * 1024 * 1024,
}));

const recordError = vi.hoisted(() => vi.fn());
const setFeedbackDialogOpen = vi.hoisted(() => vi.fn());
const setFeedbackAnalysis = vi.hoisted(() => vi.fn());
const setFeedbackAnalysisPending = vi.hoisted(() => vi.fn());

const storeState = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock('../../webview/store/editorStore', () => {
  const useEditorStore = (selector: (s: Record<string, unknown>) => unknown) => selector(storeState);
  useEditorStore.getState = () => storeState;
  return { useEditorStore };
});

import { FeedbackDialog } from '../../webview/components/FeedbackDialog/FeedbackDialog';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LONG_DESCRIPTION =
  'Renaming dim_task removes the foreign key edge from the canvas, and it does not come back after a reload.';

const diagnostics: FeedbackDiagnosticsView = {
  chips: [
    { label: 'ERD Studio 0.6.49', tone: 'normal' },
    { label: '2 recent errors', tone: 'error' },
  ],
  text: 'ERD Studio: 0.6.49',
};

function capabilities(overrides: Partial<FeedbackCapabilities> = {}): FeedbackCapabilities {
  return {
    extensionVersion: '0.6.49',
    aiAvailable: false,
    aiProviderLabel: null,
    aiNeedsPriming: false,
    githubHandle: null,
    canCaptureCanvas: true,
    ...overrides,
  };
}

function analysis(overrides: Partial<FeedbackAnalysis> = {}): FeedbackAnalysis {
  return {
    kind: 'bug',
    confidence: 0.9,
    title: 'FK edge disappears after a model rename',
    context: '',
    reasons: { desc: null, ctx: null, image: null },
    duplicates: [],
    ...overrides,
  };
}

const duplicate = (overrides: Record<string, unknown> = {}) => ({
  number: 42,
  title: 'FK edge disappears on rename',
  match: 0.92,
  why: 'Same symptom, same trigger.',
  state: 'open' as const,
  comments: 3,
  url: 'https://github.com/liam-machine/erd-studio/issues/42',
  ...overrides,
});

/** Reset the mocked store to a closed dialog with nothing pushed yet. */
function resetStore(overrides: Record<string, unknown> = {}): void {
  for (const key of Object.keys(storeState)) delete storeState[key];
  Object.assign(
    storeState,
    {
      feedbackDialogOpen: true,
      feedbackPrefill: null,
      setFeedbackDialogOpen,
      domain: {
        domain: 'showcase',
        layer: 'silver',
        stage: 'logical',
        models: [],
        relationships: [],
        schemaVersion: 5,
      },
      feedbackDiagnostics: diagnostics,
      feedbackCapabilities: capabilities(),
      feedbackAnalysis: null,
      feedbackAnalysisState: 'idle',
      feedbackError: null,
      setFeedbackAnalysis,
      setFeedbackAnalysisPending,
      recentErrors: ['2026-09-07T00:00:00.000Z [webview] boom'],
      recordError,
    },
    overrides,
  );
}

const q = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector(selector) as T | null;
const qq = (selector: string) => Array.from(document.querySelectorAll(selector));
const text = (selector: string) => q(selector)?.textContent ?? '';
const buttonWithText = (needle: string) =>
  qq('button').find((b) => (b.textContent ?? '').includes(needle)) as HTMLButtonElement | undefined;
/** The footer's primary button — the takeover has one of its own. */
const primaryButton = () =>
  q<HTMLButtonElement>('.feedback__footer .feedback__button--primary')!;
/** The takeover panel's own primary button. */
const takeoverPrimary = () =>
  q<HTMLButtonElement>('.feedback__takeover .feedback__button--primary')!;
const descriptionInput = () => q<HTMLTextAreaElement>('#feedback-description')!;
const titleInput = () => q<HTMLInputElement>('#feedback-title-input')!;
const contextInput = () => q<HTMLTextAreaElement>('#feedback-context')!;

/** The one `submitFeedback` payload posted so far. */
const submitted = () =>
  send.mock.calls.map((c) => c[0]).filter((m) => m.type === 'submitFeedback').at(-1)?.payload;

/**
 * The capture path looks for the canvas root before it asks for a shot, so a
 * test that ticks the checkbox has to put one in the document first. Removed
 * again in `afterEach`.
 */
function installCanvasRoot(): void {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
}

/**
 * Tick the canvas checkbox with a capture that succeeds. `onClipboard` is what
 * the browser said when the PNG was offered to the clipboard — the dialog's
 * copy turns on it, so it is never assumed.
 */
async function attachCanvas(onClipboard = false): Promise<void> {
  captureScreenshot.mockResolvedValueOnce({
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    onClipboard,
  });
  await act(async () => {
    fireEvent.click(q<HTMLInputElement>('.feedback__checkbox input')!);
  });
}

beforeEach(() => {
  send.mockClear();
  busListeners.length = 0;
  captureScreenshot.mockClear();
  copyImageToClipboard.mockClear();
  setFeedbackDialogOpen.mockClear();
  setFeedbackAnalysis.mockClear();
  setFeedbackAnalysisPending.mockClear();
  recordError.mockClear();
  resetStore();
});

afterEach(() => {
  vi.useRealTimers();
  // Only the canvas-capture test installs one; leaving it behind would let a
  // later test capture a screenshot it never asked for.
  document.getElementById('root')?.remove();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeedbackDialog visibility', () => {
  it('renders nothing at all while the dialog is closed', () => {
    resetStore({ feedbackDialogOpen: false });
    const { container } = render(<FeedbackDialog />);
    expect(container.innerHTML).toBe('');
    expect(send).not.toHaveBeenCalled();
  });

  it('is a modal dialog, so it works on the full-screen error page too', () => {
    render(<FeedbackDialog />);
    const dialog = q('.feedback')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('feedback-title');
    expect(q('.feedback__backdrop')).not.toBeNull();
  });

  it('asks the host for diagnostics and capabilities as it opens', () => {
    render(<FeedbackDialog />);
    expect(send).toHaveBeenCalledWith({
      type: 'requestFeedbackContext',
      payload: {
        webviewErrors: ['2026-09-07T00:00:00.000Z [webview] boom'],
        domain: {
          name: 'showcase',
          layer: 'silver',
          stage: 'logical',
          modelCount: 0,
          relationshipCount: 0,
          schemaVersion: 5,
        },
      },
    });
  });

  it('closes on Escape and on the backdrop', () => {
    render(<FeedbackDialog />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(setFeedbackDialogOpen).toHaveBeenCalledWith(false);

    setFeedbackDialogOpen.mockClear();
    fireEvent.click(q('.feedback__backdrop')!);
    expect(setFeedbackDialogOpen).toHaveBeenCalledWith(false);
  });
});

describe('per-kind copy', () => {
  it('stays neutral until the analysis has decided', () => {
    render(<FeedbackDialog />);
    expect(text('#feedback-title')).toBe(FEEDBACK_PRE_ANALYSIS_TITLE);
  });

  it('names the kind once an analysis has landed', () => {
    resetStore({
      feedbackAnalysis: analysis(),
      feedbackAnalysisState: 'ready',
      feedbackCapabilities: capabilities({ aiAvailable: true, aiProviderLabel: 'Copilot' }),
    });
    render(<FeedbackDialog />);
    expect(text('#feedback-title')).toBe(FEEDBACK_COPY.bug.head);
  });

  it('uses the bug labels and placeholder by default', () => {
    render(<FeedbackDialog />);
    expect(text('label[for="feedback-description"]')).toBe(FEEDBACK_COPY.bug.descLabel);
    expect(text('label[for="feedback-context"]')).toBe(FEEDBACK_COPY.bug.contextLabel);
    expect(contextInput().placeholder).toBe(FEEDBACK_COPY.bug.contextPlaceholder);
    expect(descriptionInput().placeholder).toBe(
      'Describe it however you like — the analysis sorts out the rest.',
    );
  });

  it('swaps every label when the dialog opens as a feature request', () => {
    resetStore({ feedbackPrefill: { kind: 'feature' } });
    render(<FeedbackDialog />);
    expect(text('label[for="feedback-description"]')).toBe(FEEDBACK_COPY.feature.descLabel);
    expect(text('label[for="feedback-context"]')).toBe(FEEDBACK_COPY.feature.contextLabel);
    expect(contextInput().placeholder).toBe(FEEDBACK_COPY.feature.contextPlaceholder);
  });

  it('offers the canvas screenshot for a bug, naming the canvas it would capture', () => {
    render(<FeedbackDialog />);
    expect(text('.feedback__checkbox')).toContain('Attach a screenshot of the canvas');
    expect(text('.feedback__checkbox')).toContain('(silver/showcase, logical)');
  });

  it('does not offer a canvas screenshot on a feature request', () => {
    resetStore({ feedbackPrefill: { kind: 'feature' } });
    render(<FeedbackDialog />);
    expect(qq('.feedback__checkbox')).toHaveLength(0);
  });

  it('hides the canvas checkbox when there is no canvas to capture', () => {
    resetStore({ feedbackCapabilities: capabilities({ canCaptureCanvas: false }) });
    render(<FeedbackDialog />);
    expect(qq('.feedback__checkbox')).toHaveLength(0);
  });
});

describe('the prefill', () => {
  /**
   * The canvas error screen opens the dialog with the host's raw exception,
   * which names absolute domain file paths and dbt model names. It is the one
   * description in the dialog nobody typed, and the only path by which text a
   * user never wrote — and may not have read — could reach a model.
   */
  const CANVAS_ERROR =
    'Error shown on canvas: Invalid JSON in domain file ' +
    '/Users/liam/work/acme-private/.erd-studio/silver/customer-360.json: Unexpected token }';

  const analyses = () =>
    send.mock.calls.map((c) => c[0]).filter((m) => m.type === 'analyzeFeedback');

  it('seeds the kind and both text fields', () => {
    resetStore({
      feedbackPrefill: { kind: 'bug', title: 'From palette', description: 'Error shown on canvas' },
    });
    render(<FeedbackDialog />);
    expect(titleInput().value).toBe('From palette');
    expect(descriptionInput().value).toBe('Error shown on canvas');
  });

  it('never sends a prefilled description on the debounce, even on a primed machine', () => {
    vi.useFakeTimers();
    resetStore({
      feedbackCapabilities: capabilities({
        aiAvailable: true,
        aiProviderLabel: 'Copilot',
        aiNeedsPriming: false,
      }),
      feedbackPrefill: { kind: 'bug', description: CANVAS_ERROR },
    });
    render(<FeedbackDialog />);

    act(() => {
      vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS + 50);
    });

    expect(analyses()).toHaveLength(0);
    // Not silently dead either: the send is offered as a deliberate click.
    expect(text('.feedback__primer')).toContain('Analyse this for me');
    expect(text('.feedback__primer-note')).toBe(
      'This text was filled in for you — nothing is sent until you ask.',
    );
  });

  it('resumes the debounce the moment the user makes the description theirs', () => {
    vi.useFakeTimers();
    resetStore({
      feedbackCapabilities: capabilities({
        aiAvailable: true,
        aiProviderLabel: 'Copilot',
        aiNeedsPriming: false,
      }),
      feedbackPrefill: { kind: 'bug', description: CANVAS_ERROR },
    });
    render(<FeedbackDialog />);

    act(() => {
      fireEvent.change(descriptionInput(), { target: { value: `${CANVAS_ERROR}.` } });
    });
    act(() => {
      vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS + 50);
    });

    expect(analyses()).toHaveLength(1);
    expect(analyses()[0].payload.description).toBe(`${CANVAS_ERROR}.`);
    expect(q('.feedback__primer')).toBeNull();
  });

  it('sends it only when the user asks for it by hand', () => {
    resetStore({
      feedbackCapabilities: capabilities({
        aiAvailable: true,
        aiProviderLabel: 'Copilot',
        aiNeedsPriming: false,
      }),
      feedbackPrefill: { kind: 'bug', description: CANVAS_ERROR },
    });
    render(<FeedbackDialog />);

    act(() => {
      fireEvent.click(buttonWithText('Analyse this for me')!);
    });

    expect(analyses()).toHaveLength(1);
    expect(analyses()[0].payload).toMatchObject({ description: CANVAS_ERROR, trigger: 'user' });
  });

  it('leaves the ordinary debounce alone when nothing was prefilled', () => {
    vi.useFakeTimers();
    resetStore({
      feedbackCapabilities: capabilities({
        aiAvailable: true,
        aiProviderLabel: 'Copilot',
        aiNeedsPriming: false,
      }),
    });
    render(<FeedbackDialog />);

    act(() => {
      fireEvent.change(descriptionInput(), { target: { value: LONG_DESCRIPTION } });
    });
    act(() => {
      vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS + 50);
    });

    expect(analyses()).toHaveLength(1);
  });
});

describe('the analysis panel', () => {
  it('is absent entirely when no model is configured', () => {
    render(<FeedbackDialog />);
    expect(q('.feedback__ai')).toBeNull();
  });

  it('shows its idle prose, then the provider name, once a model is available', () => {
    resetStore({
      feedbackCapabilities: capabilities({ aiAvailable: true, aiProviderLabel: 'api.example.com' }),
    });
    render(<FeedbackDialog />);
    expect(text('.feedback__ai-head')).toContain('api.example.com');
    expect(text('.feedback__idle')).toContain('Describe the problem above');
  });

  it('shows the thinking state while a request is in flight', () => {
    resetStore({
      feedbackCapabilities: capabilities({ aiAvailable: true, aiProviderLabel: 'Copilot' }),
      feedbackAnalysisState: 'thinking',
    });
    render(<FeedbackDialog />);
    expect(text('.feedback__thinking')).toContain('Reading your description and the open issues…');
  });

  it('shows a failure sentence rather than pretending nothing happened', () => {
    resetStore({
      feedbackCapabilities: capabilities({ aiAvailable: true, aiProviderLabel: 'Copilot' }),
      feedbackAnalysisState: 'error',
      feedbackError: 'The analysis could not be completed.',
    });
    render(<FeedbackDialog />);
    expect(text('.feedback__error')).toBe('The analysis could not be completed.');
  });

  it('offers to flip the kind, and flipping it swaps the copy', () => {
    resetStore({
      feedbackCapabilities: capabilities({ aiAvailable: true, aiProviderLabel: 'Copilot' }),
      feedbackAnalysis: analysis(),
      feedbackAnalysisState: 'ready',
    });
    render(<FeedbackDialog />);

    const flip = buttonWithText('Not right? Make it a feature')!;
    expect(flip).toBeTruthy();
    act(() => {
      fireEvent.click(flip);
    });
    expect(text('label[for="feedback-description"]')).toBe(FEEDBACK_COPY.feature.descLabel);
  });

  it('never shows two flip links at once', () => {
    resetStore({
      feedbackCapabilities: capabilities({ aiAvailable: true, aiProviderLabel: 'Copilot' }),
      feedbackAnalysis: analysis(),
      feedbackAnalysisState: 'ready',
    });
    render(<FeedbackDialog />);
    expect(qq('button').filter((b) => (b.textContent ?? '').startsWith('Not right?'))).toHaveLength(1);
  });
});

/**
 * The first run on a machine has to be asked for.
 *
 * Tier 1 is the user's own model, and VS Code raises its access dialog on the
 * back of the request — the API guidance is that this follows a user-initiated
 * action rather than appearing while someone types. So the panel offers one
 * button, and only after a request has come back does the debounce take over.
 */
describe('the first-run primer', () => {
  const primed = (overrides: Partial<FeedbackCapabilities> = {}) =>
    capabilities({ aiAvailable: true, aiProviderLabel: 'Copilot', ...overrides });

  const analyses = () =>
    send.mock.calls.map((c) => c[0]).filter((m) => m.type === 'analyzeFeedback');

  it('offers a button instead of running on the debounce', () => {
    vi.useFakeTimers();
    resetStore({ feedbackCapabilities: primed({ aiNeedsPriming: true }) });
    render(<FeedbackDialog />);

    expect(text('.feedback__primer')).toContain('Analyse this for me');
    expect(text('.feedback__primer-note')).toBe('Uses your own model. VS Code will ask once.');
    // The idle prose gives way to the button rather than sitting beside it.
    expect(q('.feedback__idle')).toBeNull();

    act(() => {
      fireEvent.change(descriptionInput(), { target: { value: LONG_DESCRIPTION } });
    });
    act(() => {
      vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS + 10);
    });
    expect(analyses()).toHaveLength(0);
  });

  it('runs nothing until there is enough to analyse', () => {
    resetStore({ feedbackCapabilities: primed({ aiNeedsPriming: true }) });
    render(<FeedbackDialog />);

    expect(buttonWithText('Analyse this for me')!.hasAttribute('disabled')).toBe(true);
    act(() => {
      fireEvent.change(descriptionInput(), { target: { value: LONG_DESCRIPTION } });
    });
    expect(buttonWithText('Analyse this for me')!.hasAttribute('disabled')).toBe(false);
  });

  it('asks explicitly when the button is pressed', () => {
    resetStore({ feedbackCapabilities: primed({ aiNeedsPriming: true }) });
    render(<FeedbackDialog />);

    act(() => {
      fireEvent.change(descriptionInput(), { target: { value: LONG_DESCRIPTION } });
    });
    act(() => {
      fireEvent.click(buttonWithText('Analyse this for me')!);
    });

    expect(analyses()).toHaveLength(1);
    // `trigger: 'user'` is what lets the host raise VS Code's dialog at all.
    expect(analyses()[0].payload).toMatchObject({
      kind: 'bug',
      description: LONG_DESCRIPTION,
      trigger: 'user',
    });
    expect(setFeedbackAnalysisPending).toHaveBeenCalled();
  });

  it('hands over to the debounce once a reply has landed', () => {
    vi.useFakeTimers();
    resetStore({ feedbackCapabilities: primed({ aiNeedsPriming: true }) });
    render(<FeedbackDialog />);

    act(() => {
      fireEvent.change(descriptionInput(), { target: { value: LONG_DESCRIPTION } });
    });
    act(() => {
      fireEvent.click(buttonWithText('Analyse this for me')!);
    });
    act(() => {
      for (const listener of busListeners) {
        listener({
          type: 'feedbackAnalysis',
          payload: { requestId: analyses()[0].payload.requestId, analysis: analysis() },
        });
      }
    });

    expect(buttonWithText('Analyse this for me')).toBeUndefined();

    act(() => {
      fireEvent.change(descriptionInput(), { target: { value: `${LONG_DESCRIPTION} Again.` } });
    });
    act(() => {
      vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS + 10);
    });

    expect(analyses()).toHaveLength(2);
    expect(analyses()[1].payload.trigger).toBe('debounce');
  });

  it('does not repeat the primer\'s own request when the debounce takes over', () => {
    // Handing over re-runs the debounce effect with an unchanged description.
    // Without a guard that is a second, identical model request for one button
    // press — and the verdict the user just asked for drops back to a spinner.
    vi.useFakeTimers();
    resetStore({ feedbackCapabilities: primed({ aiNeedsPriming: true }) });
    render(<FeedbackDialog />);

    act(() => {
      fireEvent.change(descriptionInput(), { target: { value: LONG_DESCRIPTION } });
    });
    act(() => {
      fireEvent.click(buttonWithText('Analyse this for me')!);
    });
    act(() => {
      for (const listener of busListeners) {
        listener({
          type: 'feedbackAnalysis',
          payload: { requestId: analyses()[0].payload.requestId, analysis: analysis() },
        });
      }
    });
    setFeedbackAnalysisPending.mockClear();

    act(() => {
      vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS + 50);
    });

    expect(analyses()).toHaveLength(1);
    // The panel is left showing the answer rather than reverting to "thinking".
    expect(setFeedbackAnalysisPending).not.toHaveBeenCalled();
  });

  it('still re-analyses an edit that lands back on the same text', () => {
    // The guard is "same text AND same request id". An A -> B -> A edit has a
    // moved id (the effect cleanup bumps it on every change), so it runs again.
    vi.useFakeTimers();
    resetStore({ feedbackCapabilities: primed({ aiNeedsPriming: false }) });
    render(<FeedbackDialog />);

    act(() => {
      fireEvent.change(descriptionInput(), { target: { value: LONG_DESCRIPTION } });
    });
    act(() => {
      vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS + 50);
    });
    act(() => {
      fireEvent.change(descriptionInput(), { target: { value: `${LONG_DESCRIPTION} extra` } });
    });
    act(() => {
      fireEvent.change(descriptionInput(), { target: { value: LONG_DESCRIPTION } });
    });
    act(() => {
      vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS + 50);
    });

    expect(analyses()).toHaveLength(2);
    expect(analyses()[1].payload.description).toBe(LONG_DESCRIPTION);
  });

  it('brings the button back when the request failed — a dismissed dialog is not a yes', () => {
    resetStore({ feedbackCapabilities: primed({ aiNeedsPriming: true }) });
    render(<FeedbackDialog />);

    act(() => {
      fireEvent.change(descriptionInput(), { target: { value: LONG_DESCRIPTION } });
    });
    act(() => {
      fireEvent.click(buttonWithText('Analyse this for me')!);
    });
    act(() => {
      for (const listener of busListeners) {
        listener({
          type: 'feedbackAnalysis',
          payload: {
            requestId: analyses()[0].payload.requestId,
            analysis: null,
            error: 'The analysis could not be completed.',
          },
        });
      }
    });

    expect(buttonWithText('Analyse this for me')).toBeTruthy();
  });

  it('never shows the primer for a tier that asks its own consent question', () => {
    vi.useFakeTimers();
    resetStore({
      feedbackCapabilities: capabilities({
        aiAvailable: true,
        aiProviderLabel: 'api.example.com',
        aiNeedsPriming: false,
      }),
    });
    render(<FeedbackDialog />);

    expect(q('.feedback__primer')).toBeNull();
    act(() => {
      fireEvent.change(descriptionInput(), { target: { value: LONG_DESCRIPTION } });
    });
    act(() => {
      vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS + 10);
    });
    expect(analyses()).toHaveLength(1);
    expect(analyses()[0].payload.trigger).toBe('debounce');
  });
});

/**
 * The kind switch is core plumbing, not an AI feature. `feedback.aiAssist` is
 * off by default, so if the only flip link lived in the analysis panel there
 * would be no route from a canvas to the feature-request template at all.
 */
describe('choosing the kind without an analysis', () => {
  it('offers the flip with no model configured, and files against the feature template', async () => {
    render(<FeedbackDialog />);
    expect(q('.feedback__ai')).toBeNull();

    act(() => {
      fireEvent.click(buttonWithText('Not right? Make it a feature')!);
    });

    expect(text('label[for="feedback-description"]')).toBe(FEEDBACK_COPY.feature.descLabel);
    expect(text('label[for="feedback-context"]')).toBe(FEEDBACK_COPY.feature.contextLabel);

    fireEvent.change(descriptionInput(), { target: { value: 'Let me export the canvas as SVG.' } });
    await act(async () => {
      fireEvent.click(primaryButton());
    });

    await waitFor(() => expect(submitted()).toBeTruthy());
    expect(submitted().kind).toBe('feature');
  });

  it('flips back again', () => {
    render(<FeedbackDialog />);
    act(() => {
      fireEvent.click(buttonWithText('Not right? Make it a feature')!);
    });
    act(() => {
      fireEvent.click(buttonWithText('Not right? Make it a bug')!);
    });
    expect(text('label[for="feedback-description"]')).toBe(FEEDBACK_COPY.bug.descLabel);
  });

  it('takes the canvas screenshot with it — a feature request cannot untick one', async () => {
    // The checkbox is bug-only, so an image left attached after the flip could
    // neither be seen nor removed.
    installCanvasRoot();
    render(<FeedbackDialog />);
    fireEvent.change(descriptionInput(), { target: { value: 'Something happened.' } });

    await attachCanvas();
    await waitFor(() => expect(q('.feedback__attached')).not.toBeNull());

    act(() => {
      fireEvent.click(buttonWithText('Not right? Make it a feature')!);
    });

    expect(q('.feedback__attached')).toBeNull();
    expect(qq('.feedback__checkbox')).toHaveLength(0);

    await act(async () => {
      fireEvent.click(primaryButton());
    });
    await waitFor(() => expect(submitted()).toBeTruthy());
    expect(submitted().attachments).toBeUndefined();
  });
});

describe('the readiness meter', () => {
  function renderReady() {
    resetStore({
      feedbackPrefill: { kind: 'bug', description: LONG_DESCRIPTION },
      feedbackCapabilities: capabilities({ aiAvailable: true, aiProviderLabel: 'Copilot' }),
      feedbackAnalysis: analysis(),
      feedbackAnalysisState: 'ready',
    });
    return render(<FeedbackDialog />);
  }

  it('scores what is in the dialog right now', () => {
    renderReady();
    // Clear description (40) + diagnostics (10); no steps, no image.
    expect(text('.feedback__meter-row')).toContain('50%');
    expect(text('.feedback__meter-row')).toContain('Ready to file');
  });

  it('moves the moment the screenshot is attached — no round trip', async () => {
    installCanvasRoot();
    renderReady();

    await attachCanvas();

    await waitFor(() => expect(text('.feedback__meter-row')).toContain('70%'));
    expect(qq('.feedback__check').some((c) => (c.textContent ?? '').includes('Screenshot attached'))).toBe(
      true,
    );
    // Nothing was asked of the host to move the bar.
    expect(send.mock.calls.map((c) => c[0].type)).not.toContain('analyzeFeedback');
  });

  it('captures the canvas itself when the unmet image check is acted on', async () => {
    // "Attach one" has exactly one thing to attach, so it attaches it rather
    // than pointing the user at a control.
    installCanvasRoot();
    renderReady();
    captureScreenshot.mockResolvedValueOnce({
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      onClipboard: true,
    });

    await act(async () => {
      fireEvent.click(buttonWithText('Attach one')!);
    });

    await waitFor(() => expect(q('.feedback__attached')).not.toBeNull());
    expect(q<HTMLInputElement>('.feedback__checkbox input')!.checked).toBe(true);
  });

  it('asks a feature request for no image, since it has no way to attach one', () => {
    // The canvas capture is bug-only, so an image check here would be a row
    // that can never be met above a button with nothing to do.
    resetStore({
      feedbackPrefill: { kind: 'feature', description: LONG_DESCRIPTION },
      feedbackCapabilities: capabilities({ aiAvailable: true, aiProviderLabel: 'Copilot' }),
      feedbackAnalysis: analysis({ kind: 'feature' }),
      feedbackAnalysisState: 'ready',
    });
    render(<FeedbackDialog />);

    expect(qq('.feedback__check').some((c) => (c.textContent ?? '').includes('No image'))).toBe(
      false,
    );
    expect(buttonWithText('Attach one')).toBeUndefined();
    // Clear description (40) + diagnostics (10) out of the 80 that apply.
    expect(text('.feedback__meter-row')).toContain('63%');
  });

  it('drops the image check when a bug has no canvas behind the dialog', () => {
    resetStore({
      feedbackPrefill: { kind: 'bug', description: LONG_DESCRIPTION },
      feedbackCapabilities: capabilities({
        aiAvailable: true,
        aiProviderLabel: 'Copilot',
        canCaptureCanvas: false,
      }),
      feedbackAnalysis: analysis(),
      feedbackAnalysisState: 'ready',
    });
    render(<FeedbackDialog />);

    expect(buttonWithText('Attach one')).toBeUndefined();
  });

  it('moves again when the user takes the diagnostics off the report', () => {
    renderReady();
    act(() => {
      fireEvent.click(buttonWithText('remove')!);
    });
    expect(text('.feedback__meter-row')).toContain('40%');
    expect(text('.feedback__diagnostics-toggle')).toBe('put back');
  });

  it('says why a check is unmet and offers a way to fix it', () => {
    renderReady();
    const checks = qq('.feedback__check').map((c) => c.textContent ?? '');
    expect(checks.some((c) => c.includes('Clear description'))).toBe(true);
    expect(checks.some((c) => c.includes('No steps to reproduce'))).toBe(true);
    expect(buttonWithText('Add them')).toBeTruthy();
  });
});

describe('the suggested title (A7)', () => {
  it('marks a title the analysis drafted, and gives the user theirs back', () => {
    resetStore({
      feedbackPrefill: { kind: 'bug', description: LONG_DESCRIPTION },
      feedbackCapabilities: capabilities({ aiAvailable: true, aiProviderLabel: 'Copilot' }),
      feedbackAnalysis: analysis(),
      feedbackAnalysisState: 'ready',
    });
    render(<FeedbackDialog />);

    expect(titleInput().value).toBe('FK edge disappears after a model rename');
    expect(text('.feedback__suggested')).toContain('· suggested');

    act(() => {
      fireEvent.click(buttonWithText('use mine')!);
    });
    // The user typed nothing, so "mine" is empty — and the marker is gone.
    expect(titleInput().value).toBe('');
    expect(q('.feedback__suggested')).toBeNull();
  });

  it('never overwrites a title the user typed', () => {
    resetStore({
      feedbackPrefill: { kind: 'bug', title: 'My own words', description: LONG_DESCRIPTION },
      feedbackCapabilities: capabilities({ aiAvailable: true, aiProviderLabel: 'Copilot' }),
      feedbackAnalysis: analysis(),
      feedbackAnalysisState: 'ready',
    });
    render(<FeedbackDialog />);

    expect(titleInput().value).toBe('My own words');
    expect(q('.feedback__suggested')).toBeNull();
  });
});

describe('the duplicate takeover', () => {
  function renderTakeover(candidate: Record<string, unknown> = {}) {
    resetStore({
      feedbackPrefill: { kind: 'bug', description: LONG_DESCRIPTION },
      feedbackCapabilities: capabilities({ aiAvailable: true, aiProviderLabel: 'Copilot' }),
      feedbackAnalysis: analysis({ duplicates: [duplicate(candidate) as never] }),
      feedbackAnalysisState: 'ready',
    });
    return render(<FeedbackDialog />);
  }

  it('collapses the new-issue form behind a confident duplicate', () => {
    renderTakeover();
    expect(text('.feedback__takeover-head')).toContain('Someone has already reported this');
    expect(q('.feedback__rest')!.className).toContain('feedback__rest--collapsed');
    expect(primaryButton().textContent).toBe('Add to #42');
    expect(takeoverPrimary().textContent).toBe('Add my details to #42');
  });

  it('leaves the form alone for a merely related issue', () => {
    renderTakeover({ match: 0.45 });
    expect(q('.feedback__takeover')).toBeNull();
    expect(q('.feedback__rest')!.className).not.toContain('feedback__rest--collapsed');
    expect(text('.feedback__dupes-head')).toContain('Possibly related — worth a glance');
  });

  it('carries the description over as a comment rather than filing anything new', async () => {
    renderTakeover();
    await act(async () => {
      fireEvent.click(primaryButton());
    });
    await waitFor(() => expect(submitted()).toBeTruthy());
    expect(submitted().commentOnIssue).toBe(42);
  });

  it('offers a way out, which re-expands the form', () => {
    renderTakeover();
    act(() => {
      fireEvent.click(buttonWithText('File it as a new issue anyway')!);
    });
    expect(q('.feedback__rest')!.className).not.toContain('feedback__rest--collapsed');
    expect(primaryButton().textContent).toBe('Open GitHub issue');
  });

  it('sends an outdated user to the update instead of to a new issue', () => {
    renderTakeover({ state: 'closed', stateReason: 'completed', fixedIn: '0.7.0' });
    expect(text('.feedback__takeover-head')).toContain("This is already fixed — you're on an older version");
    expect(primaryButton().textContent).toBe('Update ERD Studio');

    act(() => {
      fireEvent.click(takeoverPrimary());
    });
    expect(send).toHaveBeenCalledWith({
      type: 'openFeedbackLink',
      payload: { target: 'extension' },
    });
  });

  it('does not call an outdated user\'s report a regression', async () => {
    // "It still happens on <my version>" is the one fixed-mode route taken by
    // somebody who has never had the fix — the opposite of a regression.
    renderTakeover({ state: 'closed', stateReason: 'completed', fixedIn: '0.7.0' });

    act(() => {
      fireEvent.click(buttonWithText('It still happens on 0.6.49')!);
    });
    expect(titleInput().value).not.toContain('Regression: ');

    await act(async () => {
      fireEvent.click(primaryButton());
    });
    await waitFor(() => expect(submitted()).toBeTruthy());
    expect(submitted().regressionOf).toBeUndefined();
    expect(submitted().title).not.toContain('Regression: ');
  });

  it('does call it a regression when the user demonstrably has the fix', async () => {
    renderTakeover({ state: 'closed', stateReason: 'completed', fixedIn: '0.6.40' });
    expect(text('.feedback__takeover-body')).toContain('already on a version that has the fix');

    act(() => {
      fireEvent.click(takeoverPrimary());
    });
    await act(async () => {
      fireEvent.click(primaryButton());
    });

    await waitFor(() => expect(submitted()).toBeTruthy());
    expect(submitted().regressionOf).toBe(42);
    expect(submitted().title.startsWith('Regression: ')).toBe(true);
  });

  it('claims nothing when GitHub never recorded which release carried the fix', async () => {
    // No milestone and no `shipped-in:` label is the ordinary case, and it is
    // not evidence that the user already has the fix.
    renderTakeover({ state: 'closed', stateReason: 'completed' });

    expect(text('.feedback__takeover-head')).toContain('This was fixed once already');
    expect(text('.feedback__takeover-body')).not.toContain('already on a version that has the fix');
    expect(text('.feedback__takeover-body')).toContain("isn't recorded");
    expect(text('.feedback__takeover-meta')).toBe('fix version not recorded');
    expect(primaryButton().textContent).toBe('File it anyway');
    expect(text('.feedback__route')).toContain('Closed as fixed.');
    expect(buttonWithText('Report it as a regression')).toBeUndefined();

    act(() => {
      fireEvent.click(takeoverPrimary());
    });
    await act(async () => {
      fireEvent.click(primaryButton());
    });

    await waitFor(() => expect(submitted()).toBeTruthy());
    expect(submitted().regressionOf).toBeUndefined();
    expect(submitted().title).not.toContain('Regression: ');
  });

  it('takes the "Regression: " back off when the user changes their mind', () => {
    renderTakeover({ state: 'closed', stateReason: 'completed', fixedIn: '0.6.40' });
    act(() => {
      fireEvent.click(buttonWithText('Report it as a regression')!);
    });
    expect(titleInput().value.startsWith('Regression: ')).toBe(true);

    act(() => {
      fireEvent.click(buttonWithText('Hide the new-issue form')!);
    });
    expect(titleInput().value.startsWith('Regression: ')).toBe(false);
  });

  it('drops a regression claim once the duplicate it was about is gone', async () => {
    renderTakeover({ state: 'closed', stateReason: 'completed', fixedIn: '0.6.40' });
    act(() => {
      fireEvent.click(buttonWithText('Report it as a regression')!);
    });
    expect(titleInput().value.startsWith('Regression: ')).toBe(true);

    // The user rewrites the description; the re-run finds nothing similar.
    act(() => {
      for (const listener of busListeners) {
        listener({
          type: 'feedbackAnalysis',
          payload: { requestId: 0, analysis: analysis({ duplicates: [] }) },
        });
      }
    });
    resetStore({
      feedbackPrefill: { kind: 'bug', description: LONG_DESCRIPTION },
      feedbackCapabilities: capabilities({ aiAvailable: true, aiProviderLabel: 'Copilot' }),
      feedbackAnalysis: analysis({ duplicates: [] }),
      feedbackAnalysisState: 'ready',
    });
    act(() => {
      fireEvent.change(descriptionInput(), { target: { value: 'A completely different problem.' } });
    });

    expect(q('.feedback__takeover')).toBeNull();
    expect(titleInput().value.startsWith('Regression: ')).toBe(false);

    await act(async () => {
      fireEvent.click(primaryButton());
    });
    await waitFor(() => expect(submitted()).toBeTruthy());
    expect(submitted().regressionOf).toBeUndefined();
  });

  it('opens a declined thread rather than filing a second issue', () => {
    renderTakeover({ state: 'closed', stateReason: 'not_planned' });
    expect(primaryButton().textContent).toBe('Open #42');
    expect(takeoverPrimary().textContent).toBe('Read the discussion on #42');

    act(() => {
      fireEvent.click(takeoverPrimary());
    });
    expect(send).toHaveBeenCalledWith({
      type: 'openFeedbackLink',
      payload: { target: 'issue', issue: 42 },
    });
  });
});

describe('submitting', () => {
  it('posts the trimmed fields, the kind and the domain summary', async () => {
    render(<FeedbackDialog />);
    fireEvent.change(descriptionInput(), { target: { value: '  It vanished.  ' } });
    fireEvent.change(titleInput(), { target: { value: '  Edge vanished  ' } });
    fireEvent.change(contextInput(), { target: { value: '  1. Rename it  ' } });

    await act(async () => {
      fireEvent.click(primaryButton());
    });

    await waitFor(() => expect(submitted()).toBeTruthy());
    expect(submitted()).toMatchObject({
      kind: 'bug',
      title: 'Edge vanished',
      description: 'It vanished.',
      steps: '1. Rename it',
      includeDiagnostics: true,
      domain: { name: 'showcase', layer: 'silver', modelCount: 0 },
    });
    expect(submitted().attachments).toBeUndefined();
  });

  it('refuses to send an entirely empty report', () => {
    render(<FeedbackDialog />);
    expect(primaryButton().hasAttribute('disabled')).toBe(true);

    fireEvent.change(descriptionInput(), { target: { value: 'Something happened.' } });
    expect(primaryButton().hasAttribute('disabled')).toBe(false);
  });

  it('re-copies the screenshot on the way out and stamps the result on it', async () => {
    // The capture may have been minutes ago, and the host branches both the
    // issue body and its notification on this flag.
    installCanvasRoot();
    copyImageToClipboard.mockResolvedValueOnce(true);
    render(<FeedbackDialog />);
    fireEvent.change(descriptionInput(), { target: { value: LONG_DESCRIPTION } });

    await attachCanvas(false);
    await waitFor(() => expect(q('.feedback__attached')).not.toBeNull());

    await act(async () => {
      fireEvent.click(primaryButton());
    });

    await waitFor(() => expect(submitted()?.attachments).toHaveLength(1));
    expect(submitted().attachments[0]).toMatchObject({
      name: 'canvas.png',
      source: 'canvas',
      onClipboard: true,
    });
    expect(copyImageToClipboard).toHaveBeenCalledWith(expect.anything(), 'image/png');
  });

  it('reports a failure inside the dialog and re-enables the button', async () => {
    render(<FeedbackDialog />);
    fireEvent.change(descriptionInput(), { target: { value: 'Something happened.' } });
    await act(async () => {
      fireEvent.click(primaryButton());
    });
    await waitFor(() => expect(primaryButton().hasAttribute('disabled')).toBe(true));

    act(() => {
      for (const listener of busListeners) {
        listener({ type: 'feedbackSubmitted', payload: { ok: false, error: 'Could not open the browser.' } });
      }
    });

    expect(text('.feedback__status--error')).toBe('Could not open the browser.');
    expect(primaryButton().hasAttribute('disabled')).toBe(false);
    expect(setFeedbackDialogOpen).not.toHaveBeenCalledWith(false);
  });

  it('closes itself once the host confirms', async () => {
    render(<FeedbackDialog />);
    fireEvent.change(descriptionInput(), { target: { value: 'Something happened.' } });
    await act(async () => {
      fireEvent.click(primaryButton());
    });

    act(() => {
      for (const listener of busListeners) {
        listener({ type: 'feedbackSubmitted', payload: { ok: true } });
      }
    });

    expect(setFeedbackDialogOpen).toHaveBeenCalledWith(false);
  });

  it('drops an analysis reply for a request the dialog has moved on from', () => {
    resetStore({ feedbackCapabilities: capabilities({ aiAvailable: true }) });
    render(<FeedbackDialog />);

    act(() => {
      for (const listener of busListeners) {
        listener({ type: 'feedbackAnalysis', payload: { requestId: 99, analysis: analysis() } });
      }
    });

    expect(setFeedbackAnalysis).not.toHaveBeenCalled();
  });

  it('drops a reply that lands after the description was cut back below the minimum', () => {
    // The panel has already reset to idle by then; letting the reply through
    // would put a verdict — or a whole duplicate takeover — over text the user
    // has just erased.
    vi.useFakeTimers();
    resetStore({ feedbackCapabilities: capabilities({ aiAvailable: true }) });
    render(<FeedbackDialog />);

    act(() => {
      fireEvent.change(descriptionInput(), { target: { value: LONG_DESCRIPTION } });
    });
    act(() => {
      vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS + 10);
    });
    const asked = send.mock.calls.map((c) => c[0]).filter((m) => m.type === 'analyzeFeedback');
    expect(asked).toHaveLength(1);

    act(() => {
      fireEvent.change(descriptionInput(), { target: { value: 'oops' } });
    });
    act(() => {
      for (const listener of busListeners) {
        listener({
          type: 'feedbackAnalysis',
          payload: { requestId: asked[0].payload.requestId, analysis: analysis() },
        });
      }
    });

    // The only permitted call is the reset to idle the shrink itself caused.
    expect(setFeedbackAnalysis.mock.calls.every((call) => call[0] === null)).toBe(true);
  });
});

describe('Copy report', () => {
  it('posts the same report for the clipboard, naming the attachments', () => {
    render(<FeedbackDialog />);
    fireEvent.change(descriptionInput(), { target: { value: 'It vanished.' } });

    act(() => {
      fireEvent.click(buttonWithText('Copy report')!);
    });

    const copied = send.mock.calls.map((c) => c[0]).find((m) => m.type === 'copyFeedbackReport');
    expect(copied.payload).toMatchObject({
      kind: 'bug',
      description: 'It vanished.',
      includeDiagnostics: true,
      attachmentNames: [],
    });
  });
});

describe('diagnostics', () => {
  it('shows the host\'s chips and the exact text, never a reconstruction', () => {
    render(<FeedbackDialog />);
    expect(qq('.feedback__chip').map((c) => c.textContent)).toEqual([
      'ERD Studio 0.6.49',
      '2 recent errors',
    ]);
    expect(qq('.feedback__chip--error').map((c) => c.textContent)).toEqual(['2 recent errors']);
    expect(text('.feedback__pre')).toBe('ERD Studio: 0.6.49');
    expect(text('.feedback__details summary')).toBe('See the exact text');
  });

  it('renders nothing until the host has pushed a view', () => {
    resetStore({ feedbackDiagnostics: null });
    render(<FeedbackDialog />);
    expect(q('.feedback__diagnostics')).toBeNull();
  });
});

describe('images', () => {
  it('offers no route of its own for other images, and says where they go', () => {
    // GitHub has no API for attaching an image to a prefilled form, so a picker
    // here could only hand the user the same job back.
    render(<FeedbackDialog />);
    expect(q('input[type="file"]')).toBeNull();
    expect(text('.feedback__note')).toBe(
      'Any other images are added on the GitHub page: click the Screenshot box there and paste or drag them in.',
    );
  });

  it('says the screenshot is on the clipboard once it actually is', async () => {
    installCanvasRoot();
    render(<FeedbackDialog />);

    await attachCanvas(true);

    await waitFor(() =>
      expect(text('.feedback__attached')).toBe(
        'Copied to your clipboard — paste it into the Screenshot box on GitHub.',
      ),
    );
  });

  it('points at the saved file instead when the clipboard refused it', async () => {
    // Claiming a copy that did not happen would send the user to paste nothing.
    installCanvasRoot();
    render(<FeedbackDialog />);

    await attachCanvas(false);

    await waitFor(() =>
      expect(text('.feedback__attached')).toBe(
        'Attached. Your clipboard refused it, so it is saved to a file the notification can reveal.',
      ),
    );
  });

  it('unticking the box takes the screenshot off the report', async () => {
    installCanvasRoot();
    render(<FeedbackDialog />);
    fireEvent.change(descriptionInput(), { target: { value: 'Something happened.' } });

    await attachCanvas(true);
    await waitFor(() => expect(q('.feedback__attached')).not.toBeNull());

    await act(async () => {
      fireEvent.click(q<HTMLInputElement>('.feedback__checkbox input')!);
    });
    expect(q('.feedback__attached')).toBeNull();

    await act(async () => {
      fireEvent.click(primaryButton());
    });
    await waitFor(() => expect(submitted()).toBeTruthy());
    expect(submitted().attachments).toBeUndefined();
  });

  it('unticks itself and explains when the capture fails, rather than promising an image', async () => {
    installCanvasRoot();
    render(<FeedbackDialog />);

    // The default mock resolves with no dataUrl and an error.
    await act(async () => {
      fireEvent.click(q<HTMLInputElement>('.feedback__checkbox input')!);
    });

    await waitFor(() => expect(text('.feedback__status')).toBe('no canvas in jsdom'));
    expect(q<HTMLInputElement>('.feedback__checkbox input')!.checked).toBe(false);
    expect(q('.feedback__attached')).toBeNull();
    expect(recordError).toHaveBeenCalledWith('screenshot', 'no canvas in jsdom');
  });
});

describe('the footer', () => {
  it('explains the plain route, and the clipboard hand-off once the screenshot is on', async () => {
    installCanvasRoot();
    render(<FeedbackDialog />);
    expect(text('.feedback__route')).toContain('Opens the prefilled form.');
    expect(text('.feedback__route')).toContain('nothing is sent from VS Code');

    await attachCanvas(true);

    await waitFor(() =>
      expect(text('.feedback__route')).toContain('paste it into the Screenshot box'),
    );
  });

  it('labels the signed-in account without ever offering to sign in', () => {
    resetStore({ feedbackCapabilities: capabilities({ githubHandle: 'liam' }) });
    render(<FeedbackDialog />);
    expect(text('.feedback__auth')).toBe('Signed in as @liam');
    expect(buttonWithText('Sign in')).toBeUndefined();
  });

  it('shows no auth pill at all without a silent session', () => {
    render(<FeedbackDialog />);
    expect(q('.feedback__auth')).toBeNull();
  });
});
