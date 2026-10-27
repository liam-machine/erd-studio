/**
 * The base of every export's file name (`showcase` in `showcase.dbml` and
 * `showcase.dbdiagram`), in one place so a rich DBML export and its layout
 * file always share it — `dbdiagram push` finds the layout by that base.
 *
 * Internal to core — `diagramExportFileName` and `dbdiagramLayoutFileName`
 * are the public names.
 */

import type { DisplaySubjectArea } from './types/display.js';

// Windows reserves these names whatever extension follows them (`NUL.tar.gz` too).
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?=\.|$)/i;
const MAX_BASE_LENGTH = 100;

/**
 * The domain name with characters no file system accepts (`/ \ : * ? " < > |`
 * and control characters) replaced by `-`, leading and trailing dots and
 * spaces removed, at most 100 characters, and `diagram` when nothing is left.
 * A name Windows reserves (`con`, `nul.txt`, …) gets `-diagram` after the
 * reserved word.
 */
export function exportFileBase(domain: Pick<DisplaySubjectArea, 'domain'>): string {
  const raw = typeof domain?.domain === 'string' ? domain.domain : '';
  let base = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, MAX_BASE_LENGTH)
    .replace(/[\s.]+$/g, '');
  if (base === '') base = 'diagram';
  return base.replace(WINDOWS_RESERVED, '$1-diagram');
}
