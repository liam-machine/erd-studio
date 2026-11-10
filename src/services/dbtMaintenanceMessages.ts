/**
 * The words for the two dbt maintenance commands (#263): Refresh Manifest
 * and Strip Legacy Domain Tags. Each says whose problem a failure is and
 * offers the button that moves it on; `extension.ts` gives each button its
 * action.
 *
 * vscode-free, so every message and its buttons are unit-tested without a
 * host, and built from `commandErrors.ts` rather than copied from it.
 */

import { OPEN_FILE_BUTTON, SEND_FEEDBACK_BUTTON, TRY_AGAIN_BUTTON, projectRelative } from './commandErrors';
import type { SkippedFile, StripResult } from './legacyTagCleanupService';
import { plural } from './logger';
import type { ManifestStaleReason } from './manifestService';

/** The commands' titles, as the palette says them. */
export const REFRESH_MANIFEST_TITLE = 'Refresh Manifest';
export const STRIP_LEGACY_TAGS_TITLE = 'Strip Legacy Domain Tags';

/** Runs dbt parse to rebuild the manifest (the same words as `RUN_DBT_PARSE_ACTION`). */
export const RUN_DBT_PARSE_BUTTON = 'Run dbt parse';
export const SHOW_MODIFIED_FILES_BUTTON = 'Show Modified Files';
export const SHOW_SKIPPED_FILES_BUTTON = 'Show Skipped Files';

/** A notice in words, how loud it is, and its buttons, in order. */
export interface MaintenanceNotice {
  level: 'info' | 'warning' | 'error';
  message: string;
  buttons: string[];
}

/**
 * What Refresh Manifest says when the manifest it read was stale. `shown` is
 * the manifest's project-relative path; `retried` is true on the Try Again a
 * first mid-write answer offered, so a manifest that is really broken stops
 * saying "try again" and says what to do instead.
 *
 * - `timeout` is ERD Studio's limit, not the project's: Try Again and Send Feedback.
 * - `malformed` / `midWrite` on the first try, with an earlier copy to show:
 *   dbt is most likely still writing it, so Try Again.
 * - Otherwise (still unreadable on the retry, or nothing earlier to show):
 *   the file dbt wrote is the problem, so Run dbt parse and Open File.
 */
export function manifestStaleNotice(
  reason: ManifestStaleReason,
  ctx: { shown: string; hasLastKnownGood: boolean; retried: boolean },
): MaintenanceNotice {
  const { shown } = ctx;
  if (reason === 'timeout') {
    return {
      level: 'error',
      message: `${shown} is too large for ERD Studio to read in time. This is a limit in ERD Studio, not a problem with your project. ` +
        (ctx.hasLastKnownGood ? 'Diagrams show the last version ERD Studio could read.' : 'Diagrams show no dbt manifest data for now.'),
      buttons: [TRY_AGAIN_BUTTON, SEND_FEEDBACK_BUTTON],
    };
  }
  if (!ctx.retried && ctx.hasLastKnownGood) {
    return {
      level: 'warning',
      message: `dbt is still writing ${shown}. Diagrams show the last version ERD Studio could read.`,
      buttons: [TRY_AGAIN_BUTTON],
    };
  }
  const what = reason === 'midWrite'
    ? `${shown} lists no dbt models, though the last copy ERD Studio read had some.`
    : `ERD Studio can't read ${shown}: it isn't valid JSON.`;
  const showing = ctx.hasLastKnownGood
    ? 'Diagrams show the last version ERD Studio could read.'
    : 'Diagrams show no dbt manifest data until it is rebuilt.';
  return {
    level: 'warning',
    message: `${what} This is a problem in the file dbt wrote, not in your diagrams. Run dbt parse to rebuild it. ${showing}`,
    buttons: [RUN_DBT_PARSE_BUTTON, OPEN_FILE_BUTTON],
  };
}

/** Send Feedback's prefill for a manifest too large to read in time: no path, no message. */
export function manifestTimeoutFeedbackPrefill(): { kind: 'bug'; title: string; description: string } {
  return {
    kind: 'bug',
    title: `${REFRESH_MANIFEST_TITLE}: manifest.json too large to read in time`,
    description: `${REFRESH_MANIFEST_TITLE} said the dbt manifest was too large for ERD Studio to read in time.`,
  };
}

/** Why a file was skipped, in the user's terms, and whose problem it is. */
const SKIP_REASONS: Readonly<Record<SkippedFile['reason'], string>> = {
  read: "couldn't be read. Is it open in another program, or blocked by permissions?",
  parse: 'not valid YAML. Fix it and run the command again.',
  write: "couldn't be written. Is it open in another program, or read-only?",
};

/** The summary Strip Legacy Domain Tags shows once it has run. */
export function stripTagsSummary(result: Pick<StripResult, 'filesScanned' | 'filesModified' | 'tagsRemoved' | 'skipped'>): MaintenanceNotice {
  const skipped = result.skipped.length;
  const skippedButton = skipped > 0 ? [SHOW_SKIPPED_FILES_BUTTON] : [];
  if (result.tagsRemoved === 0) {
    if (skipped === 0) {
      return { level: 'info', message: `No legacy domain tags found. Scanned ${plural(result.filesScanned, 'YAML file')}.`, buttons: [] };
    }
    return {
      level: 'warning',
      message: `No legacy domain tags were removed. ${plural(skipped, 'file')} couldn't be changed; nothing in them was touched.`,
      buttons: skippedButton,
    };
  }
  const removed = `Removed ${plural(result.tagsRemoved, 'tag')} from ${plural(result.filesModified, 'file')}. Review the diff before committing.`;
  if (skipped === 0) return { level: 'info', message: removed, buttons: [SHOW_MODIFIED_FILES_BUTTON] };
  return {
    level: 'warning',
    message: `${removed} ${plural(skipped, 'file')} couldn't be changed; nothing in them was touched.`,
    buttons: [SHOW_MODIFIED_FILES_BUTTON, ...skippedButton],
  };
}

/** Show Skipped Files' quick-pick rows: each file, project-relative, with why it was skipped. */
export function skippedFileItems(skipped: readonly SkippedFile[], workspaceRoot: string): Array<{ label: string; description: string; fullPath: string }> {
  return skipped.map((file) => ({
    label: projectRelative(workspaceRoot, file.path),
    description: SKIP_REASONS[file.reason],
    fullPath: file.path,
  }));
}
