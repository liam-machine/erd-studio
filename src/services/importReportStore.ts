/**
 * The imports' reports, in memory only (`importReport.ts`): every import
 * records its ledger here when its draft is drawn (or when it fails), and
 * moves its status on as the draft is kept or left. The last
 * {@link MAX_IMPORT_REPORTS_HELD} are held, by id, so an import whose draft
 * is still open when another import runs (or fails) keeps its own report:
 * its Keep marks its own report kept, and its banner link and toast show its
 * own report, never the newer one. Nothing is written to disk and nothing
 * survives a reload.
 *
 * The seam for every import, the import worker included: call
 * {@link recordImportReport} with the ledger you have (a stopped import
 * records `cancelled` or `timedOut` with what it had read so far), keep the
 * id, and {@link updateImportReport} it as the import goes on. An update for
 * a report no longer held does nothing.
 *
 * Pure and vscode-free.
 */

import type { LedgerEntry } from './importLedger';
import type { ImportReportRecord } from './importReport';

type Listener = () => void;

/** How many imports' reports are held (a long session does not grow without end). */
export const MAX_IMPORT_REPORTS_HELD = 10;

/** Held reports by id, oldest first (a Map keeps insertion order). */
const held = new Map<number, ImportReportRecord>();
let latestId: number | undefined;
let nextId = 1;
const listeners = new Set<Listener>();

/** A copy no later change to the import's own ledger reaches (a ledger merges counts into its entries). */
function copyLedger(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return entries.map((e) => ({ ...e, ...(e.where ? { where: { ...e.where } } : {}) }));
}

function changed(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A listener's failure never stops an import.
    }
  }
}

/** Record an import's report: it becomes the latest. Returns its id, for {@link updateImportReport}. */
export function recordImportReport(record: Omit<ImportReportRecord, 'at'> & { at?: number }): number {
  const id = nextId++;
  held.set(id, {
    ...record,
    ledger: copyLedger(record.ledger),
    ...(record.files ? { files: { ...record.files } } : {}),
    ...(record.imported ? { imported: { ...record.imported } } : {}),
    at: record.at ?? Date.now(),
  });
  latestId = id;
  while (held.size > MAX_IMPORT_REPORTS_HELD) held.delete(held.keys().next().value as number);
  changed();
  return id;
}

/**
 * Move import `id`'s report on (kept, not kept…), even when a newer import
 * has run since (the latest stays the latest). False when it is no longer
 * held, or there is none.
 */
export function updateImportReport(id: number | undefined, patch: Partial<Pick<ImportReportRecord, 'status' | 'diagram'>>): boolean {
  const current = id === undefined ? undefined : held.get(id);
  if (id === undefined || !current) return false;
  held.set(id, { ...current, ...patch });
  changed();
  return true;
}

/** The last import's report, if any import has run in this window. */
export function latestImportReport(): ImportReportRecord | undefined {
  return latestId === undefined ? undefined : held.get(latestId);
}

/** The last import's id (undefined: none yet). */
export function latestImportReportId(): number | undefined {
  return latestId;
}

/** Import `id`'s report, while it is held. */
export function importReportById(id: number): ImportReportRecord | undefined {
  return held.get(id);
}

/** A report id from a command argument: a held-or-not positive integer, else undefined (never trusted further). */
export function importReportIdOf(arg: unknown): number | undefined {
  return typeof arg === 'number' && Number.isSafeInteger(arg) && arg > 0 ? arg : undefined;
}

/** Told whenever the report changes (a new import, a Keep). */
export function onImportReportChanged(listener: Listener): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => { listeners.delete(listener); } };
}

/** Forget the report (tests). */
export function _resetImportReports(): void {
  held.clear();
  latestId = undefined;
  listeners.clear();
}
