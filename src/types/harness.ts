/**
 * Harness status types — shared by `HarnessService` (host), the `erd-studio`
 * CLI's `doctor` and the Welcome panel. Pure types only: nothing under
 * `src/types/**` may import from `src/services/**`.
 */

/**
 * State of one harness file on disk.
 * - `missing`   — not installed.
 * - `current`   — carries this build's `HARNESS_VERSION` marker.
 * - `outdated`  — carries an older (or newer) marker; an update replaces it.
 * - `unmanaged` — exists with no marker: the user's own file, only replaced on explicit confirmation.
 */
export type FileState = 'missing' | 'current' | 'outdated' | 'unmanaged';

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
   * `.agents/skills/erd-studio-setup/SKILL.md`. No hook — only Claude Code
   * gets the enforce-skill guard.
   */
  agents: {
    schemaSkill: FileState;
    setupSkill: FileState;
  };
  copilot: FileState;
  gemini: FileState;
  codex: FileState;
}

export interface RecommendedInstallResult {
  status: 'installed' | 'updated' | 'unchanged' | 'needs-confirmation' | 'failed';
  /** Workspace-relative paths of unmanaged files that blocked the install (`needs-confirmation`). */
  unmanaged: string[];
  /** Workspace-relative (POSIX) paths written by this call. */
  filesWritten: string[];
  /** The skill folders this call covered (`claude` = `.claude/skills/`, `agents` = `.agents/skills/`). */
  targets: Array<'claude' | 'agents'>;
  error?: string;
}
