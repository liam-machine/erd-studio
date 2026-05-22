/**
 * semanticDirResolver — determines the ERD Studio data directory name for a
 * workspace.
 *
 * Resolution order:
 *   1. An explicit `dbtSemantic.semanticDir` setting (any scope) — user wins.
 *   2. `.erd-studio/` if it exists on disk — the current default convention.
 *   3. `erd-studio/` if it exists on disk — legacy projects keep working.
 *   4. `.erd-studio/` — brand-new setups.
 *
 * `inspect()` is used rather than `get()` so the setting's `default` value is
 * not mistaken for an explicit user choice.
 */

import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

/** Default data directory for new projects. */
export const DEFAULT_SEMANTIC_DIR = '.erd-studio';

/** Legacy data directory — pre-dates the dot-prefixed default. */
export const LEGACY_SEMANTIC_DIR = 'erd-studio';

export function resolveSemanticDir(
  workspaceRoot: string,
  config: vscode.WorkspaceConfiguration,
): string {
  const inspected = config.inspect<string>('semanticDir');
  const explicit =
    inspected?.workspaceFolderValue ??
    inspected?.workspaceValue ??
    inspected?.globalValue;
  const trimmed = typeof explicit === 'string' ? explicit.trim() : '';
  if (trimmed) {
    return trimmed;
  }

  const hasDot = fs.existsSync(path.join(workspaceRoot, DEFAULT_SEMANTIC_DIR));
  const hasLegacy = fs.existsSync(path.join(workspaceRoot, LEGACY_SEMANTIC_DIR));

  if (hasDot && hasLegacy) {
    console.warn(
      '[ERD Studio] Both .erd-studio/ and erd-studio/ exist — using .erd-studio/',
    );
  }
  if (hasDot) { return DEFAULT_SEMANTIC_DIR; }
  if (hasLegacy) { return LEGACY_SEMANTIC_DIR; }
  return DEFAULT_SEMANTIC_DIR;
}
