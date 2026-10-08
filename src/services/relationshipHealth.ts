/**
 * Relationship health (#133): cheap self-checks whose only output is counts
 * and fixed codes, so the daily telemetry heartbeat can say how the
 * relationship code behaves per version without anyone filing a report.
 *
 * Two jobs:
 *
 *   - {@link checkRelationshipWrite} — after a relationship write is planned,
 *     compare the stored relationships before and after it against the
 *     invariants the exhaustive state-space checker holds the code to
 *     (`relationshipStateSpace.model.ts`: I4 canonical-after-write, I1
 *     no-silent-loss, I9 no-duplicate-entries, I2 one-line-per-link). It
 *     returns the codes of the invariants the write breaks. The caller records
 *     each as an ERROR_CODE and logs one console line; it never blocks or
 *     alters the user's edit.
 *   - {@link surveyLibrary} — on canvas open, count the states of the user's
 *     files the relationship code has to cope with (a link stored twice, a
 *     one-to-many in a model file, a target that does not exist, …).
 *
 * Both are linear in the number of stored relationships plus columns, never
 * throw, and return nothing that can carry a name: codes from a fixed list
 * and non-negative integers. `relationshipHealth.test.ts` feeds real-looking
 * names through both and asserts none comes out.
 *
 * Identity (`linkKey`) and the stored form (`canonical`) are local copies of
 * core's, as in the exhaustive checker, so a regression in core's versions
 * cannot hide itself from the check meant to catch it; a test pins that they
 * agree.
 *
 * Pure: no `vscode`, no file access. Bundled into the extension only.
 */

import { normaliseRelationshipRole } from '@erd-studio/core';
import type { Cardinality, ColumnDef, Relationship, SemanticModel } from '../types/semantic';
import type { TelemetryErrorCode, TelemetryFeature } from './telemetryPayload';

type Ends = Pick<Relationship, 'fromModel' | 'fromColumn' | 'toModel' | 'toColumn'>;

// ---------------------------------------------------------------------------
// Identity — local copies (see the header)
// ---------------------------------------------------------------------------

const end = (model: string, column: string): string => `${model}`.trim().toLowerCase() + '.' + `${column}`.trim().toLowerCase();

/** Two `model.column` ends, unordered, without case — core's `linkKey`. */
export function healthLinkKey(rel: Ends): string {
  const from = end(rel.fromModel, rel.fromColumn);
  const to = end(rel.toModel, rel.toColumn);
  return from <= to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
}

/** What a stored copy says, however it is spelled or turned: core's stored form, then its many/FK side. */
interface Fact { card: Cardinality; dir: string; role: string | undefined }

function factOf(rel: Relationship): Fact {
  const turned = rel.cardinality === 'one-to-many';
  const card: Cardinality = turned ? 'many-to-one' : rel.cardinality;
  const dir = card === 'many-to-many' ? '' : turned ? end(rel.toModel, rel.toColumn) : end(rel.fromModel, rel.fromColumn);
  return { card, dir, role: normaliseRelationshipRole(rel.role) };
}

const sameFact = (a: Fact, b: Fact): boolean => a.card === b.card && a.dir === b.dir;

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/** A model as the checks need it: its name and its library `relationships:` (columns for the survey). */
export type HealthModel = Pick<SemanticModel, 'name' | 'relationships'> & { columns?: readonly ColumnDef[] };

/**
 * The stored relationships a write can touch: the library models (at least
 * the link's two endpoint models) and the open domain file's
 * `logical.relationships`.
 */
export interface RelationshipSnapshot {
  models: readonly HealthModel[];
  domainRelationships: readonly Relationship[];
}

/**
 * The same snapshot after the planned write. Only what the write changes
 * needs to be listed: a model missing from `models` is taken as unchanged
 * from `before`, and so is the domain file when `domainRelationships` is
 * omitted. `drawn` is what the canvas would draw afterwards (the read path's
 * output), when the caller has it.
 */
export interface RelationshipSnapshotAfter {
  models?: readonly HealthModel[];
  domainRelationships?: readonly Relationship[];
  drawn?: readonly Relationship[];
}

/**
 * The write, as the user asked for it. `home` is where the link is meant to
 * be stored: one canonical copy in the model library, or one copy in the
 * open domain file (a project that keeps relationships per diagram).
 *
 * `link` is what the commit means to store — after any direction decision
 * the user made (Swap back, a two-button choice), read from either end.
 *
 *   - `add` / `edit` — `link` carries the role the dialog gave (none = no
 *     role, already normalised). `edit` names `original` when it re-keys.
 *   - `swap` — ⇄ or a cardinality change: `link` is the drawn result; the
 *     role is not part of the request and must survive.
 *   - `delete` — every copy of each of `links` goes.
 */
export type RelationshipWriteOp =
  | { kind: 'add' | 'swap' | 'edit'; home: 'library' | 'domain'; link: Relationship; original?: Ends }
  | { kind: 'delete'; links: readonly Ends[] };

/** An invariant a write broke. Fixed codes only; see {@link INVARIANT_ERROR_CODES}. */
export type RelationshipInvariant =
  /** The written link is not exactly one copy in its home, or a library copy is a one-to-many. */
  | 'notCanonical'
  /** The stored copy's cardinality or direction is not the one asked for. */
  | 'notAsIntended'
  /** The stored copy's role is not the one asked for, or a swap dropped the role it had. */
  | 'roleLost'
  /** A deleted link, or the old ends of a re-keyed one, still has a copy. */
  | 'copyLeft'
  /** Another link has no copy left anywhere. */
  | 'otherLost'
  /** Another link's cardinality, direction or role changed. */
  | 'otherChanged'
  /** A file the write changed holds one link twice where it did not before. */
  | 'duplicateInFile'
  /** The drawn result shows one link twice. */
  | 'drawnTwice'
  /** The check itself threw (malformed input); nothing else is known. */
  | 'checkFailed';

/** Each invariant's error code in the heartbeat. */
export const INVARIANT_ERROR_CODES: Readonly<Record<RelationshipInvariant, TelemetryErrorCode>> = {
  notCanonical: 'relInvNotCanonical',
  notAsIntended: 'relInvNotAsIntended',
  roleLost: 'relInvRoleLost',
  copyLeft: 'relInvCopyLeft',
  otherLost: 'relInvOtherLost',
  otherChanged: 'relInvOtherChanged',
  duplicateInFile: 'relInvDuplicateInFile',
  drawnTwice: 'relInvDrawnTwice',
  checkFailed: 'relInvCheckFailed',
};

const INVARIANT_ORDER = Object.keys(INVARIANT_ERROR_CODES) as RelationshipInvariant[];

/** A stored copy and the file it is in (`m:<lowercased model>` or `domain`). */
interface Stored { file: string; key: string; rel: Relationship }

function libraryCopies(model: HealthModel): Stored[] {
  const out: Stored[] = [];
  for (const entry of model.relationships ?? []) {
    const rel = { fromModel: model.name, ...entry } as Relationship;
    out.push({ file: `m:${model.name.toLowerCase()}`, key: healthLinkKey(rel), rel });
  }
  return out;
}

function domainCopies(rels: readonly Relationship[]): Stored[] {
  return rels.map((rel) => ({ file: 'domain', key: healthLinkKey(rel), rel }));
}

/** Every stored copy, grouped by file (insertion order) — after applying `after`'s overrides when given. */
function filesOf(before: RelationshipSnapshot, after?: RelationshipSnapshotAfter): Map<string, Stored[]> {
  const files = new Map<string, Stored[]>();
  const replaced = new Map<string, HealthModel>();
  for (const m of after?.models ?? []) replaced.set(m.name.toLowerCase(), m);
  for (const m of before.models) {
    const name = m.name.toLowerCase();
    files.set(`m:${name}`, libraryCopies(replaced.get(name) ?? m));
    replaced.delete(name);
  }
  // A model the write created (or one the caller left out of `before`).
  for (const m of replaced.values()) files.set(`m:${m.name.toLowerCase()}`, libraryCopies(m));
  files.set('domain', domainCopies(after?.domainRelationships ?? before.domainRelationships));
  return files;
}

function byKey(files: Map<string, Stored[]>): Map<string, Stored[]> {
  const out = new Map<string, Stored[]>();
  for (const copies of files.values()) {
    for (const c of copies) {
      const list = out.get(c.key);
      if (list) list.push(c);
      else out.set(c.key, [c]);
    }
  }
  return out;
}

function duplicates(copies: readonly Stored[]): number {
  return copies.length - new Set(copies.map((c) => c.key)).size;
}

/** Whether a file's entries are byte-for-byte the same list (not a question of link identity). */
function sameCopies(a: readonly Stored[], b: readonly Stored[]): boolean {
  const text = (copies: readonly Stored[]): string => JSON.stringify(copies.map(({ rel }) =>
    [rel.fromModel, rel.fromColumn, rel.toModel, rel.toColumn, rel.cardinality, rel.role ?? '']));
  return a.length === b.length && text(a) === text(b);
}

/**
 * The invariants `op` breaks, going from `before` to `after`, in a fixed
 * order and each at most once. An empty list means the write is sound.
 * Never throws: malformed input is `['checkFailed']`.
 */
export function checkRelationshipWrite(
  op: RelationshipWriteOp,
  before: RelationshipSnapshot,
  after: RelationshipSnapshotAfter,
): RelationshipInvariant[] {
  try {
    const found = new Set<RelationshipInvariant>();
    const beforeFiles = filesOf(before);
    const afterFiles = filesOf(before, after);
    const beforeByKey = byKey(beforeFiles);
    const afterByKey = byKey(afterFiles);

    // The links the user operated on; everything else must come through untouched.
    const targets = new Set<string>();
    if (op.kind === 'delete') {
      for (const link of op.links) targets.add(healthLinkKey(link));
      for (const key of targets) if ((afterByKey.get(key)?.length ?? 0) > 0) found.add('copyLeft');
    } else {
      const key = healthLinkKey(op.link);
      targets.add(key);
      if (op.original) {
        const old = healthLinkKey(op.original);
        targets.add(old);
        if (old !== key && (afterByKey.get(old)?.length ?? 0) > 0) found.add('copyLeft');
      }
      const copies = afterByKey.get(key) ?? [];
      const inHome = copies.filter((c) => (op.home === 'library' ? c.file !== 'domain' : c.file === 'domain'));
      const elsewhere = op.home === 'library' ? copies.filter((c) => c.file === 'domain') : [];
      if (inHome.length !== 1 || elsewhere.length > 0
        || (op.home === 'library' && inHome.some((c) => c.rel.cardinality === 'one-to-many'))) {
        found.add('notCanonical');
      }
      const written = inHome[0];
      if (written) {
        const got = factOf(written.rel);
        const want = factOf(op.link);
        if (!sameFact(got, want)) found.add('notAsIntended');
        if (op.kind === 'swap') {
          // The role is not part of a swap: one the link had must still be there.
          const had = (beforeByKey.get(key) ?? []).map((c) => normaliseRelationshipRole(c.rel.role)).find((r) => r !== undefined);
          if (had !== undefined && got.role === undefined) found.add('roleLost');
        } else if (got.role !== want.role) {
          found.add('roleLost');
        }
      }
    }

    // I1: no other link loses a copy's meaning (a role-less fact is covered by any role).
    for (const [key, copies] of beforeByKey) {
      if (targets.has(key)) continue;
      const now = afterByKey.get(key);
      if (!now || now.length === 0) {
        found.add('otherLost');
        continue;
      }
      const facts = now.map((c) => factOf(c.rel));
      for (const c of copies) {
        const f = factOf(c.rel);
        if (!facts.some((a) => sameFact(a, f) && (f.role === undefined || a.role === f.role))) {
          found.add('otherChanged');
          break;
        }
      }
    }

    // I9: a file the write changed gains no duplicate entry.
    for (const [file, now] of afterFiles) {
      const was = beforeFiles.get(file) ?? [];
      if (sameCopies(was, now)) continue;
      if (duplicates(now) > duplicates(was)) found.add('duplicateInFile');
    }

    // I2: one line per link.
    if (after.drawn && drawnTwiceCount(after.drawn) > 0) found.add('drawnTwice');

    return INVARIANT_ORDER.filter((code) => found.has(code));
  } catch {
    return ['checkFailed'];
  }
}

/** How many extra lines `drawn` shows for links it already shows (0 when each link is drawn once). */
export function drawnTwiceCount(drawn: readonly Ends[]): number {
  try {
    return drawn.length - new Set(drawn.map(healthLinkKey)).size;
  } catch {
    return 0;
  }
}

/** The heartbeat error codes for `invariants`, in the same order. */
export function invariantErrorCodes(invariants: readonly RelationshipInvariant[]): TelemetryErrorCode[] {
  return invariants.map((code) => INVARIANT_ERROR_CODES[code] ?? 'relInvCheckFailed');
}

// ---------------------------------------------------------------------------
// Survey (canvas open)
// ---------------------------------------------------------------------------

/**
 * Counts of the states the user's relationships are in. Every field is a
 * number of links (or entries) — never which ones.
 */
export interface RelationshipSurvey {
  /** Links with more than one stored copy (in one file, or across files). */
  storedTwice: number;
  /** Model-file entries stored as `one-to-many` (their home is the other model's file). */
  oneToManyInModelFile: number;
  /**
   * Model-file `many-to-one` entries stored backwards: they leave their
   * model's whole key for a column that is not the target's whole key, where
   * the target declares a different whole key (the Move's turn-round rule).
   */
  backwards: number;
  /** Entries whose other model (or, in a domain file, either model) does not exist. */
  danglingModel: number;
  /** Entries whose models exist but a column at either end does not. */
  danglingColumn: number;
  /** Relationship entries the reader could not use (skipped or defaulted). */
  unreadable: number;
  /** Composite groups missing a member, or whose members do not join the same two models. */
  partialComposite: number;
  /** Entries whose model or column is spelled in another case than the real name. */
  caseRespelled: number;
  /** Domain-file copies of a link the model library also stores. */
  domainCopyOfLibrary: number;
}

export interface SurveyOptions {
  /** Relationship entries the reader skipped or defaulted, counted by the caller (see {@link countUnreadableEntries}). */
  unreadableEntries?: number;
  /** The composite group a stored relationship belongs to, if composite links are stored that way. */
  compositeGroupOf?: (rel: Relationship) => string | undefined;
}

/** A model's key columns: a whole key is exactly one primary-key column (else one natural-key column). */
function wholeKeyOf(columns: readonly ColumnDef[] | undefined): string | undefined {
  if (!columns) return undefined;
  const pk = columns.filter((c) => c.isPrimaryKey);
  if (pk.length === 1) return pk[0].name.toLowerCase();
  if (pk.length > 1) return undefined;
  const nk = columns.filter((c) => c.isNaturalKey);
  return nk.length === 1 ? nk[0].name.toLowerCase() : undefined;
}

interface ModelInfo { name: string; columns: Map<string, string> | undefined; wholeKey: string | undefined }

/**
 * The relationship states of a project: `models` is the model library (or
 * a v4 domain's inline models, with no `relationships`), `domainRelationships`
 * the open domain file's. Linear; never throws (a failure is an empty survey).
 */
export function surveyLibrary(
  models: readonly HealthModel[],
  domainRelationships: readonly Relationship[],
  options: SurveyOptions = {},
): RelationshipSurvey {
  const survey: RelationshipSurvey = {
    storedTwice: 0,
    oneToManyInModelFile: 0,
    backwards: 0,
    danglingModel: 0,
    danglingColumn: 0,
    unreadable: 0,
    partialComposite: 0,
    caseRespelled: 0,
    domainCopyOfLibrary: 0,
  };
  try {
    const info = new Map<string, ModelInfo>();
    for (const m of models) {
      const cols = m.columns ? new Map(m.columns.map((c) => [c.name.toLowerCase(), c.name] as const)) : undefined;
      info.set(m.name.toLowerCase(), { name: m.name, columns: cols, wholeKey: wholeKeyOf(m.columns) });
      // A host that reports unread entries per model (`relationshipIssues`) adds them here.
      const issues = (m as { relationshipIssues?: unknown }).relationshipIssues;
      if (Array.isArray(issues)) survey.unreadable += issues.length;
    }
    survey.unreadable += Math.max(0, Math.floor(options.unreadableEntries ?? 0));

    const library: Stored[] = models.flatMap(libraryCopies);
    const domain = domainCopies(domainRelationships);

    const copiesPerKey = new Map<string, number>();
    for (const c of [...library, ...domain]) copiesPerKey.set(c.key, (copiesPerKey.get(c.key) ?? 0) + 1);
    for (const n of copiesPerKey.values()) if (n > 1) survey.storedTwice++;

    const libraryKeys = new Set(library.map((c) => c.key));
    for (const c of domain) if (libraryKeys.has(c.key)) survey.domainCopyOfLibrary++;

    const groups = new Map<string, { size: number; pair: string; broken: boolean }>();

    for (const c of [...library, ...domain]) {
      const rel = c.rel;
      const from = info.get(rel.fromModel.toLowerCase());
      const to = info.get(rel.toModel.toLowerCase());
      let dangling = false;
      if (!from || !to) {
        survey.danglingModel++;
        dangling = true;
      } else if ((from.columns && !from.columns.has(rel.fromColumn.toLowerCase()))
        || (to.columns && !to.columns.has(rel.toColumn.toLowerCase()))) {
        survey.danglingColumn++;
        dangling = true;
      }
      if (from && to && (from.name !== rel.fromModel || to.name !== rel.toModel
        || (from.columns?.get(rel.fromColumn.toLowerCase()) ?? rel.fromColumn) !== rel.fromColumn
        || (to.columns?.get(rel.toColumn.toLowerCase()) ?? rel.toColumn) !== rel.toColumn)) {
        survey.caseRespelled++;
      }
      if (c.file !== 'domain') {
        if (rel.cardinality === 'one-to-many') survey.oneToManyInModelFile++;
        else if (rel.cardinality === 'many-to-one' && from && to && !dangling
          && from.wholeKey === rel.fromColumn.toLowerCase()
          && to.wholeKey !== undefined && to.wholeKey !== rel.toColumn.toLowerCase()) {
          survey.backwards++;
        }
      }
      const group = options.compositeGroupOf?.(rel);
      if (group !== undefined) {
        const id = `${c.file}\u0000${group}`;
        const pair = [rel.fromModel.toLowerCase(), rel.toModel.toLowerCase()].sort().join('\u0000');
        const g = groups.get(id);
        if (g) {
          g.size++;
          if (g.pair !== pair) g.broken = true;
          if (dangling) g.broken = true;
        } else {
          groups.set(id, { size: 1, pair, broken: dangling });
        }
      }
    }
    for (const g of groups.values()) if (g.broken || g.size < 2) survey.partialComposite++;
    return survey;
  } catch {
    return { ...survey };
  }
}

/**
 * How many entries of a raw `relationships:` value (the YAML as parsed, before
 * the reader) the reader skips or defaults: not a map, an end missing or not
 * text, or a cardinality it does not know. Mirrors core's `readRelationships`.
 */
export function countUnreadableEntries(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  const known = new Set(['many-to-one', 'one-to-one', 'one-to-many', 'many-to-many']);
  let n = 0;
  for (const entry of raw) {
    const r = entry as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || Array.isArray(r)) { n++; continue; }
    const ok = ['fromColumn', 'toModel', 'toColumn'].every((k) => typeof r[k] === 'string' && r[k] !== '');
    if (!ok || !(typeof r.cardinality === 'string' && known.has(r.cardinality))) n++;
  }
  return n;
}

/** Each survey count's feature key: recorded at most once a day (a presence flag). */
export const SURVEY_FEATURES: Readonly<Record<keyof RelationshipSurvey, TelemetryFeature>> = {
  storedTwice: 'relStateStoredTwice',
  oneToManyInModelFile: 'relStateOneToMany',
  backwards: 'relStateBackwards',
  danglingModel: 'relStateDanglingModel',
  danglingColumn: 'relStateDanglingColumn',
  unreadable: 'relStateUnreadable',
  partialComposite: 'relStatePartialComposite',
  caseRespelled: 'relCaseRespelled',
  domainCopyOfLibrary: 'relStateDomainCopy',
};

/** The feature keys for the non-zero counts of `survey`, in a fixed order. */
export function surveyFeatures(survey: RelationshipSurvey): TelemetryFeature[] {
  return (Object.keys(SURVEY_FEATURES) as Array<keyof RelationshipSurvey>)
    .filter((k) => typeof survey[k] === 'number' && survey[k] > 0)
    .map((k) => SURVEY_FEATURES[k]);
}
