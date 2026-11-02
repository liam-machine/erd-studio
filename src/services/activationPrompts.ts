/**
 * One prompt per window session.
 *
 * Opening a window can owe the user several things at once: the Get Started
 * walkthrough, the "This project has N ERD Studio diagrams" notice, the AI
 * helper offer, an update for old AI helper files, the v4 migration, a
 * `layers.json` to save, the upgrade notice, and on a canvas's first open
 * the Convert Project to DBML and file-naming offers. Showing them together
 * buries the one that matters, so each is only *offered* to a
 * `SessionPromptGate`; activation shows the most useful one
 * (`pickActivationPrompt`) and every other waits for the next window.
 *
 * A prompt that waits keeps its own "shown" / "Don't ask again" flag
 * untouched: it is written only when that prompt is actually shown.
 *
 * vscode-free (pure), so the priority is unit tested on its own.
 */

/** Every prompt the session gate arbitrates between. */
export type SessionPromptKind =
  /** "This project has N ERD Studio diagrams. Open X" (once per workspace). */
  | 'diagramsNudge'
  /** The Get Started walkthrough a fresh install owes (once per machine). */
  | 'walkthrough'
  /** AI helper files from an older ERD Studio: Update All / Choose… */
  | 'harnessUpdate'
  /** Diagrams that keep their tables inside the diagram file (v4): Migrate Now. */
  | 'migrateToV5'
  /** The upgrader's one notice about the Welcome page (once per machine). */
  | 'upgradeNotice'
  /** No AI helper files: Set Up My AI Helper (once per workspace). */
  | 'harnessInstall'
  /** Layers found on disk with no `layers.json`: Save Config. */
  | 'saveLayers'
  /** A canvas's Convert Project to DBML offer (once a session). */
  | 'dbmlConversion'
  /** A canvas's new file naming offer (once a session). */
  | 'namingMigration';

/**
 * Most useful first. A project that already has diagrams opens one; an
 * empty folder gets the walkthrough; then whatever keeps the project's own
 * files working (old AI helper files, the v4 format) before news and
 * set-up offers.
 */
export const ACTIVATION_PROMPT_PRIORITY: readonly SessionPromptKind[] = [
  'diagramsNudge',
  'walkthrough',
  'harnessUpdate',
  'migrateToV5',
  'upgradeNotice',
  'harnessInstall',
  'saveLayers',
];

/** The candidate activation shows: the first of `ACTIVATION_PROMPT_PRIORITY` it was offered. */
export function pickActivationPrompt(candidates: Iterable<SessionPromptKind>): SessionPromptKind | undefined {
  const offered = new Set(candidates);
  return ACTIVATION_PROMPT_PRIORITY.find((kind) => offered.has(kind));
}

/**
 * The window session's one prompt: the first claim wins and every later
 * claim is refused until `reset()` (a new extension host, or a test).
 */
export class SessionPromptGate {
  private claimedBy: SessionPromptKind | undefined;

  /** True when `kind` may show now; it then holds the session. */
  claim(kind: SessionPromptKind): boolean {
    if (this.claimedBy !== undefined) return false;
    this.claimedBy = kind;
    return true;
  }

  /** The prompt this session showed, if any. */
  get claimed(): SessionPromptKind | undefined {
    return this.claimedBy;
  }

  reset(): void {
    this.claimedBy = undefined;
  }
}
