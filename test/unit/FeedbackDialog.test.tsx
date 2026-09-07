// @vitest-environment jsdom
/**
 * FeedbackDialog — the one dialog behind "Send feedback".
 *
 * What is worth pinning down here is the behaviour a user would notice if it
 * regressed: the copy swapping with the kind, the canvas checkbox only being
 * offered for a bug, Escape closing, the readiness meter moving locally when an
 * image is attached (no round trip), a confident duplicate taking the form
 * over, and the exact `submitFeedback` payload the host receives.
 *
 * The store and the message bus are mocked because this is a component test:
 * the store's own transitions live in editorStore.test.ts, and the host end of
 * every message lives in semanticEditorProvider.feedback.test.ts.
 *
 * Assertions use raw DOM (`textContent`, `className`, `hasAttribute`) — there
 * is no jest-dom here — and drag/paste are driven with plain object literals
 * because jsdom has no `DataTransfer` or `ClipboardEvent`.
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
const byLabel = (label: string) =>
  qq('button').find((b) => b.getAttribute('aria-label') === label) as HTMLButtonElement | undefined;
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
  it('seeds the kind and both text fields', () => {
    resetStore({
      feedbackPrefill: { kind: 'bug', title: 'From palette', description: 'Error shown on canvas' },
    });
    render(<FeedbackDialog />);
    expect(titleInput().value).toBe('From palette');
    expect(descriptionInput().value).toBe('Error shown on canvas');
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
    captureScreenshot.mockResolvedValueOnce({
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      onClipboard: false,
    });
    // The capture path looks for the canvas root before it asks for a shot.
    const canvasRoot = document.createElement('div');
    canvasRoot.id = 'root';
    document.body.appendChild(canvasRoot);
    render(<FeedbackDialog />);
    fireEvent.change(descriptionInput(), { target: { value: 'Something happened.' } });

    await act(async () => {
      fireEvent.click(q<HTMLInputElement>('.feedback__checkbox input')!);
    });
    await waitFor(() => expect(text('.feedback__thumb-name')).toBe('canvas.png'));

    act(() => {
      fireEvent.click(buttonWithText('Not right? Make it a feature')!);
    });

    expect(q('.feedback__thumb')).toBeNull();
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

  it('moves the moment an image is attached — no round trip', async () => {
    renderReady();
    const zone = q('.feedback__dropzone')!;
    const file = new File(['0123456789'], 'shot.png', { type: 'image/png' });

    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    });

    await waitFor(() => expect(text('.feedback__meter-row')).toContain('70%'));
    expect(text('.feedback__thumb-name')).toBe('shot.png');
    // Nothing was asked of the host to move the bar.
    expect(send.mock.calls.map((c) => c[0].type)).not.toContain('analyzeFeedback');
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

  it('stamps the clipboard result on the first image so the host can say what to do', async () => {
    copyImageToClipboard.mockResolvedValueOnce(true);
    render(<FeedbackDialog />);
    fireEvent.change(descriptionInput(), { target: { value: LONG_DESCRIPTION } });

    const file = new File(['0123456789'], 'shot.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.drop(q('.feedback__dropzone')!, { dataTransfer: { files: [file] } });
    });
    await waitFor(() => expect(q('.feedback__thumb')).not.toBeNull());

    await act(async () => {
      fireEvent.click(primaryButton());
    });

    await waitFor(() => expect(submitted()?.attachments).toHaveLength(1));
    expect(submitted().attachments[0].onClipboard).toBe(true);
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

describe('attachments', () => {
  it('says which types and how many are allowed', () => {
    render(<FeedbackDialog />);
    expect(text('.feedback__dropzone')).toContain('Drop images here, paste from the clipboard, or');
    expect(text('.feedback__dropzone-hint')).toBe('PNG, JPEG, GIF or WebP · up to 4 · 10 MB each');
  });

  it('refuses a file GitHub would not take, and says why beside its name', async () => {
    render(<FeedbackDialog />);
    const file = new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' });

    await act(async () => {
      fireEvent.drop(q('.feedback__dropzone')!, { dataTransfer: { files: [file] } });
    });

    await waitFor(() => expect(q('.feedback__reject')).not.toBeNull());
    expect(text('.feedback__reject')).toBe(
      'notes.pdf — Only PNG, JPEG, GIF and WebP images can be attached.',
    );
    expect(q('.feedback__thumb')).toBeNull();
  });

  it('removes an image again', async () => {
    render(<FeedbackDialog />);
    const file = new File(['0123456789'], 'shot.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.drop(q('.feedback__dropzone')!, { dataTransfer: { files: [file] } });
    });
    await waitFor(() => expect(q('.feedback__thumb')).not.toBeNull());

    act(() => {
      fireEvent.click(byLabel('Remove shot.png')!);
    });
    expect(q('.feedback__thumb')).toBeNull();
  });
});

describe('the footer', () => {
  it('explains the plain route, and the clipboard hand-off once an image is on', async () => {
    render(<FeedbackDialog />);
    expect(text('.feedback__route')).toContain('Opens the prefilled form.');
    expect(text('.feedback__route')).toContain('nothing is sent from VS Code');

    const file = new File(['0123456789'], 'shot.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.drop(q('.feedback__dropzone')!, { dataTransfer: { files: [file] } });
    });

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
