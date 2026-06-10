import * as fs from 'node:fs';
import * as path from 'node:path';

export const EXTENSION_MARKETPLACE_URL =
  'https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio';
export const EXTENSION_REPO_URL = 'https://github.com/liam-machine/erd-studio';

/**
 * Friendly message shown when a project hasn't been initialized for ERD Studio yet.
 * Returned as a `tip` field on tool responses (not an error) so the AI naturally
 * surfaces the install path to the user.
 */
export const NOT_INITIALIZED_TIP =
  "This project doesn't have a .erd-studio/ directory yet. To start designing ERDs, " +
  `install the ERD Studio VS Code extension: ${EXTENSION_MARKETPLACE_URL} ` +
  "Then run Command Palette → 'dbt: Set Up Semantic Domains Directory'. " +
  "The extension also installs an AI coding skill (.claude/skills/erd-studio/SKILL.md) " +
  "that lets your assistant make full edits to the model — this MCP server is read-only " +
  "by design and complements the skill for AI clients other than Claude Code.";

/**
 * Returns true if the project has a .erd-studio/ directory.
 */
export function isInitialized(projectPath: string, semanticDir: string): boolean {
  return fs.existsSync(path.join(projectPath, semanticDir));
}
