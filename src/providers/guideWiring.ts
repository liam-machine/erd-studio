/**
 * The onboarding guide's host side (**Show Me Around**, `src/types/onboardingGuide.ts`):
 * when each phase runs, what it counts, and the fixed command or URL behind
 * each action id a page sends.
 *
 *  - Phase A runs on the first draft shown on this machine (or the draft
 *    Show Me Around opens). It goes on through Change options… and the other
 *    starts to the draft they end in, and ends at Keep (`guideDraftDone`), at
 *    Discard or a closed tab, or at Skip guide (`guideSkippedOnDraft`: for
 *    good).
 *  - Phase B runs on the first diagram opened after phase A (in this window
 *    or a later one), or on the open diagram when Show Me Around asks. While it
 *    runs it holds the window's one prompt, and while it is owed activation
 *    holds back the prompts that would pop over its canvas
 *    ({@link guideDefersPrompt}).
 *  - Each phase's flag is written before it shows; Show Me Around runs it again
 *    whatever the flag says.
 *
 * The pages send action ids only. **Star on GitHub** opens {@link GUIDE_STAR_URL}
 * (built from `GITHUB_REPO`); **Set Up My AI Helper** runs the existing
 * `erdStudio.setupAiHelper`; the sidebar step reveals the ERD Studio view
 * container. Nothing here writes a project file.
 *
 * vscode-free: state, commands, the browser and telemetry are injected.
 */

import { GITHUB_REPO } from '../types/feedback';
import {
  guideCanvasDue,
  guideCanvasOwed,
  guideDraftDue,
  type CanvasGuideStart,
  type GuideActionPayload,
  type GuideStatus,
} from '../types/onboardingGuide';
import type { Draft, DraftGuideStart } from '../types/draft';
import type { SessionPromptKind } from '../services/activationPrompts';
import type { TelemetryFeature } from '../services/telemetryPayload';

/** Star on GitHub: ERD Studio's repository page. Fixed: a page never sends a URL. */
export const GUIDE_STAR_URL = `https://github.com/${GITHUB_REPO}`;
/** Set Up My AI Helper: the existing command. */
export const GUIDE_AI_HELPER_COMMAND = 'erdStudio.setupAiHelper';
/** The sidebar step: VS Code's own command that shows the ERD Studio view container (`erd-studio` in package.json). */
export const GUIDE_REVEAL_SIDEBAR_COMMAND = 'workbench.view.extension.erd-studio';

/**
 * Activation prompts held back while phase B is owed (they keep their own
 * flags and ask in a later window): each would pop over the canvas the guide
 * is about to point at. The starts (the start suggestion, the walkthrough of
 * an empty window) still show: they lead to that canvas.
 */
export const GUIDE_DEFERRED_PROMPTS: ReadonlySet<SessionPromptKind> = new Set<SessionPromptKind>([
  'diagramsNudge', 'harnessUpdate', 'migrateToV5', 'upgradeNotice', 'harnessInstall', 'saveLayers',
]);

/** Whether activation holds `kind` back for the guide (phase B is owed on this machine). */
export function guideDefersPrompt(kind: SessionPromptKind, status: GuideStatus | undefined): boolean {
  return guideCanvasOwed(status) && GUIDE_DEFERRED_PROMPTS.has(kind);
}

export interface OnboardingGuideDeps {
  /** The guide's progress on this machine (`globalState[GUIDE_STATE_KEY]`). */
  getStatus(): GuideStatus | undefined;
  setStatus(status: GuideStatus): PromiseLike<unknown> | void;
  feature(key: TelemetryFeature): void;
  executeCommand(command: string, ...args: unknown[]): PromiseLike<unknown>;
  openExternal(url: string): PromiseLike<unknown>;
  /** The semantic dir, as the text names it (`.erd-studio`). */
  semanticDir(): string;
  /** The project stores its model as DBML. */
  dbml(): boolean;
  /** Phase B is on screen: hold the window's one prompt (`SessionPromptGate.reserve('guide')`). */
  holdPrompts(): void;
  log?(message: string): void;
  warn?(message: string, err: unknown): void;
}

export class OnboardingGuide {
  /** Show Me Around asked for this phase; the next draft or canvas takes it. */
  private requested: { phase: 'draft' | 'canvas'; nothingFound: boolean } | undefined;
  /** Phase A is running in this window (it goes on to the next draft until Keep, Discard or Skip). */
  private draftActive = false;
  /** Phase B is running in this window. */
  private canvasActive = false;

  constructor(private readonly deps: OnboardingGuideDeps) {}

  private setStatus(status: GuideStatus): void {
    Promise.resolve(this.deps.setStatus(status)).then(undefined, (err: unknown) => this.deps.warn?.('Could not save the guide\'s progress:', err));
  }

  private run(command: string, ...args: unknown[]): void {
    Promise.resolve(this.deps.executeCommand(command, ...args)).then(undefined, (err: unknown) => this.deps.warn?.(`Could not run ${command} from the guide:`, err));
  }

  /** Show Me Around: the next draft runs phase A (`nothingFound`: an example, because the folder held nothing). */
  requestDraft(options: { nothingFound?: boolean } = {}): void {
    this.requested = { phase: 'draft', nothingFound: options.nothingFound === true };
  }

  /** Show Me Around in a folder with diagrams: the diagram it opens runs phase B. */
  requestCanvas(): void {
    this.requested = { phase: 'canvas', nothingFound: false };
  }

  /** Show Me Around's canvas request is still waiting for a diagram to load. */
  canvasRequested(): boolean {
    return this.requested?.phase === 'canvas';
  }

  /** Counted once per run: the guide began (`guideStarted`, and `guideStartedFromCommand` when the command asked). */
  private started(fromCommand: boolean): void {
    this.deps.feature('guideStarted');
    if (fromCommand) this.deps.feature('guideStartedFromCommand');
  }

  /**
   * A draft is about to show: phase A's start for its page, or undefined.
   * Its flag is written here, before the page shows.
   */
  takeDraft(draft: Draft): DraftGuideStart | undefined {
    const requested = this.requested?.phase === 'draft' ? this.requested : undefined;
    if (!this.draftActive && !guideDraftDue(this.deps.getStatus(), requested !== undefined)) return undefined;
    if (!this.draftActive || requested) {
      this.started(requested !== undefined);
      this.setStatus('draft');
      this.deps.log?.(`Onboarding guide: phase A on ${draft.source === 'example' || draft.source === 'exampleProject' ? 'an example' : 'a draft'}`);
    }
    this.requested = undefined;
    this.draftActive = true;
    const example = draft.source === 'example' || draft.source === 'exampleProject';
    const nothingFound = example && (draft.trigger === 'sidebar' || requested?.nothingFound === true);
    return { ...(nothingFound ? { nothingFound: true } : {}), semanticDir: this.deps.semanticDir() };
  }

  /** Show Me Around while a draft is on show: phase A on it, from the start. */
  startOnOpenDraft(): DraftGuideStart {
    this.started(true);
    this.setStatus('draft');
    this.requested = undefined;
    this.draftActive = true;
    return { semanticDir: this.deps.semanticDir() };
  }

  /** Keep wrote the draft: phase A is done; phase B follows on the diagram that opens. */
  draftKept(_draft: Draft): void {
    if (!this.draftActive) return;
    this.draftActive = false;
    this.deps.feature('guideDraftDone');
    this.deps.log?.('Onboarding guide: phase A done (Keep)');
  }

  /** Discard, or the tab closed: phase A stops (phase B is still owed). */
  draftLeft(_draft: Draft): void {
    this.draftActive = false;
  }

  /** A guide message from the draft page (`step` or `skip`). */
  onDraftAction(action: GuideActionPayload): void {
    if (action.action === 'step') {
      this.deps.log?.(`Onboarding guide: step ${action.step}`);
      return;
    }
    if (action.action === 'skip') {
      this.draftActive = false;
      this.requested = undefined;
      this.deps.feature('guideSkippedOnDraft');
      this.setStatus('skipped');
      this.deps.log?.('Onboarding guide: skipped on the draft');
    }
  }

  /**
   * A diagram finished loading on a canvas: phase B's start for it, or
   * undefined. Its flag is written here, before it shows.
   */
  takeCanvas(): CanvasGuideStart | undefined {
    const requested = this.requested?.phase === 'canvas';
    if (this.canvasActive || !guideCanvasDue(this.deps.getStatus(), requested)) return undefined;
    if (requested) this.started(true);
    this.requested = undefined;
    return this.beginCanvas();
  }

  /** Show Me Around on an open diagram: phase B there, now. */
  startOnCanvas(): CanvasGuideStart {
    this.started(true);
    this.requested = undefined;
    return this.beginCanvas();
  }

  private beginCanvas(): CanvasGuideStart {
    this.draftActive = false;
    this.canvasActive = true;
    this.setStatus('canvas');
    this.deps.feature('guideCanvasStarted');
    this.deps.holdPrompts();
    this.deps.log?.('Onboarding guide: phase B on the canvas');
    return { dbml: this.deps.dbml(), semanticDir: this.deps.semanticDir() };
  }

  /** A guide message from a canvas: each id to its fixed effect. */
  onCanvasAction(action: GuideActionPayload): void {
    switch (action.action) {
      case 'step':
        this.deps.log?.(`Onboarding guide: step ${action.step}`);
        return;
      case 'revealSidebar':
        this.run(GUIDE_REVEAL_SIDEBAR_COMMAND);
        return;
      case 'aiHelper':
        this.deps.feature('guideAiHelperClicked');
        this.run(GUIDE_AI_HELPER_COMMAND);
        return;
      case 'star':
        this.deps.feature('guideStarClicked');
        this.deps.log?.(`Onboarding guide: Star on GitHub opens ${GUIDE_STAR_URL}`);
        Promise.resolve(this.deps.openExternal(GUIDE_STAR_URL)).then(undefined, (err: unknown) => this.deps.warn?.('Could not open the GitHub page:', err));
        this.finish();
        return;
      case 'complete':
        this.finish();
        return;
      case 'skip':
        this.canvasActive = false;
        this.deps.feature('guideSkippedOnCanvas');
        this.setStatus('skipped');
        this.deps.log?.('Onboarding guide: skipped on the canvas');
        return;
    }
  }

  private finish(): void {
    if (!this.canvasActive) return;
    this.canvasActive = false;
    this.deps.feature('guideCompleted');
    this.setStatus('done');
    this.deps.log?.('Onboarding guide: finished');
  }
}
