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
 * path the page sends is ever opened (a click carries the token of the page
 * it came from, so one from a page a newer report replaced opens nothing),
 * and nothing is written anywhere: the reports live in memory
 * (`importReportStore.ts`, the last few imports, by id).
 *
 * A ledger crosses bundle and worker boundaries as plain data, so an
 * outcome, unit or cause this build does not know is reported (as `lost`,
 * an `item`, `Other`), never thrown on or dropped; a file named by its
 * absolute path (read from outside the open folder) is shown by its folder
 * and name only; and a huge ledger lists at most {@link MAX_ITEMS_LISTED}
 * entries on the page, counting the rest exactly.
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
/**
 * At most this many entries are listed on the whole page, however many
 * causes the ledger spreads over: each cause lists an even share (at least
 * {@link MIN_ITEMS_PER_GROUP}, at most {@link MAX_ITEMS_PER_GROUP}) and
 * counts the rest, so a huge import's report stays quick to open.
 */
export const MAX_ITEMS_LISTED = 1000;
const MIN_ITEMS_PER_GROUP = 5;

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

function statusSentence(record: Pick<ImportReportRecord, 'status' | 'diagram' | 'ledger'>): string {
  const said = record.status === 'kept'
    ? (record.diagram ? `Kept as the diagram ${ledgerText(record.diagram, MAX_NAME)}.` : 'Kept as a diagram.')
    : own(STATUS_SENTENCES, record.status) ?? STATUS_SENTENCES.failed;
  const stop = record.status === 'draft' || record.status === 'kept' || record.status === 'notKept' ? stoppedEarly(record.ledger) : undefined;
  return stop ? `${said} ${STOPPED_EARLY_SENTENCES[stop]}` : said;
}

/**
 * Said after the status of an import that drew what it had read when it was
 * stopped (Import SQL DDL's Cancel or time limit: its ledger holds the unread
 * statements as `problem` entries with the cause `cancelled` / `timeLimit`).
 */
const STOPPED_EARLY_SENTENCES: Readonly<Record<'cancelled' | 'timeLimit', string>> = {
  cancelled: 'The import was cancelled before it read every statement: what it did not read is under Not imported, at the line each file stopped.',
  timeLimit: 'The import reached its time limit before it read every statement: what it did not read is under Not imported, at the line each file stopped.',
};

/** The stop an import's ledger records, if it was stopped early (the time limit first, as the outcome count reads it). */
function stoppedEarly(ledger: readonly LedgerEntry[]): 'cancelled' | 'timeLimit' | undefined {
  let found: 'cancelled' | undefined;
  for (const e of Array.isArray(ledger) ? ledger : []) {
    if (!e || e.outcome !== 'problem' || !(Number(e.count) > 0)) continue;
    if (e.cause === 'timeLimit') return 'timeLimit';
    if (e.cause === 'cancelled') found = 'cancelled';
  }
  return found;
}

const fmt = (n: number): string => n.toLocaleString('en-US');

/**
 * `table[key]` only for the table's own keys: a ledger crosses bundle and
 * worker boundaries as plain data, so an outcome, unit or cause this build
 * does not know (or one named like `constructor`) reads as absent, never as
 * an inherited Object property.
 */
function own<T>(table: Readonly<Record<string, T>>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** A unit's nouns; one this build does not know is an `item`. */
function nounsOf(unit: unknown): readonly [string, string] {
  return own(LEDGER_UNIT_NOUNS, unit) ?? ['item', 'items'];
}

function unitsOf(entry: LedgerEntry): string {
  const [one, many] = nounsOf(entry.unit);
  return `${fmt(entry.count)} ${entry.count === 1 ? one : many}`;
}

/** A cause this build knows, else `other` (so it groups, and an attribute never carries its text). */
function knownCause(cause: unknown): LedgerCause {
  return own(LEDGER_CAUSE_PHRASES, cause) !== undefined ? (cause as LedgerCause) : 'other';
}

/** An outcome this build knows, else `lost` (reported under Not imported, so it is never dropped). */
function knownOutcome(outcome: unknown): LedgerOutcome {
  return own(IMPORT_REPORT_SECTION_OF, outcome) !== undefined ? (outcome as LedgerOutcome) : 'lost';
}

function causeHeading(cause: LedgerCause): string {
  const phrase = own(LEDGER_CAUSE_PHRASES, cause);
  return phrase ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : 'Other';
}

/** A usable count: a positive finite number (anything else is not an entry). */
function countOf(entry: LedgerEntry): number {
  const n = entry.count;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * A ledger file name as the page shows it. Names are normally relative (to
 * the open folder, or the picked folder); a file read from outside the open
 * folder can be named by its absolute path, which the page never shows: only
 * its folder and name (`…/clientA/schema.sql`).
 */
export function shownFileName(name: string): string {
  if (!/^(?:[\\/]|[A-Za-z]:[\\/])/.test(name)) return name;
  const parts = name.split(/[\\/]+/).filter((p) => p !== '' && !/^[A-Za-z]:$/.test(p));
  return `…/${parts.slice(-2).join('/')}`;
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
    const raw = entry.where?.line;
    const line = typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
    const key = `${file}\u0000${line ?? ''}`;
    let index = linkIndex.get(key);
    if (index === undefined) {
      index = links.length;
      links.push(line !== undefined ? { file, line } : { file });
      linkIndex.set(key, index);
    }
    return index;
  };

  // First pass: every entry into its section and cause (counts are exact whatever is listed).
  type Building = { group: ImportReportGroup; first: number; entries: LedgerEntry[] };
  const bySection = new Map<ImportReportSectionId, Map<LedgerCause, Building>>();
  record.ledger.forEach((entry, order) => {
    const count = countOf(entry);
    if (count === 0) return;
    const outcome = knownOutcome(entry.outcome);
    const sectionId = IMPORT_REPORT_SECTION_OF[outcome];
    const cause = knownCause(entry.cause);
    let causes = bySection.get(sectionId);
    if (!causes) { causes = new Map(); bySection.set(sectionId, causes); }
    let building = causes.get(cause);
    if (!building) {
      building = { group: { cause, heading: causeHeading(cause), count: 0, items: [], more: 0 }, first: order, entries: [] };
      causes.set(cause, building);
    }
    building.group.count += count;
    building.entries.push(outcome === entry.outcome && count === entry.count ? entry : { ...entry, outcome, count });
  });

  // Second pass, in the page's order: each cause lists its share, and counts the rest.
  const ordered = IMPORT_REPORT_SECTIONS.map((id) => [id, [...(bySection.get(id)?.values() ?? [])]
    .sort((a, b) => b.group.count - a.group.count || a.first - b.first)] as const);
  const groupCount = ordered.reduce((n, [, groups]) => n + groups.length, 0);
  const share = Math.min(MAX_ITEMS_PER_GROUP, Math.max(MIN_ITEMS_PER_GROUP, Math.floor(MAX_ITEMS_LISTED / Math.max(groupCount, 1))));
  for (const [, groups] of ordered) {
    for (const { group, entries } of groups) {
      const listed = entries.slice(0, share);
      group.more = entries.length - listed.length;
      for (const entry of listed) {
        const where = entry.where;
        const name = where?.table ? ledgerText(where.column ? `${where.table}.${where.column}` : where.table, MAX_NAME) : undefined;
        const line = typeof where?.line === 'number' && Number.isFinite(where.line) ? where.line : undefined;
        const place = where?.file
          ? `${ledgerText(shownFileName(String(where.file)), MAX_FILE)}${line !== undefined ? ` line ${line}` : ''}`
          : undefined;
        const link = linkFor(entry);
        group.items.push({
          outcome: entry.outcome,
          units: unitsOf(entry),
          ...(name ? { name } : {}),
          what: ledgerText(String(entry.what ?? ''), MAX_WHAT, true),
          detail: entry.detail ? ledgerText(String(entry.detail), MAX_DETAIL, true) : own(LEDGER_OUTCOME_PHRASES, entry.outcome) ?? '',
          ...(place ? { place } : {}),
          ...(link !== undefined ? { link } : {}),
        });
      }
    }
  }

  const sections: ImportReportSection[] = [];
  for (const [id, building] of ordered) {
    const groups = building.map((b) => b.group);
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
  // What could not be read, and what was never read because the import was stopped first.
  const unreadable = new Map<LedgerUnit, number>();
  const unread = new Map<LedgerUnit, number>();
  for (const e of entries) {
    const count = countOf(e);
    if (e.outcome !== 'problem' || e.cause === 'duplicate' || count === 0) continue;
    // A unit this build does not know counts as an item (never `undefined`, never an inherited key).
    const unit = (own(LEDGER_UNIT_NOUNS, e.unit) !== undefined ? e.unit : 'item') as LedgerUnit;
    const into = e.cause === 'cancelled' || e.cause === 'timeLimit' ? unread : unreadable;
    into.set(unit, (into.get(unit) ?? 0) + count);
  }
  if (unreadable.size === 0 && unread.size === 0) return undefined;
  const listOf = (byUnit: Map<LedgerUnit, number>): string => {
    const parts = [...byUnit].map(([unit, n]) => `${fmt(n)} ${n === 1 ? nounsOf(unit)[0] : nounsOf(unit)[1]}`);
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  };
  const total = [...unreadable.values(), ...unread.values()].reduce((a, b) => a + b, 0);
  const one = total === 1;
  const said = [
    ...(unreadable.size ? [`${listOf(unreadable)} could not be read`] : []),
    ...(unread.size ? [`${listOf(unread)} ${[...unread.values()].reduce((a, b) => a + b, 0) === 1 ? 'was' : 'were'} not read before the import was stopped`] : []),
  ].join(' and ');
  return `${title}: ${said}, so the diagram leaves ${one ? 'it' : 'them'} out. ` +
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

/**
 * Page → host: open link `link` (an index into the host's own table) of the
 * page `view` (the token the host drew that page with). The only message.
 */
export type ImportReportToHost = { type: 'open'; link: number };

/**
 * A message from the page on show, or undefined for anything else: a link
 * the report on show does not have, or a click from a page a newer report
 * has since replaced (its `view` is not the one on show, so its index would
 * name another import's file).
 */
export function parseImportReportToHost(raw: unknown, linkCount: number, view: string): ImportReportToHost | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const msg = raw as { type?: unknown; link?: unknown; view?: unknown };
  if (msg.type !== 'open') return undefined;
  if (typeof msg.view !== 'string' || msg.view !== view) return undefined;
  const link = msg.link;
  if (typeof link !== 'number' || !Number.isInteger(link) || link < 0 || link >= linkCount) return undefined;
  return { type: 'open', link };
}

// ---------------------------------------------------------------------------
// The HTML
// ---------------------------------------------------------------------------

export const IMPORT_REPORT_NOTE =
  'Read-only: this report changes nothing and is not saved. ERD Studio: Show Logs has the same lines.';

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
  var main = document.querySelector('[data-view]');
  var view = main ? main.getAttribute('data-view') : '';
  document.addEventListener('click', function (event) {
    var el = event.target instanceof Element ? event.target.closest('[data-link]') : null;
    if (!el) { return; }
    var link = Number(el.getAttribute('data-link'));
    if (Number.isInteger(link)) { vscode.postMessage({ type: 'open', link: link, view: view }); }
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
  return `<li class="ir-item ir-item--${escapeHtml(item.outcome)}"><span class="ir-item__units">${escapeHtml(item.units)}</span>${name}${what}${detail}${place}</li>`;
}

function renderGroup(group: ImportReportGroup, open: boolean): string {
  const more = group.more > 0
    ? `<p class="ir-group__more">And ${fmt(group.more)} more: ERD Studio: Show Logs lists every one.</p>`
    : '';
  return `
      <details class="ir-group" data-cause="${escapeHtml(group.cause)}"${open ? ' open' : ''}>
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

/** Said when an import that stopped or failed recorded nothing to list. */
export const IMPORT_REPORT_NOTHING_RECORDED = 'The import recorded nothing more to list.';

/**
 * The page for `view`, or the no-import page when there is none. `viewToken`
 * names this drawing of the page: its link clicks carry it back, and the
 * host accepts only the one on show ({@link parseImportReportToHost}).
 */
export function buildImportReportHtml(view: ImportReportView | undefined, nonce: string, viewToken = ''): string {
  const n = escapeHtml(nonce);
  const listed = view ? view.sections.some((sec) => sec.groups.length > 0) : false;
  const body = view
    ? `
  <p class="ir__headline">${escapeHtml(view.headline)}</p>
  <p class="ir__status">${escapeHtml(view.status)}</p>
  <p class="ir__note">${escapeHtml(IMPORT_REPORT_NOTE)}</p>
  ${renderTotals(view)}${view.sections.map(renderSection).join('')}${listed ? '' : view.complete ? `
  <p class="ir__empty">Nothing to report: everything was brought across as written.</p>` : `
  <p class="ir__empty">${escapeHtml(IMPORT_REPORT_NOTHING_RECORDED)}</p>`}`
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
<main class="ir" data-view="${escapeHtml(viewToken)}">
  <h1 class="ir__heading">${escapeHtml(IMPORT_REPORT_TITLE)}</h1>${body}
</main>
<script nonce="${n}">${SCRIPT}</script>
</body>
</html>`;
}
