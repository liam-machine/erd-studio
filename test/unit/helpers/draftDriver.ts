/**
 * Draft-first test helpers (`docs/dev/draft-first.md`):
 *
 *  - {@link fakeDraftPreview}: a `DraftPreview` that answers each `ask` from a
 *    script, recording every draft it was handed and how each Keep settled.
 *    For flow tests that call the commands directly (no webview).
 *  - {@link nextDraft} / {@link answerDraft}: drive the real preview
 *    (`DraftPreviewPanel` on the vscode mock) from an activate test, as the
 *    page would: wait for the tab's pending question, then post a choice.
 */
import { DraftPreviewPanel } from '../../../src/providers/DraftPreviewPanel';
import type { Draft, DraftAnswer, DraftKeepOutcome, DraftOtherStart, DraftPreview, DraftToHost } from '../../../src/types/draft';

/** One scripted answer: a kind, or a scope / other start with its id. */
export type ScriptedAnswer =
  | 'keep'
  | 'changeOptions'
  | 'discard'
  | 'closed'
  | 'superseded'
  | { scope: string }
  | { otherStart: DraftOtherStart };

export interface FakeDraftPreview extends DraftPreview {
  /** Every draft handed to `ask`, in order. */
  drafts: Draft[];
  /** How each Keep was settled, in order. */
  settled: DraftKeepOutcome[];
  /** The last draft asked. */
  readonly last: Draft | undefined;
}

/** A preview that answers each `ask` with the next scripted answer (`closed` once they run out). */
export function fakeDraftPreview(answers: ScriptedAnswer[] = []): FakeDraftPreview {
  const drafts: Draft[] = [];
  const settled: DraftKeepOutcome[] = [];
  let open = false;
  return {
    drafts,
    settled,
    get last() { return drafts.at(-1); },
    isOpen: () => open,
    showing: () => (open ? drafts.at(-1)?.id : undefined),
    close: () => { open = false; },
    async ask(draft: Draft): Promise<DraftAnswer> {
      drafts.push(draft);
      open = true;
      const next = answers.shift() ?? 'closed';
      if (next === 'keep') {
        return { kind: 'keep', settle: (outcome) => { settled.push(outcome); if (outcome.kept) open = false; } };
      }
      if (typeof next === 'object') {
        if ('scope' in next) return { kind: 'scope', scopeId: next.scope };
        open = false;
        return { kind: 'otherStart', start: next.otherStart };
      }
      if (next !== 'superseded') open = false;
      return { kind: next } as DraftAnswer;
    },
  };
}

/** The real `setTimeout`, taken before any test fakes the timers (the drivers below wait on real I/O). */
const realSetTimeout: typeof setTimeout = globalThis.setTimeout.bind(globalThis);
const tick = (ms = 0): Promise<void> => new Promise((r) => { realSetTimeout(r, ms); });

/** Let pending promises, I/O and (real) timers run: a flow may await several reads before it asks. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await tick();
}

/**
 * Wait until the real preview shows a draft (other than `previous`, when
 * given) and the page has said `ready`; returns it. Fails after `timeoutMs`.
 */
export async function nextDraft(previous?: Draft, timeoutMs = 4000): Promise<Draft> {
  // Counted in ticks, not Date.now(): a test may have faked the clock.
  for (let waited = 0; ; waited += 5) {
    const panel = DraftPreviewPanel.currentPanel;
    if (panel && panel.shownDraft !== previous) {
      panel.handleMessage({ type: 'ready' });
      return panel.shownDraft;
    }
    if (waited > timeoutMs) throw new Error('No draft was shown');
    await tick(5);
  }
}

/** Post a choice from the page to the open preview, as the page would. */
export function answerDraft(message: DraftToHost): void {
  const panel = DraftPreviewPanel.currentPanel;
  if (!panel) throw new Error('No draft preview is open');
  panel.handleMessage(message);
}

/** Close the real preview (a pending `ask` resolves `closed`). */
export function closeDraft(): void {
  DraftPreviewPanel.close();
}
