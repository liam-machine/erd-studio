/**
 * **Show Import Report** (`erdStudio.showImportReport`): what the last import
 * in this window did, read-only, built from its loss ledger
 * (`importLedger.ts`).
 *
 * Every import (Import SQL DDL…, Import Semantic Model…, Import DBML…,
 * Import from dbt) records its ledger with {@link recordImportReport}
 * (`importReportStore.ts`); this file turns that record into the page:
 *
 *  - **Imported**: what the draft drew (tables, relationships), then what was
 *    kept in another form (`changed` entries);
 *  - **Repaired**: statements rewritten so they read (`repaired`);
 *  - **Not imported**: what could not be read (`problem`) or has no place in
 *    a diagram (`lost`);
 *  - **Skipped**: what is not design, or not drawn here (`skipped`).
 *
 * Each section is grouped by the ledger's cause, with counts, and each entry
 * that names a file the import read carries a link: the page posts the
 * link's index ({@link parseImportReportToHost}), and the host opens the
 * file at that line from its own table ({@link ImportReportView.links}). No
 * path the page sends is ever opened, and nothing is written anywhere: the
 * report lives in memory until the next import replaces it.
 *
 * Nonce-only CSP, no remote resource, `--vscode-*` colours only, BEM class
 * names. Every string from the ledger is cut to one short line
 * (`ledgerText`) and escaped. Pure and vscode-free; the host half is
 * `src/providers/ImportReportPanel.ts`.
 */

import { escapeHtml } from './dbmlConversionReview';
import {
  LEDGER_CAUSE_PHRASES,
  LEDGER_OUTCOME_PHRASES,
  LEDGER_UNIT_NOUNS,
  createLedger,
  ledgerText,
  type LedgerCause,
  type LedgerEntry,
  type LedgerOutcome,
  type LedgerUnit,
} from './importLedger';

export const SHOW_IMPORT_REPORT_COMMAND = 'erdStudio.showImportReport';
/** The one label for the action: the command's title, the toasts' button and the draft banner's link. */
export const SHOW_IMPORT_REPORT_LABEL = 'Show Import Report';
export const IMPORT_REPORT_TITLE = 'Import Report';
export const IMPORT_REPORT_VIEW_TYPE = 'erdStudio.importReport';

/** Said when the command runs before any import in this window. */
export const NO_IMPORT_REPORT_MESSAGE =
  'No import has run in this window yet. After an import, Show Import Report lists what it brought in and what it left out.';

// ---------------------------------------------------------------------------
// The record an import leaves
// ---------------------------------------------------------------------------

export type ImportReportSource = 'sql' | 'semanticModel' | 'dbml' | 'dbt';

/**
 * Where the import got to:
 *  - `draft`: the draft is on show, nothing saved yet;
 *  - `kept`: Keep saved it (`diagram` names it);
 *  - `notKept`: the draft was discarded or closed;
 *  - `failed`: nothing could be imported (no table read, a file that is not valid);
 *  - `cancelled` / `timedOut`: the import was stopped before it finished
 *    (the user's cancel, or its time limit), so nothing was saved.
 */
export const IMPORT_REPORT_STATUSES = ['draft', 'kept', 'notKept', 'failed', 'cancelled', 'timedOut'] as const;
export type ImportReportStatus = (typeof IMPORT_REPORT_STATUSES)[number];

/** What an import leaves for its report: plain data, held in memory only. */
export interface ImportReportRecord {
  source: ImportReportSource;
  /** The command's title: `Import SQL DDL`, `Import from dbt`. */
  title: string;
  /** The draft's source phrase: `from 4 SQL files (PostgreSQL)`, `from sales.dbml`. */
  from?: string;
  status: ImportReportStatus;
  /** The diagram Keep saved, `layer/name` (`main/sales`). */
  diagram?: string;
  /** What the draft draws; absent when nothing was drawn (a failure). */
  imported?: { tables: number; relationships: number };
  /** Everything not brought across as written (`importLedger.ts`). */
  ledger: readonly LedgerEntry[];
  /**
   * The files the import read: each name a ledger entry gives as `where.file`
   * → its absolute path. Only these are ever opened from the report.
   */
  files?: Readonly<Record<string, string>>;
  /** When it was recorded (ms since the epoch). */
  at: number;
}

// ---------------------------------------------------------------------------
// The view (what the page shows)
// ---------------------------------------------------------------------------

export const IMPORT_REPORT_SECTIONS = ['imported', 'repaired', 'notImported', 'skipped'] as const;
export type ImportReportSectionId = (typeof IMPORT_REPORT_SECTIONS)[number];

/** Which section each ledger outcome is reported in. */
export const IMPORT_REPORT_SECTION_OF: Readonly<Record<LedgerOutcome, ImportReportSectionId>> = {
  changed: 'imported',
  repaired: 'repaired',
  problem: 'notImported',
  lost: 'notImported',
  skipped: 'skipped',
};

const SECTION_TITLES: Readonly<Record<ImportReportSectionId, string>> = {
  imported: 'Imported',
  repaired: 'Repaired',
  notImported: 'Not imported',
  skipped: 'Skipped',
};

const SECTION_HINTS: Readonly<Record<ImportReportSectionId, string>> = {
  imported: 'Kept in another form: each line says how.',
  repaired: 'Rewritten so it reads, then imported.',
  notImported: 'Could not be read, or a diagram has no place for it.',
  skipped: 'Left out on purpose: not part of a design, or not drawn in this diagram.',
};

/** One ledger entry as the page lists it. */
export interface ImportReportItem {
  outcome: LedgerOutcome;
  /** How many units: `3 columns`, `1 table`. */
  units: string;
  /** The table, or `table.column`, the entry names. */
  name?: string;
  /** The fixed phrase that groups it: `WITH TIME ZONE`, `CREATE TABLE`. */
  what: string;
  /** The entry's own clause, else what its outcome says (`not kept`). */
  detail: string;
  /** `film.sql line 12`, when the entry names a file. */
  place?: string;
  /** Index into {@link ImportReportView.links}: the file opens at the line. Absent: not a file the import read. */
  link?: number;
}

/** One cause within a section. */
export interface ImportReportGroup {
  cause: LedgerCause;
  /** `Not in the SQL grammar`, `Other`. */
  heading: string;
  /** Units, summed over its entries. */
  count: number;
  items: ImportReportItem[];
  /** Entries not listed (over {@link MAX_ITEMS_PER_GROUP}). */
  more: number;
}

export interface ImportReportSection {
  id: ImportReportSectionId;
  title: string;
  hint: string;
  /** Units, summed over its groups. */
  count: number;
  /** Imported only: `24 tables and 31 relationships in the draft.` */
  summary?: string;
  groups: ImportReportGroup[];
}

/** A place a link opens: a file the import read (absolute), at a 1-based line. Never sent to the page. */
export interface ImportReportLink {
  file: string;
  line?: number;
}

export interface ImportReportView {
  /** `Import SQL DDL from 4 SQL files (PostgreSQL)`. */
  headline: string;
  /** Where the import got to, one sentence. */
  status: string;
  sections: ImportReportSection[];
  /** The import ran to its draft (or past it): an empty ledger then means everything came across as written. */
  complete: boolean;
  /** The host's link table; the page holds only indexes into it. */
  links: ImportReportLink[];
}

/** At most this many entries are listed per cause; the rest are counted (Show Logs lists every one). */
export const MAX_ITEMS_PER_GROUP = 200;

const MAX_NAME = 80;
const MAX_WHAT = 60;
const MAX_DETAIL = 120;
const MAX_FILE = 160;

const STATUS_SENTENCES: Readonly<Record<Exclude<ImportReportStatus, 'kept'>, string>> = {
  draft: 'The draft is open: nothing is saved until you keep it.',
  notKept: 'The draft was not kept, so nothing was saved.',
  failed: 'Nothing was imported.',
  cancelled: 'The import was stopped before it finished, so nothing was saved.',
  timedOut: 'The import took longer than its time limit and was stopped, so nothing was saved.',
};

function statusSentence(record: Pick<ImportReportRecord, 'status' | 'diagram'>): string {
  if (record.status === 'kept') {
    return record.diagram ? `Kept as the diagram ${ledgerText(record.diagram, MAX_NAME)}.` : 'Kept as a diagram.';
  }
  return STATUS_SENTENCES[record.status];
}

const fmt = (n: number): string => n.toLocaleString('en-US');

function unitsOf(entry: LedgerEntry): string {
  const [one, many] = LEDGER_UNIT_NOUNS[entry.unit];
  return `${fmt(entry.count)} ${entry.count === 1 ? one : many}`;
}

function causeHeading(cause: LedgerCause): string {
  const phrase = LEDGER_CAUSE_PHRASES[cause];
  return phrase ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : 'Other';
}

/** `24 tables and 31 relationships in the draft.` */
function importedSummary(imported: { tables: number; relationships: number }, status: ImportReportStatus): string {
  const tables = `${fmt(imported.tables)} ${imported.tables === 1 ? 'table' : 'tables'}`;
  const relationships = `${fmt(imported.relationships)} ${imported.relationships === 1 ? 'relationship' : 'relationships'}`;
  const where = status === 'kept' ? 'in the diagram' : 'in the draft';
  return `${tables} and ${relationships} ${where}.`;
}

/**
 * The page's view of a record: sections in {@link IMPORT_REPORT_SECTIONS}
 * order (Imported whenever the draft drew something, the others only when
 * they hold an entry), causes biggest first, entries in the ledger's order.
 */
export function buildImportReportView(record: ImportReportRecord): ImportReportView {
  const links: ImportReportLink[] = [];
  const linkIndex = new Map<string, number>();
  const files = record.files ?? {};
  const linkFor = (entry: LedgerEntry): number | undefined => {
    const name = entry.where?.file;
    if (!name || !Object.prototype.hasOwnProperty.call(files, name)) return undefined;
    const file = files[name];
    if (typeof file !== 'string' || file === '') return undefined;
    const line = entry.where?.line;
    const key = `${file}\u0000${line ?? ''}`;
    let index = linkIndex.get(key);
    if (index === undefined) {
      index = links.length;
      links.push(line !== undefined ? { file, line } : { file });
      linkIndex.set(key, index);
    }
    return index;
  };

  type Building = { group: ImportReportGroup; first: number };
  const bySection = new Map<ImportReportSectionId, Map<LedgerCause, Building>>();
  record.ledger.forEach((entry, order) => {
    if (!(entry.count > 0)) return;
    const sectionId = IMPORT_REPORT_SECTION_OF[entry.outcome];
    if (!sectionId) return;
    let causes = bySection.get(sectionId);
    if (!causes) { causes = new Map(); bySection.set(sectionId, causes); }
    let building = causes.get(entry.cause);
    if (!building) {
      building = { group: { cause: entry.cause, heading: causeHeading(entry.cause), count: 0, items: [], more: 0 }, first: order };
      causes.set(entry.cause, building);
    }
    const { group } = building;
    group.count += entry.count;
    if (group.items.length >= MAX_ITEMS_PER_GROUP) {
      group.more += 1;
      return;
    }
    const where = entry.where;
    const name = where?.table ? ledgerText(where.column ? `${where.table}.${where.column}` : where.table, MAX_NAME) : undefined;
    const place = where?.file
      ? `${ledgerText(where.file, MAX_FILE)}${where.line !== undefined ? ` line ${where.line}` : ''}`
      : undefined;
    const link = linkFor(entry);
    group.items.push({
      outcome: entry.outcome,
      units: unitsOf(entry),
      ...(name ? { name } : {}),
      what: ledgerText(entry.what, MAX_WHAT, true),
      detail: entry.detail ? ledgerText(entry.detail, MAX_DETAIL, true) : LEDGER_OUTCOME_PHRASES[entry.outcome],
      ...(place ? { place } : {}),
      ...(link !== undefined ? { link } : {}),
    });
  });

  const sections: ImportReportSection[] = [];
  for (const id of IMPORT_REPORT_SECTIONS) {
    const groups = [...(bySection.get(id)?.values() ?? [])]
      .sort((a, b) => b.group.count - a.group.count || a.first - b.first)
      .map((b) => b.group);
    const drew = id === 'imported' && record.imported !== undefined;
    if (groups.length === 0 && !drew) continue;
    sections.push({
      id,
      title: SECTION_TITLES[id],
      hint: SECTION_HINTS[id],
      count: groups.reduce((n, g) => n + g.count, 0),
      ...(drew ? { summary: importedSummary(record.imported!, record.status) } : {}),
      groups,
    });
  }

  const from = record.from ? ledgerText(record.from, 160) : '';
  return {
    headline: `${ledgerText(record.title, 60)}${from ? ` ${from}` : ''}`,
    status: statusSentence(record),
    sections,
    complete: record.status === 'draft' || record.status === 'kept' || record.status === 'notKept',
    links,
  };
}

/** Units per section (zero for a section with no entry): what the summary line counts. */
export function importReportCounts(view: ImportReportView): Record<ImportReportSectionId, number> {
  const counts: Record<ImportReportSectionId, number> = { imported: 0, repaired: 0, notImported: 0, skipped: 0 };
  for (const s of view.sections) counts[s.id] = s.count;
  return counts;
}

// ---------------------------------------------------------------------------
// What the imports say with it
// ---------------------------------------------------------------------------

/**
 * The toast after a Keep that left something out because it could not be
 * read (a `problem` entry; a table defined twice was read, so it is not
 * one): `Import SQL DDL: 3 tables could not be read, so the diagram leaves
 * them out. Show Import Report lists each one with its file and line.`
 * Undefined when everything read.
 */
export function partialImportMessage(title: string, entries: readonly LedgerEntry[]): string | undefined {
  const byUnit = new Map<LedgerUnit, number>();
  for (const e of entries) {
    if (e.outcome !== 'problem' || e.cause === 'duplicate' || !(e.count > 0)) continue;
    byUnit.set(e.unit, (byUnit.get(e.unit) ?? 0) + e.count);
  }
  if (byUnit.size === 0) return undefined;
  const parts = [...byUnit].map(([unit, n]) => `${fmt(n)} ${n === 1 ? LEDGER_UNIT_NOUNS[unit][0] : LEDGER_UNIT_NOUNS[unit][1]}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  const one = [...byUnit.values()].reduce((a, b) => a + b, 0) === 1;
  return `${title}: ${list} could not be read, so the diagram leaves ${one ? 'it' : 'them'} out. ` +
    `${SHOW_IMPORT_REPORT_LABEL} lists ${one ? 'it' : 'each one'} with its file and line.`;
}

/**
 * A failed import's ledger from its problems (a file that is not valid DBML,
 * a semantic model that does not read): one `problem` entry per place, with
 * its file and line only (the parser's message stays in the failure message
 * and the log).
 */
export function problemLedger(
  problems: ReadonlyArray<{ file?: string; line?: number }>,
  unit: LedgerUnit,
  what: string,
  cause: LedgerCause = 'parseError',
): LedgerEntry[] {
  const ledger = createLedger();
  for (const p of problems) {
    ledger.problem(unit, cause, what, p.file ? { file: p.file, ...(p.line !== undefined ? { line: p.line } : {}) } : undefined);
  }
  return [...ledger.entries];
}

// ---------------------------------------------------------------------------
// The page's protocol
// ---------------------------------------------------------------------------

/** Page → host: open link `link` (an index into the host's own table). The only message. */
export type ImportReportToHost = { type: 'open'; link: number };

/** A message from the page, or undefined for anything else (a link the report on show does not have). */
export function parseImportReportToHost(raw: unknown, linkCount: number): ImportReportToHost | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const msg = raw as { type?: unknown; link?: unknown };
  if (msg.type !== 'open') return undefined;
  const link = msg.link;
  if (typeof link !== 'number' || !Number.isInteger(link) || link < 0 || link >= linkCount) return undefined;
  return { type: 'open', link };
}

// ---------------------------------------------------------------------------
// The HTML
// ---------------------------------------------------------------------------

export const IMPORT_REPORT_NOTE =
  'Read-only: this report changes nothing and is not saved. It shows the last import in this window; ERD Studio: Show Logs has the same lines.';

export function buildImportReportCsp(nonce: string): string {
  return ["default-src 'none'", `style-src 'nonce-${nonce}'`, `script-src 'nonce-${nonce}'`].join('; ') + ';';
}

export const IMPORT_REPORT_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}
.ir { max-width: 960px; margin: 0 auto; padding: 24px 24px 48px; }
.ir__heading { margin: 0 0 6px; font-size: 1.5em; font-weight: 600; }
.ir__headline { margin: 0 0 4px; font-weight: 600; }
.ir__status { margin: 0 0 4px; line-height: 1.5; }
.ir__note { margin: 0 0 14px; line-height: 1.5; color: var(--vscode-descriptionForeground); }
.ir__totals { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0 0 18px; padding: 0; list-style: none; }
.ir__total { color: var(--vscode-descriptionForeground); }
.ir__total-count { color: var(--vscode-foreground); font-weight: 600; }
.ir__empty { margin: 0; color: var(--vscode-descriptionForeground); }
.ir-section {
  margin: 0 0 16px; padding: 12px 16px; border-radius: 4px;
  border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
}
.ir-section--notImported { border-color: var(--vscode-editorWarning-foreground, var(--vscode-focusBorder)); }
.ir-section__title { margin: 0 0 4px; font-size: 1.1em; font-weight: 600; }
.ir-section__count { color: var(--vscode-descriptionForeground); font-weight: normal; }
.ir-section__hint, .ir-section__summary { margin: 0 0 8px; line-height: 1.5; }
.ir-section__hint { color: var(--vscode-descriptionForeground); }
.ir-group { margin: 0 0 6px; }
.ir-group__summary { cursor: pointer; padding: 2px 0; }
.ir-group__summary:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.ir-group__count { color: var(--vscode-descriptionForeground); }
.ir-items { margin: 4px 0 8px; padding: 0 0 0 20px; }
.ir-item { margin: 0 0 4px; line-height: 1.5; }
.ir-item__units { color: var(--vscode-descriptionForeground); }
.ir-item__name, .ir-item__what {
  font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
}
.ir-item__place { color: var(--vscode-descriptionForeground); }
.ir-item__link {
  padding: 0; border: none; background: none; cursor: pointer; font: inherit;
  color: var(--vscode-textLink-foreground);
}
.ir-item__link:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
.ir-item__link:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.ir-group__more { margin: 0 0 8px 20px; color: var(--vscode-descriptionForeground); }
`;

const SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  document.addEventListener('click', function (event) {
    var el = event.target instanceof Element ? event.target.closest('[data-link]') : null;
    if (!el) { return; }
    var link = Number(el.getAttribute('data-link'));
    if (Number.isInteger(link)) { vscode.postMessage({ type: 'open', link: link }); }
  });
})();
`;

function renderItem(item: ImportReportItem): string {
  const name = item.name ? ` <span class="ir-item__name">${escapeHtml(item.name)}</span>:` : ':';
  const what = item.what ? ` <span class="ir-item__what">${escapeHtml(item.what)}</span>` : '';
  const detail = item.detail ? ` ${item.what ? '– ' : ''}${escapeHtml(item.detail)}` : '';
  const place = item.place === undefined
    ? ''
    : item.link !== undefined
      ? ` <button class="ir-item__link" type="button" data-link="${item.link}" title="Open the file at this line">${escapeHtml(item.place)}</button>`
      : ` <span class="ir-item__place">(${escapeHtml(item.place)})</span>`;
  return `<li class="ir-item ir-item--${item.outcome}"><span class="ir-item__units">${escapeHtml(item.units)}</span>${name}${what}${detail}${place}</li>`;
}

function renderGroup(group: ImportReportGroup, open: boolean): string {
  const more = group.more > 0
    ? `<p class="ir-group__more">And ${fmt(group.more)} more: ERD Studio: Show Logs lists every one.</p>`
    : '';
  return `
      <details class="ir-group" data-cause="${group.cause}"${open ? ' open' : ''}>
        <summary class="ir-group__summary">${escapeHtml(group.heading)} <span class="ir-group__count">(${fmt(group.count)})</span></summary>
        <ul class="ir-items">${group.items.map(renderItem).join('')}</ul>${more}
      </details>`;
}

function renderSection(section: ImportReportSection): string {
  // A short section opens its causes; a long one lists them closed, to be opened one at a time.
  const open = section.groups.length <= 3;
  const summary = section.summary ? `<p class="ir-section__summary">${escapeHtml(section.summary)}</p>` : '';
  const hint = section.groups.length ? `<p class="ir-section__hint">${escapeHtml(section.hint)}</p>` : '';
  return `
    <section class="ir-section ir-section--${section.id}" data-section="${section.id}">
      <h2 class="ir-section__title">${escapeHtml(section.title)}${section.groups.length ? ` <span class="ir-section__count">(${fmt(section.count)})</span>` : ''}</h2>
      ${summary}${hint}${section.groups.map((g) => renderGroup(g, open)).join('')}
    </section>`;
}

function renderTotals(view: ImportReportView): string {
  const counts = importReportCounts(view);
  const items = IMPORT_REPORT_SECTIONS
    .filter((id) => id !== 'imported')
    .map((id) => `<li class="ir__total" data-total="${id}">${escapeHtml(SECTION_TITLES[id])}: <span class="ir__total-count">${fmt(counts[id])}</span></li>`);
  return `<ul class="ir__totals">${items.join('')}</ul>`;
}

/** The page for `view`, or the no-import page when there is none. */
export function buildImportReportHtml(view: ImportReportView | undefined, nonce: string): string {
  const n = escapeHtml(nonce);
  const body = view
    ? `
  <p class="ir__headline">${escapeHtml(view.headline)}</p>
  <p class="ir__status">${escapeHtml(view.status)}</p>
  <p class="ir__note">${escapeHtml(IMPORT_REPORT_NOTE)}</p>
  ${renderTotals(view)}${view.sections.map(renderSection).join('')}${view.sections.length === 0 && view.complete ? `
  <p class="ir__empty">Nothing to report: everything was brought across as written.</p>` : ''}`
    : `
  <p class="ir__empty">${escapeHtml(NO_IMPORT_REPORT_MESSAGE)}</p>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(buildImportReportCsp(nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(IMPORT_REPORT_TITLE)}</title>
<style nonce="${n}">${IMPORT_REPORT_STYLE}</style>
</head>
<body>
<main class="ir">
  <h1 class="ir__heading">${escapeHtml(IMPORT_REPORT_TITLE)}</h1>${body}
</main>
<script nonce="${n}">${SCRIPT}</script>
</body>
</html>`;
}
