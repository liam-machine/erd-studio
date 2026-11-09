/**
 * The import loss ledger: a counted record of everything an import did not
 * bring across as written, so nothing is lost without a word.
 *
 * Every importer (SQL DDL, Power BI semantic models, Import DBML's own plan,
 * Import from dbt) writes into one: a table that could not be read
 * (`problem`), a detail the target has no place for (`lost`), a value kept in
 * another form (`changed`), a statement rewritten so it reads (`repaired`),
 * a statement that is not design (`skipped`). The draft's notes and its
 * **Not imported** list are rendered from the ledger ({@link ledgerNotes},
 * {@link ledgerLeftOut}), the output log from {@link ledgerLogLines}, and the
 * real-world scorecard checks it against the source's own counts
 * (conservation: source = imported + reported).
 *
 * Pure, vscode-free and JSON-safe: entries are plain data, so a ledger
 * crosses the `dist/sqlImport.js` bundle boundary as part of a result.
 * Nothing rendered from it carries more of a user's file than a table,
 * column or file name: `what` is a short fixed phrase chosen by the code
 * (`WITH TIME ZONE`, `UNSIGNED`, `FK action`, `hierarchy`), never file text,
 * and every rendered piece is cut to one short line.
 */

export type LedgerOutcome = 'lost' | 'changed' | 'repaired' | 'skipped' | 'problem';

export type LedgerUnit =
  | 'file' | 'statement' | 'table' | 'column' | 'primaryKey' | 'uniqueKey' | 'relationship'
  | 'description' | 'type' | 'default' | 'constraint' | 'setting' | 'object';

export type LedgerCause =
  | 'parseError' | 'grammarGap' | 'templatePlaceholder' | 'unknownType' | 'reservedWord' | 'trailingOption'
  | 'unsupportedModifier' | 'proceduralBlock' | 'notInFiles' | 'droppedLater' | 'noField' | 'notDesign'
  | 'renamed' | 'normalised' | 'inferred' | 'capped' | 'savedOptional' | 'duplicate'
  // Not read because the import stopped first: the user cancelled it, or its time limit was reached.
  | 'cancelled' | 'timeLimit'
  | 'other';

export interface LedgerWhere {
  file?: string;
  /** 1-based line in that file. */
  line?: number;
  table?: string;
  column?: string;
}

export interface LedgerEntry {
  outcome: LedgerOutcome;
  unit: LedgerUnit;
  cause: LedgerCause;
  /** A fixed short phrase that groups entries: `WITH TIME ZONE`, `UNSIGNED`, `FK action`, `hierarchy`. Never file text beyond a name. */
  what: string;
  /** How many units (default 1). */
  count: number;
  where?: LedgerWhere;
  /** One short clause for the notes and the log line (`VIRTUAL read as STORED`, `kept as the table note`). */
  detail?: string;
}

type Recorder = (unit: LedgerUnit, cause: LedgerCause, what: string, where?: LedgerWhere, detail?: string, count?: number) => void;

export interface ImportLedger {
  readonly entries: LedgerEntry[];
  /** Records one entry; one already there with the same outcome, unit, cause, what, detail and place gains its count instead. */
  add(entry: Omit<LedgerEntry, 'count'> & { count?: number }): void;
  lost: Recorder;
  changed: Recorder;
  repaired: Recorder;
  skipped: Recorder;
  problem: Recorder;
  merge(other: readonly LedgerEntry[]): void;
}

const OUTCOMES: readonly LedgerOutcome[] = ['problem', 'lost', 'changed', 'repaired', 'skipped'];

/** A key for entries that are the same thing in the same place (counted together). */
function entryKey(e: Omit<LedgerEntry, 'count'>): string {
  const w = e.where ?? {};
  return [e.outcome, e.unit, e.cause, e.what, e.detail ?? '', w.file ?? '', w.line ?? '', w.table ?? '', w.column ?? ''].join('\u0000');
}

/** A where with only the keys that have a value (so entries stay small and JSON-equal). */
function cleanWhere(where: LedgerWhere | undefined): LedgerWhere | undefined {
  if (!where) return undefined;
  const out: LedgerWhere = {};
  if (where.file) out.file = where.file;
  if (typeof where.line === 'number' && Number.isFinite(where.line)) out.line = where.line;
  if (where.table) out.table = where.table;
  if (where.column) out.column = where.column;
  return Object.keys(out).length ? out : undefined;
}

/** A new ledger, optionally holding `initial` (merged, so equal entries count together). */
export function createLedger(initial: readonly LedgerEntry[] = []): ImportLedger {
  const entries: LedgerEntry[] = [];
  const index = new Map<string, LedgerEntry>();
  const add = (entry: Omit<LedgerEntry, 'count'> & { count?: number }): void => {
    const count = entry.count ?? 1;
    if (!(count > 0)) return;
    const where = cleanWhere(entry.where);
    const normalised: Omit<LedgerEntry, 'count'> = {
      outcome: entry.outcome,
      unit: entry.unit,
      cause: entry.cause,
      what: entry.what,
      ...(where ? { where } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
    };
    const key = entryKey(normalised);
    const existing = index.get(key);
    if (existing) { existing.count += count; return; }
    const stored: LedgerEntry = { ...normalised, count };
    index.set(key, stored);
    entries.push(stored);
  };
  const recorder = (outcome: LedgerOutcome): Recorder => (unit, cause, what, where, detail, count) =>
    add({ outcome, unit, cause, what, ...(where ? { where } : {}), ...(detail ? { detail } : {}), ...(count !== undefined ? { count } : {}) });
  const ledger: ImportLedger = {
    entries,
    add,
    lost: recorder('lost'),
    changed: recorder('changed'),
    repaired: recorder('repaired'),
    skipped: recorder('skipped'),
    problem: recorder('problem'),
    merge: (other) => { for (const e of other) add(e); },
  };
  ledger.merge(initial);
  return ledger;
}

/** Counts by outcome, then by unit. */
export function ledgerTotals(entries: readonly LedgerEntry[]): Record<LedgerOutcome, Partial<Record<LedgerUnit, number>>> {
  const totals: Record<LedgerOutcome, Partial<Record<LedgerUnit, number>>> = { lost: {}, changed: {}, repaired: {}, skipped: {}, problem: {} };
  for (const e of entries) {
    const byUnit = totals[e.outcome];
    if (!byUnit) continue;
    byUnit[e.unit] = (byUnit[e.unit] ?? 0) + e.count;
  }
  return totals;
}

/** Whether anything was lost or could not be read (a `lost` or `problem` entry). */
export function ledgerHasLosses(entries: readonly LedgerEntry[]): boolean {
  return entries.some((e) => (e.outcome === 'lost' || e.outcome === 'problem') && e.count > 0);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const UNIT_NOUNS: Readonly<Record<LedgerUnit, [string, string]>> = {
  file: ['file', 'files'],
  statement: ['statement', 'statements'],
  table: ['table', 'tables'],
  column: ['column', 'columns'],
  primaryKey: ['primary key', 'primary keys'],
  uniqueKey: ['unique key', 'unique keys'],
  relationship: ['relationship', 'relationships'],
  description: ['description', 'descriptions'],
  type: ['type', 'types'],
  default: ['default', 'defaults'],
  constraint: ['constraint', 'constraints'],
  setting: ['setting', 'settings'],
  object: ['object', 'objects'],
};

/** What an entry's cause says when it has no `detail` of its own. */
const CAUSE_PHRASES: Readonly<Record<LedgerCause, string>> = {
  parseError: 'could not be read',
  grammarGap: 'not in the SQL grammar',
  templatePlaceholder: 'template placeholder',
  unknownType: 'a type the SQL parser does not know',
  reservedWord: 'a reserved word used as a name',
  trailingOption: 'a table option',
  unsupportedModifier: 'a column modifier',
  proceduralBlock: 'inside a procedural block',
  notInFiles: 'not in the files',
  droppedLater: 'dropped later in the files',
  noField: 'ERD Studio has no field for it',
  notDesign: 'physical, not design',
  renamed: 'renamed',
  normalised: 'written differently',
  inferred: 'inferred',
  capped: 'over the limit',
  savedOptional: 'saved as optional',
  duplicate: 'defined twice',
  cancelled: 'the import was cancelled before it was read',
  timeLimit: 'the time limit was reached before it was read',
  other: '',
};

/** What the outcome says before the cause (`not kept`, `changed`…), when the entry has no `detail`. */
const OUTCOME_PHRASES: Readonly<Record<LedgerOutcome, string>> = {
  problem: 'could not be read',
  lost: 'not kept',
  changed: 'changed on the way',
  repaired: 'rewritten so it reads',
  skipped: 'skipped',
};

/** The longest a name, `what` or `detail` may run in a rendered line. */
const MAX_NAME = 64;
const MAX_WHAT = 60;
const MAX_DETAIL = 90;
/** Names a grouped line gives as examples. */
const EXAMPLES_SHOWN = 3;

/**
 * One line, no control characters, at most `max` characters (an ellipsis
 * when cut). `escapes`: also read a literal `\r`, `\n` or `\t` (a
 * parser's message) as a space; never for a name or a path.
 */
export function ledgerText(text: string, max: number, escapes = false): string {
  const unescaped = escapes ? text.replace(/\\[rnt]/g, ' ') : text;
  // eslint-disable-next-line no-control-regex
  const flat = unescaped.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const plural = (n: number, [one, many]: [string, string]): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function nameOf(where: LedgerWhere | undefined): string | undefined {
  if (!where?.table) return undefined;
  return ledgerText(where.column ? `${where.table}.${where.column}` : where.table, MAX_NAME);
}

function examples(names: readonly string[]): string {
  if (names.length === 0) return '';
  const head = names.slice(0, EXAMPLES_SHOWN).join(', ');
  return names.length > EXAMPLES_SHOWN ? `${head} and ${names.length - EXAMPLES_SHOWN} more` : head;
}

interface Group { outcome: LedgerOutcome; unit: LedgerUnit; cause: LedgerCause; what: string; count: number; details: Set<string>; names: string[] }

/** Entries grouped by outcome, unit, cause and `what`, in first-seen order within each outcome of `outcomes`. */
function groups(entries: readonly LedgerEntry[], outcomes: readonly LedgerOutcome[]): Group[] {
  const byKey = new Map<string, Group>();
  for (const e of entries) {
    if (!outcomes.includes(e.outcome) || !(e.count > 0)) continue;
    const key = [e.outcome, e.unit, e.cause, e.what].join('\u0000');
    let g = byKey.get(key);
    if (!g) { g = { outcome: e.outcome, unit: e.unit, cause: e.cause, what: e.what, count: 0, details: new Set(), names: [] }; byKey.set(key, g); }
    g.count += e.count;
    g.details.add(e.detail ?? '');
    const name = nameOf(e.where);
    if (name && !g.names.includes(name)) g.names.push(name);
  }
  const all = [...byKey.values()];
  return outcomes.flatMap((o) => all.filter((g) => g.outcome === o));
}

/** `73 columns: WITH TIME ZONE not kept (rental.rental_date, payment.payment_date and 71 more).` */
function groupLine(g: Group): string {
  const what = ledgerText(g.what, MAX_WHAT, true);
  const details = [...g.details];
  const detail = details.length === 1 && details[0] ? ledgerText(details[0], MAX_DETAIL, true) : '';
  const cause = CAUSE_PHRASES[g.cause];
  const phrase = detail || (cause ? `${OUTCOME_PHRASES[g.outcome]}: ${cause}` : OUTCOME_PHRASES[g.outcome]);
  const names = examples(g.names);
  return `${plural(g.count, UNIT_NOUNS[g.unit])}: ${what}${what ? ' ' : ''}${phrase}${names ? ` (${names})` : ''}.`;
}

function capped(lines: string[], max: number | undefined): string[] {
  if (max === undefined || max < 1 || lines.length <= max) return lines;
  const rest = lines.length - (max - 1);
  return [...lines.slice(0, max - 1), `And ${rest} more: ERD Studio: Show Logs lists every one.`];
}

/** What was kept but changed or rewritten on the way, one grouped and counted line each (at most `max`). */
export function ledgerNotes(entries: readonly LedgerEntry[], opts: { max?: number } = {}): string[] {
  return capped(groups(entries, ['changed', 'repaired']).map(groupLine), opts.max);
}

/** What was not imported: what could not be read first, then what was lost; grouped and counted (at most `max`). */
export function ledgerLeftOut(entries: readonly LedgerEntry[], opts: { max?: number } = {}): string[] {
  return capped(groups(entries, ['problem', 'lost']).map(groupLine), opts.max);
}

/**
 * One output-log line per entry (`Import SQL DDL: film.sql line 12: column
 * film.rating: lost (unknownType): VECTOR — kept as text`). Skipped entries
 * are logged only when they have a line (the skipped summary counts the rest).
 */
export function ledgerLogLines(entries: readonly LedgerEntry[], title: string): string[] {
  const lines: string[] = [];
  const order = (e: LedgerEntry): number => OUTCOMES.indexOf(e.outcome);
  for (const e of [...entries].sort((a, b) => order(a) - order(b))) {
    if (e.outcome === 'skipped' && e.where?.line === undefined) continue;
    const at = e.where?.file ? `${ledgerText(e.where.file, 200)}${e.where.line !== undefined ? ` line ${e.where.line}` : ''}: ` : '';
    const name = nameOf(e.where);
    const count = e.count > 1 ? `${e.count} × ` : '';
    const detail = e.detail ? ` (${ledgerText(e.detail, MAX_DETAIL, true)})` : '';
    lines.push(`${title}: ${at}${count}${UNIT_NOUNS[e.unit][0]}${name ? ` ${name}` : ''}: ${e.outcome}, ${e.cause}: ${ledgerText(e.what, MAX_WHAT, true)}${detail}`);
  }
  return lines;
}

/**
 * The one sentence every source shares for D18 (a DBML project saves every
 * relationship optional, `>?`): how many of the source's relationships were
 * required (their foreign key columns all NOT NULL; dbt: `not_null`), and how
 * many of `total` may be empty. '' when none were required.
 */
export function savedOptionalNote(requiredCount: number, total?: number): string {
  if (!(requiredCount > 0)) return '';
  const others = total !== undefined && total > requiredCount ? total - requiredCount : 0;
  const required = requiredCount === 1
    ? `1 relationship was not optional (its foreign key columns are NOT NULL)`
    : `${requiredCount.toLocaleString('en-US')} relationships were not optional (their foreign key columns are NOT NULL)`;
  const rest = others > 0 ? `; the other ${others.toLocaleString('en-US')} may be empty` : '';
  return `Every relationship is saved as optional (?: its foreign key may be empty), as ERD Studio saves them all. In the source, ${required}${rest}.`;
}
