/**
 * The last import's report, in memory only (`importReport.ts`): every import
 * records its ledger here when its draft is drawn (or when it fails), and
 * moves its status on as the draft is kept or left. A new import replaces
 * it; nothing is written to disk and nothing survives a reload.
 *
 * The seam for every import, the import worker included: call
 * {@link recordImportReport} with the ledger you have (a stopped import
 * records `cancelled` or `timedOut` with what it had read so far), keep the
 * id, and {@link updateImportReport} it as the import goes on. An update for
 * an import a newer one has replaced does nothing.
 *
 * Pure and vscode-free.
 */

import type { LedgerEntry } from './importLedger';
import type { ImportReportRecord } from './importReport';

type Listener = () => void;

let latest: { id: number; record: ImportReportRecord } | undefined;
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

/** Record an import's report, replacing the last one. Returns its id, for {@link updateImportReport}. */
export function recordImportReport(record: Omit<ImportReportRecord, 'at'> & { at?: number }): number {
  const id = nextId++;
  latest = {
    id,
    record: {
      ...record,
      ledger: copyLedger(record.ledger),
      ...(record.files ? { files: { ...record.files } } : {}),
      ...(record.imported ? { imported: { ...record.imported } } : {}),
      at: record.at ?? Date.now(),
    },
  };
  changed();
  return id;
}

/** Move import `id`'s report on (kept, not kept…). False when a newer import has replaced it, or there is none. */
export function updateImportReport(id: number | undefined, patch: Partial<Pick<ImportReportRecord, 'status' | 'diagram'>>): boolean {
  if (id === undefined || !latest || latest.id !== id) return false;
  latest = { id, record: { ...latest.record, ...patch } };
  changed();
  return true;
}

/** The last import's report, if any import has run in this window. */
export function latestImportReport(): ImportReportRecord | undefined {
  return latest?.record;
}

/** Told whenever the report changes (a new import, a Keep). */
export function onImportReportChanged(listener: Listener): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => { listeners.delete(listener); } };
}

/** Forget the report (tests). */
export function _resetImportReports(): void {
  latest = undefined;
  listeners.clear();
}
