/**
 * Draft-first's host wiring (`docs/dev/draft-first.md` §2.1, §3, §11): what
 * every flow shares around the one preview of the extension host.
 *
 *  - {@link DRAFT_OTHER_START_COMMANDS}: the fixed command each of a draft's
 *    More ways to start runs. The page sends an id only; the host maps it,
 *    never a command from the page.
 *  - {@link trackedDraftPreview}: the preview every flow is handed. It
 *    claims the window's one prompt for the draft (so nothing pops over it),
 *    counts the funnel keys (fixed keys only, never a name, path or count),
 *    runs an Other Way to Start's command after the page closed, and marks
 *    the folder as started when a Keep wrote a diagram into it.
 *  - {@link DraftGeneration}: bumped by the semantic-dir watchers for changes
 *    that are not ERD Studio's own; a Keep after a bump re-plans (§5.1).
 *
 * vscode-free: the commands, telemetry and state are injected, so it is
 * unit-tested with plain fakes.
 */

import {
  draftKeptQualityFeature,
  draftQualityFlags,
  draftRejectedFastFeature,
  draftShownQualityFeatures,
  type DraftQuality,
} from '../services/draftTelemetry';
import { crashFeedbackPrefill, noReadyFeedbackPrefill, type FeedbackPrefill } from '../services/commandErrors';
import type { TelemetryErrorCode, TelemetryFeature } from '../services/telemetryPayload';
import { draftLayoutFeatures, layoutFailureCodes, webviewErrorCodes } from '../services/telemetryCanvas';
import type { GuideActionPayload } from '../types/onboardingGuide';
import type {
  Draft,
  DraftAnswer,
  DraftGuideStart,
  DraftOtherStart,
  DraftPreview,
  DraftPreviewEvents,
  DraftSource,
} from '../types/draft';

/** The command each Other Way to Start runs, with its fixed arguments (§2.1). */
export const DRAFT_OTHER_START_COMMANDS: Readonly<Record<DraftOtherStart, { command: string; args: readonly unknown[] }>> = Object.freeze({
  blank: { command: 'erdStudio.createDomain', args: [] },
  import: { command: 'erdStudio.importModel', args: [] },
  guide: { command: 'erdStudio.showImportGuide', args: [{ from: 'draft' }] },
  example: { command: 'erdStudio.openExampleProject', args: [] },
  // VS Code's own Open Folder picker.
  openFolder: { command: 'vscode.openFolder', args: [] },
});

/** Which kind of find a draft showed (`draftSource*`); examples count `draftExampleShown` instead. */
export const DRAFT_SOURCE_FEATURES: Readonly<Partial<Record<DraftSource, TelemetryFeature>>> = Object.freeze({
  sqlDdl: 'draftSourceSqlDdl',
  semanticModel: 'draftSourceSemanticModel',
  dbml: 'draftSourceDbml',
  dbt: 'draftSourceDbt',
});

/** What each answer counts (`superseded` counts nothing: another flow took the page). */
const ANSWER_FEATURES: Readonly<Partial<Record<DraftAnswer['kind'], TelemetryFeature>>> = {
  changeOptions: 'draftChangeOptions',
  discard: 'draftDiscarded',
  closed: 'draftClosed',
  otherStart: 'draftOtherStart',
  scope: 'draftScopeChanged',
};

export interface TrackedDraftPreviewDeps {
  /** Take the window's one prompt for the draft when it is free (`SessionPromptGate.claim('draft')`). */
  claim(): void;
  executeCommand(command: string, ...args: unknown[]): PromiseLike<unknown>;
  feature(key: TelemetryFeature): void;
  /**
   * Counts a key without adding it to the onboarding trail (`telemetry.featureQuiet`):
   * the draft's quality flags (`draftTelemetry.ts`), so they never use up the first
   * day's trail. Absent: they are not counted.
   */
  featureQuiet?(key: TelemetryFeature): void;
  /** Registers the listener for the page's details being opened (`draftPreviewEvents`' `onDetailsOpened`). */
  onDetailsOpened?(listener: () => void): void;
  /** The clock (tests). Default `Date.now`. */
  now?(): number;
  /** A Keep wrote the draft (Import DBML's or Import from dbt's writer: into this folder). */
  onKept(draft: Draft): unknown;
  /** Every draft handed to the page (the automatic draft's "was anything shown?"). */
  onAsk?(draft: Draft): void;
  /** Logs a command that failed to start. */
  warn?(message: string, err: unknown): void;
  /**
   * A draft's Open Folder… is about to reload the window: mark it (awaited
   * first) so the window that opens shows that folder's draft at once.
   */
  beforeOpenFolder?(): PromiseLike<unknown>;
  /**
   * The onboarding guide (`src/providers/guideWiring.ts`): whether phase A runs
   * on a draft about to show (it marks itself started first), and the Keep
   * that ends phase A.
   */
  guide?: {
    takeDraft(draft: Draft): DraftGuideStart | undefined;
    draftKept(draft: Draft): void;
    /** The draft was discarded or its tab closed: phase A stops here (Change options… and the other starts carry it on to their draft). */
    draftLeft(draft: Draft): void;
  };
}

/**
 * The preview the flows are given: `inner` (`createDraftPreview`), with the
 * gate, the funnel keys, More ways to start and Keep's bookkeeping around
 * it. A redraw of the page on show (the switcher's next draft, a Keep that
 * found the files changed) is not counted as another `draftShown`.
 */
export function trackedDraftPreview(inner: DraftPreview, deps: TrackedDraftPreviewDeps): DraftPreview {
  /** The page's last answer while it stays open: `scope` and `keep` are followed by a redraw. */
  let lastAnswer: DraftAnswer['kind'] | undefined;
  const now = (): number => (deps.now ? deps.now() : Date.now());
  /** When the page (not a redraw of it) showed, and whether its details were opened since: a rejection at a glance. */
  let askedAt = 0;
  let detailsSeen = false;
  deps.onDetailsOpened?.(() => { detailsSeen = true; });
  /** Quality keys are telemetry only: a failure to work them out never reaches the flow. */
  const quiet = (keys: () => readonly (TelemetryFeature | undefined)[]): void => {
    if (!deps.featureQuiet) return;
    try {
      for (const key of keys()) if (key) deps.featureQuiet(key);
    } catch { /* never breaks the draft */ }
  };
  const quality = (draft: Draft): DraftQuality | null => {
    try {
      return draftQualityFlags(draft);
    } catch {
      return null;
    }
  };
  return {
    isOpen: () => inner.isOpen(),
    showing: () => inner.showing?.(),
    close: () => inner.close(),
    startGuide: (start) => inner.startGuide?.(start),
    async ask(draft) {
      deps.claim();
      deps.onAsk?.(draft);
      const redraw = inner.isOpen() && (lastAnswer === 'scope' || lastAnswer === 'keep');
      if (!redraw) {
        deps.feature('draftShown');
        if (draft.trigger === 'sidebar') deps.feature('draftShownAuto');
        if (draft.source === 'example' || draft.source === 'exampleProject') deps.feature('draftExampleShown');
        const source = DRAFT_SOURCE_FEATURES[draft.source];
        if (source) deps.feature(source);
        // Does the first draft look any good? Flags only, off the trail (B6).
        quiet(() => draftShownQualityFeatures(quality(draft)));
        askedAt = now();
        detailsSeen = false;
      }
      lastAnswer = undefined;
      // Phase A of the onboarding guide: decided (and its flag written) before the page shows.
      const guideStart = redraw ? undefined : deps.guide?.takeDraft(draft);
      const asked = inner.ask(draft);
      if (guideStart) inner.startGuide?.(guideStart);
      const answer = await asked;
      lastAnswer = answer.kind;
      const counted = ANSWER_FEATURES[answer.kind];
      if (counted) deps.feature(counted);
      if (answer.kind === 'discard' || answer.kind === 'closed') {
        quiet(() => [draftRejectedFastFeature(draft.source, now() - askedAt, detailsSeen)]);
      }
      if (answer.kind === 'discard' || answer.kind === 'closed') deps.guide?.draftLeft(draft);
      if (answer.kind === 'otherStart') {
        const { command, args } = DRAFT_OTHER_START_COMMANDS[answer.start];
        // Open Folder… reloads this window: the mark must land before it does.
        const before = answer.start === 'openFolder' ? Promise.resolve(deps.beforeOpenFolder?.()).then(undefined, (err: unknown) => deps.warn?.('Could not note the Open Folder from a draft:', err)) : Promise.resolve();
        before.then(() => deps.executeCommand(command, ...args)).then(undefined, (err: unknown) => deps.warn?.(`Could not run ${command} from a draft:`, err));
        return answer;
      }
      if (answer.kind !== 'keep') return answer;
      let settled = false;
      return {
        kind: 'keep',
        settle(outcome) {
          if (settled) return;
          settled = true;
          if (outcome.kept) {
            deps.feature('draftKept');
            // The draft this Keep answered: the one actually written, after any scope change.
            quiet(() => [draftKeptQualityFeature(quality(draft))]);
            deps.guide?.draftKept(draft);
            if (draft.keep.writer === 'importDbml' || draft.keep.writer === 'drawFromDbt') {
              Promise.resolve(deps.onKept(draft)).then(undefined, (err: unknown) => deps.warn?.('Could not mark the folder as started:', err));
            }
          }
          answer.settle(outcome);
        },
      };
    },
  };
}

/** The preview's passive events, counted (the page counts nothing itself). */
export function draftPreviewEvents(
  feature: (key: TelemetryFeature) => void,
  error: (code: TelemetryErrorCode) => void,
  guide?: (action: GuideActionPayload) => void,
  /** Told when the details open (`trackedDraftPreview`'s `onDetailsOpened`: a later discard is not a rejection at a glance). */
  onDetailsOpened?: () => void,
  /** Open Send Feedback (`erdStudio.reportBug`) with this prefill: the crash screen's Send Feedback. */
  openFeedback?: (prefill: FeedbackPrefill) => unknown,
  /** Run Show Import Report (`erdStudio.showImportReport`) for the draft's import: the banner's link. */
  showImportReport?: (reportId?: number) => unknown,
): DraftPreviewEvents {
  // The built-in examples are left out of the layout keys (2.0 B17): their size is ERD Studio's, not the user's.
  const isExample = (source: DraftSource): boolean => source === 'example' || source === 'exampleProject';
  return {
    detailsOpened: () => {
      feature('draftDetailsOpened');
      onDetailsOpened?.();
    },
    layoutFailed: (_source, failure) => {
      error('draftLayoutFailed');
      // The same class, size and fallback codes a canvas layout failure records
      // (its `log`, the counts and the message, is the preview's to write: never counted).
      if (failure) for (const code of layoutFailureCodes(failure)) error(code);
    },
    ...(showImportReport ? { importReport: (_source: DraftSource, reportId?: number) => { void Promise.resolve().then(() => showImportReport(reportId)).catch(() => undefined); } } : {}),
    ...(guide ? { guide: (action: GuideActionPayload) => guide(action) } : {}),
    pageReady: (_source, slow) => {
      feature('draftPageReady');
      if (slow) feature('readySlowOver10s');
    },
    noReady: () => error('webviewNoReadyDraft'),
    pageError: (_source, kind) => {
      for (const code of webviewErrorCodes(kind, 'draft')) error(code);
    },
    // The crash screen's buttons: the preview has reloaded the page for Reload.
    crashFallback: (_source, action, detail) => {
      if (action === 'reload') {
        feature('crashFallbackReload');
        return;
      }
      feature('crashFallbackFeedback');
      void Promise.resolve(openFeedback?.(crashFeedbackPrefill('draft', detail ? { detail } : {}))).catch(() => undefined);
    },
    // The same two buttons, from the host's notification for a page that never became ready.
    noReadyChoice: (_source, action) => {
      if (action === 'reload') {
        feature('crashFallbackReload');
        return;
      }
      feature('crashFallbackFeedback');
      void Promise.resolve(openFeedback?.(noReadyFeedbackPrefill('draft'))).catch(() => undefined);
    },
    layoutFinished: (source, layout) => {
      if (isExample(source)) return;
      for (const key of draftLayoutFeatures(layout)) feature(key);
    },
    closedWhileLayingOut: (source) => {
      if (!isExample(source)) feature('draftClosedWhileLayingOut');
    },
  };
}

/** How many times the project's files changed outside ERD Studio this session (the watchers bump it). */
export class DraftGeneration {
  private count = 0;

  bump(): void {
    this.count += 1;
  }

  get value(): number {
    return this.count;
  }
}
