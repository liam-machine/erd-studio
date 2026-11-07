/**
 * The words for **Migrate Subject Areas to the Central Table Library** (v4 →
 * v5) and the smaller activation messages #243 found: what was converted,
 * which files were left and why, and whose problem a failure is.
 *
 * vscode-free, so every text and its buttons are unit-tested without a host
 * (`test/unit/migrationMessages.test.ts`); `extension.ts` only shows them.
 */

import { classifyWriteFailure, oursMessage, projectRelative } from './commandErrors';
import type { MigrationResult } from './migrationService';

/** The command's title in messages (the palette says "Migrate Subject Areas to …"). */
export const MIGRATE_V5_TITLE = 'Migrate to the Central Table Library';

export const MIGRATE_AGAIN_BUTTON = 'Migrate Again';

/** `n diagram` / `n diagrams`. */
function diagrams(n: number): string {
  return `${n} ${n === 1 ? 'diagram' : 'diagrams'}`;
}

/** What a finished migration says, and which buttons it offers. */
export interface MigrationReport {
  level: 'info' | 'warning';
  message: string;
  /** The first file the user can fix (Open File); absent when none is. */
  openFile?: string;
  /** Migrate Again is offered: something was left in the old format. */
  migrateAgain: boolean;
}

/**
 * The message for `migrate()`'s result. Every skipped file is named with its
 * reason; "complete" is said only when nothing was left; nothing to do is said
 * as such, never "Migration complete: .".
 */
export function describeMigrationResult(result: MigrationResult, workspaceRoot: string): MigrationReport {
  const shown = (filePath: string) => projectRelative(workspaceRoot, filePath);
  if (result.skipped.length === 0) {
    const details: string[] = [];
    if (result.domainsConverted > 0) details.push(`${diagrams(result.domainsConverted)} converted`);
    if (result.modelsCreated > 0) details.push(`${result.modelsCreated} table ${result.modelsCreated === 1 ? 'file' : 'files'} created in the Table Library`);
    if (result.mergeConflicts.length > 0) details.push(`${result.mergeConflicts.length} table${result.mergeConflicts.length === 1 ? '' : 's'} defined differently in several diagrams (the most detailed version was kept)`);
    if (details.length === 0) return { level: 'info', message: 'Nothing needed migrating.', migrateAgain: false };
    return { level: 'info', message: `Migration complete: ${details.join(', ')}.`, migrateAgain: false };
  }

  const reasons = result.skipped.map((skip) => {
    const file = shown(skip.filePath);
    if (skip.reason === 'unreadable') return `${file} wasn't converted: it isn't valid JSON. Fix the file`;
    const failure = classifyWriteFailure(skip.error);
    if (failure === 'permission') return `ERD Studio couldn't write ${file} (permission denied). Check the folder isn't read-only`;
    if (failure === 'disk-full') return `ERD Studio couldn't write ${file}: the disk is full. Free some space`;
    return `ERD Studio couldn't convert ${file}. Check the file isn't open in another program`;
  });
  const found = result.domainsFound || result.domainsConverted + result.skipped.length;
  const head = `Converted ${result.domainsConverted} of ${diagrams(found)}.`;
  const firstUnreadable = result.skipped.find((s) => s.reason === 'unreadable');
  return {
    level: 'warning',
    message: `${head} ${reasons.join('. ')}, then run Migrate again.`,
    ...(firstUnreadable ? { openFile: firstUnreadable.filePath } : {}),
    migrateAgain: true,
  };
}

/**
 * The message for a migration that threw (ours): accurate about what changed.
 * Phase 3 never throws, so no diagram file was rewritten; table files written
 * before the throw were kept.
 */
export function migrationFailedMessage(modelsCreated: number): string {
  const outcome = modelsCreated > 0
    ? `no diagram files were changed (the ${modelsCreated} table ${modelsCreated === 1 ? 'file' : 'files'} already written to the Table Library ${modelsCreated === 1 ? 'was' : 'were'} kept)`
    : 'no diagram files were changed';
  return oursMessage(MIGRATE_V5_TITLE, 'while migrating', outcome);
}

/** The manifest was still being written two seconds after it changed (#243 #5). */
export const MANIFEST_STILL_WRITING_MESSAGE =
  'dbt manifest is still being written — the diagram may be out of date. Run dbt parse once dbt has finished.';

/** Re-reading the manifest after it changed threw (#243 #6): ours, or the file; a reload re-reads it. */
export const MANIFEST_RETRY_FAILED_MESSAGE =
  "ERD Studio couldn't re-read the dbt manifest after it changed, so the diagrams may be out of date. Reload the window to read it again.";

/**
 * VS Code refused a set of file moves or a rename (#243 #7), and why that
 * usually happens. `what` is `the file moves` or `the rename`; `prefix` is the
 * command's title and a colon, when the message names one.
 */
export function moveRefusedMessage(what: 'the file moves' | 'the rename', prefix = ''): string {
  return `${prefix}VS Code refused ${what}, usually because a file with that name already exists or a file is open with unsaved changes. Nothing was changed. Save open files and try again.`;
}
