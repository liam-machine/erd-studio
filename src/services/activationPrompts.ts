/**
 * One prompt per window session.
 *
 * Opening a window can owe the user several things at once: the start
 * suggestion ("ERD Studio found CREATE TABLE scripts… Create a diagram?"),
 * the Get Started walkthrough, the "This project has N ERD Studio diagrams" notice, the AI
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
  /**
   * A folder with no diagram whose start is obvious (CREATE TABLE scripts, a
   * semantic model, a DBML file, a dbt project, a project from before 2.0):
   * "Create a diagram from them?" (`src/services/startSuggestion.ts`). It
   * decides only after the bounded look, and hands the window to the next
   * prompt when the look finds nothing concrete.
   */
  | 'startSuggestion'
  /**
   * A folder with no diagram and nothing concrete to start from, whose empty
   * Diagrams view the user opened: "No data model found in this folder yet…"
   * with New Diagram / Show Me How (`runNothingFoundPrompt`). Not an
   * activation prompt (activation never shows it): it claims the window only
   * once activation's own prompt has been decided, so a first run's
   * walkthrough keeps the window.
   */
  | 'nothingFound'
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
 * Most useful first. A project that already has diagrams opens one; a
 * folder with none whose start is obvious is offered that start (on a
 * first run it takes the walkthrough's place; the walkthrough stays owed);
 * an empty folder gets the walkthrough; then whatever keeps the project's own
 * files working (old AI helper files, the v4 format) before news and
 * set-up offers.
 */
export const ACTIVATION_PROMPT_PRIORITY: readonly SessionPromptKind[] = [
  'diagramsNudge',
  'startSuggestion',
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

  /**
   * Give the session back: `kind` held it but showed nothing (the start
   * suggestion's look found nothing concrete), so the next prompt may have
   * it. A no-op when another prompt holds it.
   */
  release(kind: SessionPromptKind): void {
    if (this.claimedBy === kind) this.claimedBy = undefined;
  }

  /** The prompt this session showed, if any. */
  get claimed(): SessionPromptKind | undefined {
    return this.claimedBy;
  }

  reset(): void {
    this.claimedBy = undefined;
  }
}
