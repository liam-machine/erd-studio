/**
 * Relationship health (#133): cheap self-checks whose only output is fixed
 * codes and counts, so the daily telemetry heartbeat can say how the
 * relationship code behaves per version without anyone filing a report.
 *
 *   - {@link auditRelationshipWrite} — run by the provider's
 *     `commitRelationshipWrite` on the planned result of `planRelationshipWrite`,
 *     before `applyEdit`: the invariants the plan breaks
 *     ({@link checkRelationshipWrite}, the exhaustive checker's I4 / I1 / I9 /
 *     I2, extended to composite keys) and which new behaviours the edit used
 *     ({@link relationshipWriteUsage}). The caller records them and logs one
 *     console line; it never blocks or alters the edit.
 *   - {@link checkLibraryRewrite} — the same idea for the Move command's
 *     model-file rewrites; {@link moveUsage} names the steps a Move took.
 *   - {@link surveyLibrary} — on canvas open, count the states of the user's
 *     files the relationship code copes with (a link stored twice, a
 *     one-to-many in a model file, a target that does not exist, …).
 *
 * All are linear in the stored relationships plus columns, never throw, and
 * return nothing that can carry a name: codes from fixed lists and
 * non-negative integers. `relationshipHealth.test.ts` feeds real-looking names
 * through every function and asserts none comes out.
 *
 * Link identity ({@link healthLinkKey}) and what a copy says (`factOf`) are
 * local copies, as in the exhaustive checker, so a regression in core's
 * versions cannot hide itself from the check meant to catch it; a test pins
 * that they agree. Validity rules that are definitions rather than identity —
 * a composite group (`compositeGroupProblem`), key evidence
 * (`contradictsKeysOf`, `orientLink`), spelling (`respellRelationship`) — are
 * core's, so the checks mean what the product means.
 *
 * Pure: no `vscode`, no file access. Bundled into the extension only.
 */

import {
  compositeGroupProblem,
  contradictsKeysOf,
  linkEnd,
  mergeLibraryRelationships,
  normaliseCompositeKey,
  normaliseRelationshipRole,
  orientLink,
  respellRelationship,
} from '@erd-studio/core';
import type { DbtKeyIndex, KeyedModel } from '@erd-studio/core';
import type {
  MoveToLibraryPlan,
  RelationshipWriteInput,
  RelationshipWriteOp,
  RelationshipWritePlan,
} from './libraryRelationships';
import type { Cardinality, ColumnDef, Relationship, SemanticModel } from '../types/semantic';
import type { TelemetryErrorCode, TelemetryFeature } from './telemetryPayload';

type Ends = Pick<Relationship, 'fromModel' | 'fromColumn' | 'toModel' | 'toColumn'>;

// ---------------------------------------------------------------------------
// Identity — local copies (see the header)
// ---------------------------------------------------------------------------

const end = (model: string, column: string): string => `${model}`.trim().toLowerCase() + '.' + `${column}`.trim().toLowerCase();
const lower = (s: string): string => `${s}`.toLowerCase();

/** Two `model.column` ends, unordered, without case — core's `linkKey`. */
export function healthLinkKey(rel: Ends): string {
  const from = end(rel.fromModel, rel.fromColumn);
  const to = end(rel.toModel, rel.toColumn);
  return from <= to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
}

/** What a stored copy says, however it is spelled or turned: cardinality as stored, its many/FK side, role, group name. */
interface Fact { card: Cardinality; dir: string; role: string | undefined; group: string | undefined }

function factOf(rel: Relationship): Fact {
  const turned = rel.cardinality === 'one-to-many';
  const card: Cardinality = turned ? 'many-to-one' : rel.cardinality;
  const dir = card === 'many-to-many' ? '' : turned ? end(rel.toModel, rel.toColumn) : end(rel.fromModel, rel.fromColumn);
  const group = normaliseCompositeKey(rel.compositeKey);
  return { card, dir, role: normaliseRelationshipRole(rel.role), group: group === undefined ? undefined : lower(group) };
}

const sameFact = (a: Fact, b: Fact): boolean => a.card === b.card && a.dir === b.dir;

/** The many side's model of a copy (its stored owner): from-model, or to-model for a one-to-many. */
const ownerOf = (rel: Relationship): string => lower(rel.cardinality === 'one-to-many' ? rel.toModel : rel.fromModel);

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/** A model as the checks need it: its name, its library `relationships:`, and (for key checks) its columns. */
export type HealthModel = Pick<SemanticModel, 'name' | 'relationships'> & { columns?: readonly ColumnDef[] };

/** The stored relationships before a write: the library models and the open domain file's `logical.relationships`. */
export interface RelationshipSnapshot {
  home: 'library' | 'domain';
  models: readonly HealthModel[];
  domainRelationships: readonly Relationship[];
  /** dbt's key evidence, as the read path used it (decides which copy of a link is drawn). */
  dbt?: DbtKeyIndex;
}

/**
 * The same after the planned write. Only what the write changes needs to be
 * listed: a model missing from `models` is unchanged, and so is the domain
 * file when `domainRelationships` is omitted. `drawn` is what the canvas would
 * draw afterwards, when known. `inlineMarkKey` is set when a `markKey` went to
 * a v4 domain's inline model (not visible here).
 */
export interface RelationshipSnapshotAfter {
  models?: readonly HealthModel[];
  domainRelationships?: readonly Relationship[];
  drawn?: readonly Relationship[];
  inlineMarkKey?: boolean;
}

/** An invariant a write broke. Fixed codes only; see {@link INVARIANT_ERROR_CODES}. */
export type RelationshipInvariant =
  /** A written link is not exactly one copy in its home, or a library copy is a one-to-many. */
  | 'notCanonical'
  /** The stored copy's cardinality or direction is not the one asked for. */
  | 'notAsIntended'
  /** The stored copy's role is not the one asked for, or ⇄ dropped the role it had. */
  | 'roleLost'
  /** A deleted link (or composite member), or the old ends of a re-keyed one, still has a copy. */
  | 'copyLeft'
  /** Another link has no copy left. */
  | 'otherLost'
  /** Another link's cardinality, direction, role or composite key changed. */
  | 'otherChanged'
  /** A file the write changed holds one link twice where it did not before. */
  | 'duplicateInFile'
  /** The drawn result shows one link twice. */
  | 'drawnTwice'
  /** The check itself threw (malformed input); nothing else is known. */
  | 'checkFailed'
  /** A composite key written, swapped or moved is not one valid group afterwards. */
  | 'groupBroken'
  /** "Mark as primary key" asked for a key the written model does not flag. */
  | 'keyNotMarked';

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
  groupBroken: 'relInvGroupBroken',
  keyNotMarked: 'relInvKeyNotMarked',
};

const INVARIANT_ORDER = Object.keys(INVARIANT_ERROR_CODES) as RelationshipInvariant[];

/** A stored copy and the file it is in (`m:<lowercased model>` or `domain`). */
interface Stored { file: string; key: string; rel: Relationship }

const isEnds = (r: unknown): r is Relationship => !!r && typeof r === 'object'
  && ['fromModel', 'fromColumn', 'toModel', 'toColumn'].every((k) => typeof (r as Record<string, unknown>)[k] === 'string');

function libraryCopies(model: HealthModel): Stored[] {
  const out: Stored[] = [];
  for (const entry of model.relationships ?? []) {
    const rel = { fromModel: model.name, ...entry } as Relationship;
    if (isEnds(rel)) out.push({ file: `m:${lower(model.name)}`, key: healthLinkKey(rel), rel });
  }
  return out;
}

function domainCopies(rels: readonly Relationship[]): Stored[] {
  return rels.filter(isEnds).map((rel) => ({ file: 'domain', key: healthLinkKey(rel), rel }));
}

/** Every stored copy, by file (insertion order), after applying `after`'s overrides when given. */
function filesOf(models: readonly HealthModel[], domain: readonly Relationship[] | undefined, after?: RelationshipSnapshotAfter): Map<string, Stored[]> {
  const files = new Map<string, Stored[]>();
  const replaced = new Map<string, HealthModel>();
  for (const m of after?.models ?? []) replaced.set(lower(m.name), m);
  for (const m of models) {
    const name = lower(m.name);
    files.set(`m:${name}`, libraryCopies(replaced.get(name) ?? m));
    replaced.delete(name);
  }
  for (const m of replaced.values()) files.set(`m:${lower(m.name)}`, libraryCopies(m));
  if (domain) files.set('domain', domainCopies(after?.domainRelationships ?? domain));
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

/**
 * The valid composite groups in `files`, as `compositeGroupProblem` defines
 * them: per file, the entries sharing a `compositeKey` (without case) and a
 * many-side model, one per link. Returns each member link's group id.
 */
function groupIndex(files: Map<string, Stored[]>): { groupOf: Map<string, string>; members: Map<string, Stored[]> } {
  const buckets = new Map<string, Stored[]>();
  for (const [file, copies] of files) {
    for (const c of copies) {
      const ck = normaliseCompositeKey(c.rel.compositeKey);
      if (ck === undefined) continue;
      const id = `${file}\u0000${lower(ck)}\u0000${ownerOf(c.rel)}`;
      const list = buckets.get(id) ?? [];
      if (!list.some((x) => x.key === c.key)) list.push(c);
      buckets.set(id, list);
    }
  }
  const groupOf = new Map<string, string>();
  const members = new Map<string, Stored[]>();
  for (const [id, list] of buckets) {
    if (compositeGroupProblem(list.map((c) => c.rel)) !== null) continue;
    members.set(id, list);
    for (const c of list) if (!groupOf.has(c.key)) groupOf.set(c.key, id);
  }
  return { groupOf, members };
}

/**
 * The composite groups the canvas draws before a write — core's read path,
 * then the drawn lines sharing a `compositeKey` and both models, as the
 * planner's `drawnGroupOf` finds the group an edit acts on (a file holding a
 * valid and an invalid group of one name draws singles). Member keys by key.
 */
function drawnGroups(before: RelationshipSnapshot): Map<string, string[]> {
  const lines = mergeLibraryRelationships(
    (before.home === 'library' ? before.models : []) as SemanticModel[], before.domainRelationships, '', undefined, before.dbt,
  );
  const buckets = new Map<string, string[]>();
  for (const line of lines) {
    const ck = normaliseCompositeKey(line.compositeKey);
    if (ck === undefined) continue;
    const id = `${lower(ck)}\u0000${lower(line.fromModel)}\u0000${lower(line.toModel)}`;
    buckets.set(id, [...(buckets.get(id) ?? []), healthLinkKey(line)]);
  }
  const out = new Map<string, string[]>();
  for (const keys of buckets.values()) if (keys.length >= 2) for (const k of keys) out.set(k, keys);
  return out;
}

/** `key` and every other member of the drawn group it belongs to. */
function withGroup(key: string, groups: Map<string, string[]>): string[] {
  return groups.get(key) ?? [key];
}

function duplicates(copies: readonly Stored[]): number {
  return copies.length - new Set(copies.map((c) => c.key)).size;
}

/** Whether a file's entries are the same list (not a question of link identity). */
function sameCopies(a: readonly Stored[], b: readonly Stored[]): boolean {
  const text = (copies: readonly Stored[]): string => JSON.stringify(copies.map(({ rel }) =>
    [rel.fromModel, rel.fromColumn, rel.toModel, rel.toColumn, rel.cardinality, rel.role ?? '', rel.compositeKey ?? '']));
  return a.length === b.length && text(a) === text(b);
}

/** I9: a file that changed gains no duplicate entry. */
function newDuplicates(before: Map<string, Stored[]>, after: Map<string, Stored[]>): boolean {
  for (const [file, now] of after) {
    const was = before.get(file) ?? [];
    if (!sameCopies(was, now) && duplicates(now) > duplicates(was)) return true;
  }
  return false;
}

/** I1: every link not in `targets` keeps a copy saying what each of its copies said. */
function otherLinks(beforeByKey: Map<string, Stored[]>, afterByKey: Map<string, Stored[]>, targets: ReadonlySet<string>, found: Set<RelationshipInvariant>): void {
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
      // A role-less (or group-less) fact is covered by any.
      if (!facts.some((a) => sameFact(a, f) && (f.role === undefined || a.role === f.role) && (f.group === undefined || a.group === f.group))) {
        found.add('otherChanged');
        break;
      }
    }
  }
}

/** The written members are one valid group: one copy each, one shared composite key, one file. */
function isOneGroup(keys: readonly string[], afterByKey: Map<string, Stored[]>, inHome: (c: Stored) => boolean): boolean {
  const copies = keys.map((k) => (afterByKey.get(k) ?? []).filter(inHome));
  if (copies.some((c) => c.length !== 1)) return false;
  const rels = copies.map((c) => c[0]);
  const ck = normaliseCompositeKey(rels[0].rel.compositeKey);
  return ck !== undefined
    && rels.every((c) => c.file === rels[0].file && lower(normaliseCompositeKey(c.rel.compositeKey) ?? '') === lower(ck))
    && compositeGroupProblem(rels.map((c) => c.rel)) === null;
}

/**
 * The invariants the planned relationship write breaks, in a fixed order and
 * each at most once; empty when the plan is sound. `op` is the planner's own
 * (`planRelationshipWrite`). One edge of a composite stands for its group: a
 * delete must remove every member, ⇄ must keep the group whole. Never throws:
 * malformed input is `['checkFailed']`.
 */
export function checkRelationshipWrite(
  op: RelationshipWriteOp,
  before: RelationshipSnapshot,
  after: RelationshipSnapshotAfter,
): RelationshipInvariant[] {
  try {
    const found = new Set<RelationshipInvariant>();
    const beforeFiles = filesOf(before.models, before.domainRelationships);
    const afterFiles = filesOf(before.models, before.domainRelationships, after);
    const beforeByKey = byKey(beforeFiles);
    const afterByKey = byKey(afterFiles);
    const groups = drawnGroups(before);
    const library = before.home === 'library';
    const inHome = (c: Stored): boolean => (library ? c.file !== 'domain' : c.file === 'domain');

    const targets = new Set<string>();
    if (op.kind === 'remove') {
      for (const k of op.keys) for (const key of withGroup(healthLinkKey(k), groups)) targets.add(key);
      for (const key of targets) if ((afterByKey.get(key)?.length ?? 0) > 0) found.add('copyLeft');
    } else {
      const anchor: Relationship = op.kind === 'update' ? { ...op.ends, cardinality: op.cardinality } : op.drawn;
      const anchorKey = healthLinkKey(anchor);
      const members = op.kind === 'update'
        ? withGroup(anchorKey, groups)
        : [anchorKey, ...(op.extraPairs ?? []).map((p) => healthLinkKey({ ...op.drawn, fromColumn: p.fromColumn, toColumn: p.toColumn }))];
      const original = op.kind === 'update' ? members : op.kind === 'edit' ? withGroup(healthLinkKey(op.original), groups) : [];
      for (const key of [...members, ...original]) targets.add(key);
      for (const key of original) if (!members.includes(key) && (afterByKey.get(key)?.length ?? 0) > 0) found.add('copyLeft');

      for (const key of members) {
        const copies = afterByKey.get(key) ?? [];
        const home = copies.filter(inHome);
        if (home.length !== 1 || copies.length !== home.length || (library && home.some((c) => c.rel.cardinality === 'one-to-many'))) {
          found.add('notCanonical');
        }
      }
      if (members.length > 1 && !isOneGroup(members, afterByKey, inHome)) found.add('groupBroken');

      const written = (afterByKey.get(anchorKey) ?? []).find(inHome);
      if (written) {
        const got = factOf(written.rel);
        const want = factOf(anchor);
        if (!sameFact(got, want)) found.add('notAsIntended');
        const beforeRoles = original.concat(members)
          .flatMap((key) => (beforeByKey.get(key) ?? []).map((c) => normaliseRelationshipRole(c.rel.role)))
          .filter((r): r is string => r !== undefined);
        if (op.kind === 'update') {
          // ⇄ carries no role: one the link had must still be there.
          if (beforeRoles.length > 0 && got.role === undefined) found.add('roleLost');
        } else if (want.role !== undefined || op.kind === 'edit') {
          if (got.role !== want.role) found.add('roleLost');
        } else if (got.role !== undefined && !beforeRoles.includes(got.role)) {
          // An add without a role may only take one a copy it absorbed had.
          found.add('roleLost');
        }
      }

      if (op.kind !== 'update' && op.markKey && !after.inlineMarkKey) {
        const model = (after.models ?? []).find((m) => lower(m.name) === lower(op.markKey!.model));
        const cols = model?.columns ?? [];
        if (!op.markKey.columns.every((name) => cols.some((c) => lower(c.name) === lower(name) && c.isPrimaryKey))) found.add('keyNotMarked');
      }
    }

    otherLinks(beforeByKey, afterByKey, targets, found);
    if (newDuplicates(beforeFiles, afterFiles)) found.add('duplicateInFile');
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
// Usage of the new behaviour, read from the op and its plan
// ---------------------------------------------------------------------------

/** A model lookup for key evidence, without case. */
function modelLookup(models: readonly KeyedModel[]): (name: string) => KeyedModel | undefined {
  const byName = new Map<string, KeyedModel>();
  for (const m of models) if (typeof m.name === 'string' && !byName.has(lower(m.name))) byName.set(lower(m.name), m);
  return (name) => byName.get(lower(name));
}

/**
 * Which new relationship behaviours a successful write used. `keyModels` are
 * the models whose key flags the dialog read (the library, or a v4 domain's
 * inline models). Never throws.
 */
export function relationshipWriteUsage(
  op: RelationshipWriteOp,
  before: RelationshipSnapshot,
  after: RelationshipSnapshotAfter,
  keyModels?: readonly KeyedModel[],
  dbt?: DbtKeyIndex,
): TelemetryFeature[] {
  const out: TelemetryFeature[] = [];
  try {
    const library = before.home === 'library';
    if (op.kind === 'remove') {
      const groups = drawnGroups(before);
      const beforeByKey = byKey(filesOf(before.models, before.domainRelationships));
      const keys = new Set(op.keys.flatMap((k) => withGroup(healthLinkKey(k), groups)));
      const copies = [...keys].reduce((n, key) => n + (beforeByKey.get(key)?.length ?? 0), 0);
      if (copies > keys.size) out.push('relDeleteCopies');
      return out;
    }
    if (op.kind === 'update') {
      if (!library) return out;
      const key = healthLinkKey(op.ends);
      const was = byKey(filesOf(before.models, before.domainRelationships)).get(key)?.filter((c) => c.file !== 'domain').map((c) => c.file) ?? [];
      const now = byKey(filesOf(before.models, before.domainRelationships, after)).get(key)?.filter((c) => c.file !== 'domain').map((c) => c.file) ?? [];
      if (now.some((f) => !was.includes(f))) out.push('relSwapMoved');
      return out;
    }
    const drawn = op.drawn;
    const members: Relationship[] = [drawn, ...(op.extraPairs ?? []).map((p) => ({ ...drawn, fromColumn: p.fromColumn, toColumn: p.toColumn }))];
    const modelOf = modelLookup(keyModels ?? (before.models as readonly KeyedModel[]));
    if (op.kind === 'add' && library && drawn.cardinality === 'one-to-many') out.push('relDragTurned');
    const role = normaliseRelationshipRole(drawn.role);
    if (role !== undefined) {
      const key = healthLinkKey(op.kind === 'edit' ? op.original : drawn);
      const had = byKey(filesOf(before.models, before.domainRelationships)).get(key) ?? [];
      if (!had.some((c) => normaliseRelationshipRole(c.rel.role) === role)) out.push('relRoleSet');
    }
    if (contradictsKeysOf(members, modelOf, dbt)) out.push('relCreateAnyway');
    if (op.kind === 'add' && drawn.cardinality !== 'many-to-many') {
      const fromEnd = linkEnd(drawn.fromModel, modelOf(drawn.fromModel), members.map((m) => m.fromColumn), { dbt });
      const toEnd = linkEnd(drawn.toModel, modelOf(drawn.toModel), members.map((m) => m.toColumn), { dbt });
      if (!orientLink(fromEnd, toEnd).decided) out.push('relDirectionAsked');
    }
    if (op.markKey) out.push('relMarkKey');
    if (members.length > 1) out.push('relComposite');
    if (lower(drawn.fromModel) === lower(drawn.toModel)) out.push('relSelfReference');
  } catch {
    // Usage is a nicety: a failure records nothing.
  }
  return out;
}

/** The result of one audited write: usage features and broken invariants, codes only. */
export interface RelationshipAudit {
  usage: TelemetryFeature[];
  broken: RelationshipInvariant[];
}

/**
 * Audit a successful plan of `planRelationshipWrite(op, input)`: the
 * invariants it breaks (with what the canvas would draw afterwards) and the
 * behaviours it uses. `keyModels` as in {@link relationshipWriteUsage}.
 * Never throws.
 */
export function auditRelationshipWrite(
  op: RelationshipWriteOp,
  input: RelationshipWriteInput,
  plan: RelationshipWritePlan,
  keyModels?: readonly KeyedModel[],
): RelationshipAudit {
  try {
    if (!plan.ok) return { usage: [], broken: [] };
    const before: RelationshipSnapshot = { home: input.home, models: input.models, domainRelationships: input.domainRelationships, dbt: input.dbt };
    const changed = new Map(plan.changed.map((m) => [lower(m.name), m] as const));
    const afterModels = input.models.map((m) => changed.get(lower(m.name)) ?? m);
    const afterDomain = plan.domainRelationships ?? input.domainRelationships;
    let drawn: Relationship[] | undefined;
    try {
      drawn = mergeLibraryRelationships(input.home === 'library' ? afterModels : [], afterDomain, '', undefined, input.dbt);
    } catch {
      drawn = undefined;
    }
    const after: RelationshipSnapshotAfter = {
      models: plan.changed,
      ...(plan.domainRelationships ? { domainRelationships: plan.domainRelationships } : {}),
      ...(drawn ? { drawn } : {}),
      ...(plan.inlineMarkKey ? { inlineMarkKey: true } : {}),
    };
    return {
      broken: checkRelationshipWrite(op, before, after),
      usage: relationshipWriteUsage(op, before, after, keyModels ?? input.models, input.dbt),
    };
  } catch {
    return { usage: [], broken: ['checkFailed'] };
  }
}

// ---------------------------------------------------------------------------
// Move Relationships
// ---------------------------------------------------------------------------

/**
 * The invariants a rewrite of model files breaks (the Move command):
 * `before` are the files' models as read, `after` the same models as they
 * will be written, `placed` the links the plan puts in the library (each must
 * end as exactly one canonical copy among these files). No library link may
 * vanish, no file may gain a duplicate, and every valid composite group stays
 * one group. Never throws.
 */
export function checkLibraryRewrite(
  before: readonly HealthModel[],
  after: readonly HealthModel[],
  placed: readonly Ends[],
): RelationshipInvariant[] {
  try {
    const found = new Set<RelationshipInvariant>();
    const beforeFiles = filesOf(before, undefined);
    const afterFiles = filesOf(before, undefined, { models: after });
    const beforeByKey = byKey(beforeFiles);
    const afterByKey = byKey(afterFiles);
    for (const key of beforeByKey.keys()) if (!afterByKey.has(key)) found.add('otherLost');
    for (const p of placed) {
      const copies = afterByKey.get(healthLinkKey(p)) ?? [];
      if (copies.length !== 1 || copies[0].rel.cardinality === 'one-to-many') found.add('notCanonical');
    }
    if (newDuplicates(beforeFiles, afterFiles)) found.add('duplicateInFile');
    const was = groupIndex(beforeFiles);
    const now = groupIndex(afterFiles);
    for (const list of was.members.values()) {
      const ids = new Set(list.map((c) => now.groupOf.get(c.key)));
      if (ids.size !== 1 || ids.has(undefined)) found.add('groupBroken');
    }
    return INVARIANT_ORDER.filter((code) => found.has(code));
  } catch {
    return ['checkFailed'];
  }
}

/** The Move steps a completed run took, once each. */
export function moveUsage(plan: Pick<MoveToLibraryPlan, 'rehome' | 'turned' | 'disagreements' | 'lockedFiles' | 'keptLibrary' | 'leftGroups'>): TelemetryFeature[] {
  const out: TelemetryFeature[] = [];
  try {
    if (plan.rehome.some((r) => r.stored.cardinality === 'one-to-many')) out.push('relMoveRehomed');
    if (plan.rehome.some((r) => r.stored.cardinality !== 'one-to-many') || plan.turned.length > 0) out.push('relMoveTurned');
    if (plan.disagreements.length > 0) out.push('relMoveDisagreementLeft');
    if (plan.lockedFiles.length > 0) out.push('relMoveFileLocked');
    if (plan.keptLibrary.length > 0) out.push('relMoveKeptLibrary');
    if (plan.leftGroups.length > 0) out.push('relMoveGroupLeft');
  } catch {
    // A malformed plan records nothing.
  }
  return out;
}

// ---------------------------------------------------------------------------
// Survey (canvas open)
// ---------------------------------------------------------------------------

/**
 * Counts of the states the user's relationships are in. Every field is a
 * number of links, entries or groups — never which ones.
 */
export interface RelationshipSurvey {
  /** Links with more than one stored copy (in one file, or across files). */
  storedTwice: number;
  /** Model-file entries stored as `one-to-many` (their home is the other model's file). */
  oneToManyInModelFile: number;
  /** Model-file `many-to-one` entries the keys contradict (`contradictsKeysOf`): stored backwards. */
  backwards: number;
  /** Entries whose other model (or, in a domain file, either model) does not exist. */
  danglingModel: number;
  /** Entries whose models exist but a column at either end does not. */
  danglingColumn: number;
  /** Relationship entries the reader could not use, as counted by the caller. */
  unreadable: number;
  /** Composite groups (entries sharing a `compositeKey`) that `compositeGroupProblem` rejects. */
  partialComposite: number;
  /** Entries whose model or column is spelled in another case than the real name (`respellRelationship`). */
  caseRespelled: number;
  /** Domain-file copies of a link the model library also stores. */
  domainCopyOfLibrary: number;
}

export interface SurveyOptions {
  /** Relationship entries the reader skipped or defaulted, counted by the caller (see {@link countUnreadableEntries}). */
  unreadableEntries?: number;
  /** dbt's key evidence, for models that flag no key. */
  dbt?: DbtKeyIndex;
}

const emptySurvey = (): RelationshipSurvey => ({
  storedTwice: 0,
  oneToManyInModelFile: 0,
  backwards: 0,
  danglingModel: 0,
  danglingColumn: 0,
  unreadable: 0,
  partialComposite: 0,
  caseRespelled: 0,
  domainCopyOfLibrary: 0,
});

/**
 * The relationship states of a project: `models` is the model library (or a
 * v4 domain's inline models), `domainRelationships` the open domain file's.
 * Linear; never throws (a failure is an empty survey).
 */
export function surveyLibrary(
  models: readonly HealthModel[],
  domainRelationships: readonly Relationship[],
  options: SurveyOptions = {},
): RelationshipSurvey {
  const survey = emptySurvey();
  try {
    const info = new Map<string, { columns: Set<string> | undefined }>();
    for (const m of models) {
      if (typeof m?.name !== 'string') continue;
      const cols = m.columns ? new Set(m.columns.filter((c) => typeof c?.name === 'string').map((c) => lower(c.name))) : undefined;
      if (!info.has(lower(m.name))) info.set(lower(m.name), { columns: cols });
    }
    survey.unreadable = Math.max(0, Math.floor(options.unreadableEntries ?? 0));
    const modelOf = modelLookup(models as readonly KeyedModel[]);

    const files = filesOf(models.filter((m) => typeof m?.name === 'string'), domainRelationships ?? []);
    const library = [...files.entries()].filter(([f]) => f !== 'domain').flatMap(([, c]) => c);
    const domain = files.get('domain') ?? [];

    for (const copies of byKey(files).values()) if (copies.length > 1) survey.storedTwice++;
    const libraryKeys = new Set(library.map((c) => c.key));
    for (const c of domain) if (libraryKeys.has(c.key)) survey.domainCopyOfLibrary++;

    for (const c of [...library, ...domain]) {
      const rel = c.rel;
      const from = info.get(lower(rel.fromModel));
      const to = info.get(lower(rel.toModel));
      if (!from || !to) {
        survey.danglingModel++;
      } else if ((from.columns && !from.columns.has(lower(rel.fromColumn))) || (to.columns && !to.columns.has(lower(rel.toColumn)))) {
        survey.danglingColumn++;
      }
      if (from && to && respellRelationship(rel, models as readonly HealthModel[]) !== rel) survey.caseRespelled++;
      if (c.file !== 'domain') {
        if (rel.cardinality === 'one-to-many') survey.oneToManyInModelFile++;
        else if (rel.cardinality === 'many-to-one' && !normaliseCompositeKey(rel.compositeKey) && contradictsKeysOf([rel], modelOf, options.dbt)) survey.backwards++;
      }
    }

    // Composite groups, per file, as the read path forms them; a rejected one is partial.
    const buckets = new Map<string, Stored[]>();
    for (const [file, copies] of files) {
      for (const c of copies) {
        const ck = normaliseCompositeKey(c.rel.compositeKey);
        if (ck === undefined) continue;
        const id = `${file}\u0000${lower(ck)}\u0000${ownerOf(c.rel)}`;
        const list = buckets.get(id) ?? [];
        if (!list.some((x) => x.key === c.key)) list.push(c);
        buckets.set(id, list);
      }
    }
    for (const list of buckets.values()) if (compositeGroupProblem(list.map((c) => c.rel)) !== null) survey.partialComposite++;
    return survey;
  } catch {
    return emptySurvey();
  }
}

/**
 * How many entries of a raw `relationships:` value (the YAML as parsed, before
 * the reader) the reader skips or defaults: not a map, an end missing or not
 * text, or a cardinality it does not know.
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
