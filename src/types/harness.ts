/**
 * Harness status types — shared by `HarnessService` (host), the `erd-studio`
 * CLI's `doctor` and the Welcome panel. Pure types only: nothing under
 * `src/types/**` may import from `src/services/**`.
 */

/**
 * State of one harness file on disk.
 * - `missing`   — not installed.
 * - `current`   — carries this build's `HARNESS_VERSION` marker.
 * - `outdated`  — carries an older marker; an update replaces it.
 * - `newer`     — carries a newer marker (a teammate on a later ERD Studio): never replaced; update ERD Studio instead.
 * - `unmanaged` — exists with no marker: the user's own file, only replaced on explicit confirmation.
 */
export type FileState = 'missing' | 'current' | 'outdated' | 'newer' | 'unmanaged';

export interface HarnessStatus {
  claude: {
    /** `.claude/skills/erd-studio/SKILL.md` (folds in its SYNC.md companion). */
    schemaSkill: FileState;
    /** `.claude/skills/erd-studio-setup/SKILL.md`. */
    setupSkill: FileState;
    /** The PreToolUse hook script exists and is registered in `.claude/settings.local.json`. */
    hookRegistered: boolean;
  };
  /**
   * The Agent Skills copies read by GitHub Copilot, Codex, Gemini CLI and
   * Cursor: `.agents/skills/erd-studio/SKILL.md` (folds in its SYNC.md) and
   * `.agents/skills/erd-studio-setup/SKILL.md`. Their pre-edit hooks are
   * reported in `hooks`.
   */
  agents: {
    schemaSkill: FileState;
    setupSkill: FileState;
  };
  /**
   * The other assistants' "load the skill before the first edit" hook, as
   * `claude.hookRegistered` is Claude Code's: the script exists and the
   * tool's config registers it (`.github/copilot/settings.local.json`,
   * `.codex/hooks.json`, `.gemini/settings.json`). Cursor has none.
   */
  hooks: {
    copilot: boolean;
    codex: boolean;
    gemini: boolean;
  };
  copilot: FileState;
  gemini: FileState;
  codex: FileState;
}

/**
 * Why Set Up My AI Helper left one assistant's pre-edit hook out: its config
 * has comments or trailing commas (`jsonc`), is not JSON (`not-json`) or has
 * a `hooks` value of another shape (`shape`), or a script at the hook's path
 * is the user's own (`own-script`) or from a newer ERD Studio (`newer-script`).
 */
export type AssistantHookSkipReason = 'jsonc' | 'not-json' | 'shape' | 'own-script' | 'newer-script';

export interface SkippedAssistantHook {
  id: 'copilot' | 'codex' | 'gemini';
  reason: AssistantHookSkipReason;
}

export interface RecommendedInstallResult {
  status: 'installed' | 'updated' | 'unchanged' | 'needs-confirmation' | 'failed';
  /** Workspace-relative paths of unmanaged files that blocked the install (`needs-confirmation`). */
  unmanaged: string[];
  /** Workspace-relative (POSIX) paths written by this call. */
  filesWritten: string[];
  /** The skill folders this call covered (`claude` = `.claude/skills/`, `agents` = `.agents/skills/`). */
  targets: Array<'claude' | 'agents'>;
  /**
   * Hooks this call was asked for but left out on purpose. They count as in
   * place for `unchanged`, so a skipped hook never makes every later run
   * report `updated`.
   */
  skippedHooks?: SkippedAssistantHook[];
  error?: string;
}
