/**
 * `erd-studio diff` — the canvas's "Compare to Physical", headless.
 *
 * Each domain goes through `computeDomainDiff(…, 'logical')` — the one
 * orchestration the canvas's toggle also calls — and then through
 * `buildSyncPlan` with physical as the ground truth for every item, exactly
 * as "All Physical → Generate sync plan" would. The `fixes` below are a
 * beginner-friendly re-reading of that plan and nothing more: there is no
 * comparison logic in this file, and there must never be (spec risk 6).
 *
 * Each domain also carries `integrity`: the project relationship checks
 * (`erd-studio check`, issue #133) that concern it. They are advisory here —
 * they never make a domain unclean or change the exit code, because they are
 * about how the ERD Studio files are stored, not about drift from dbt.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { DiscrepancyReport } from '../types/discrepancy';
import { redactPaths } from '../types/feedback';
import type { Cardinality, Relationship, SemanticModel, UnifiedDomain } from '../types/semantic';
import { detectDomainFormat } from '../types/semantic';
import type { SyncPlan } from '../types/syncPlan';
import { DomainFileError } from '../services/domainService';
import type { ModelFileError, ModelFileErrorKind } from '../services/logicalModelService';
import { findingsForDomain, libraryRelationshipsOf, usesLibraryRelationships } from '../services/libraryRelationships';
import {
  canonicalRelationship,
  keepStoredRole,
  linkKey,
  normaliseRelationshipRole,
  readDomainRelationshipEntries,
  sameLink,
  type RelationshipEnds,
  type RelationshipFinding,
} from '@erd-studio/core';
import { parse as parseYaml } from 'yaml';
import { computeDomainDiff } from '../services/stageDiff';
import { allSelections, buildSyncPlan } from '../services/syncPlanBuilder';
import { CliEnvError, inputsOf, relPath, type ArtifactStatus, type CliContext, type Envelope } from './context';
import { checkProjectRelationships } from './relationshipCheck';

export type FixKind =
  | 'add-column' | 'remove-column' | 'set-type'
  | 'add-relationship' | 'remove-relationship' | 'set-cardinality'
  | 'resolve-phantom' | 'fix-model-yaml';

export interface Fix {
  severity: 'blocking' | 'advisory';
  kind: FixKind;
  model: string;
  column?: string;
  /** The file to edit: `<semanticDir>/logical-models/<m>.yml` or the domain JSON, project-relative. */
  file: string;
  /**
   * Types (set-type) or cardinalities (set-cardinality). A cardinality pair
   * reads in the direction of `relationship`, so `to` is always a value to
   * write — never `one-to-many`.
   */
  from?: string;
  to?: string;
  /**
   * The relationship. For add-relationship and set-cardinality it is exactly
   * the entry to store — on its many side, `many-to-one` rather than
   * `one-to-many` (#133). For remove-relationship it is the link as drawn.
   */
  relationship?: { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality?: Cardinality; role?: string };
  /**
   * set-cardinality only: the file the relationship is stored in now, when
   * the fix stores it in another one (`file`) — take it out of this file.
   */
  movesFrom?: string;
  /**
   * remove-relationship and set-cardinality: every file that holds a further
   * copy of the same link (the same two columns, either way round) besides
   * the one entry this domain draws — `file` and `movesFrom` included when
   * they hold another entry of it — so the link ends up stored once (or, for
   * a removal, not at all). `explain` says how many entries each holds.
   */
  alsoIn?: string[];
  /**
   * remove-relationship and add-relationship: the two halves of one
   * one-to-one that the logical model stores the other way round from dbt
   * (#133). dbt does test the link, so the remove is never "not tested in
   * dbt": apply the pair together, as one replace of the entry (keeping its
   * `role`) — never one without the other, and never as a question.
   */
  flipped?: true;
  /** fix-model-yaml: where the parser stopped (1-based). */
  line?: number;
  explain: string;
}

/**
 * A model file that exists but cannot be read or parsed. The model loads as
 * an empty placeholder, so every column difference reported against it would
 * be noise — the file has to be fixed first.
 */
export interface UnreadableModelFile {
  name: string;
  /** Project-relative, forward slashes. */
  file: string;
  kind: ModelFileErrorKind;
  line?: number;
  column?: number;
  /** The `yaml` library's error code, e.g. `BLOCK_AS_IMPLICIT_KEY`. */
  code?: string;
  /** The parser's own message (may quote the file; never an absolute path). */
  message: string;
}

/** One-line advice per failure kind, for the fix text and the human output. */
export const MODEL_YAML_HINTS: Record<ModelFileErrorKind, string> = {
  yamlScalar: 'wrap the value in double quotes',
  yamlIndent: 'indent with spaces, never tabs',
  yamlDuplicateKey: 'a key appears twice — keep one',
  yamlStructure: 'one YAML document per file — remove any `---` separator or code fence',
  yamlOther: 'check the YAML syntax there',
  read: 'the file could not be read — check it exists and is readable',
};

/** A {@link ModelFileError} as the CLI reports it: project-relative, redacted. */
export function toUnreadableModelFile(root: string, err: ModelFileError): UnreadableModelFile {
  const file = relPath(root, err.filePath);
  return {
    name: err.name,
    file,
    kind: err.kind,
    ...(err.line !== undefined ? { line: err.line } : {}),
    ...(err.column !== undefined ? { column: err.column } : {}),
    ...(err.code !== undefined ? { code: err.code } : {}),
    message: redactPaths(err.message.split(err.filePath).join(file)),
  };
}

/** `fct_order.yml line 4: YAML error (BLOCK_AS_IMPLICIT_KEY) — wrap the value in double quotes`. */
export function describeUnreadable(u: UnreadableModelFile): string {
  const where = `${path.posix.basename(u.file)}${u.line !== undefined ? ` line ${u.line}` : ''}`;
  const what = u.kind === 'read' ? 'could not be read' : `YAML error${u.code ? ` (${u.code})` : ''}`;
  return u.kind === 'read' ? `${where}: ${MODEL_YAML_HINTS.read}` : `${where}: ${what} — ${MODEL_YAML_HINTS[u.kind]}`;
}

export interface DomainDiff {
  file: string;
  domain: string;
  layer: string;
  clean: boolean;
  counts: {
    blocking: number;
    advisory: number;
    matchedModels: number;
    matchedColumns: number;
    matchedRelationships: number;
  };
  /** Logical models dbt does not have (`existsInProject === false`, which `compare()` hides). */
  phantoms: Array<{ name: string; reason: 'absent' | 'disabled' }>;
  /** Names the domain references that have no logical-models yml (rendered as placeholders). */
  missingModelFiles: string[];
  /**
   * Model files that exist but do not parse. Each gets one blocking
   * `fix-model-yaml` fix in place of its column fixes, so the domain is never
   * clean until they read.
   */
  unreadableModelFiles: UnreadableModelFile[];
  /**
   * Models dbt has but lists no columns for (only the source file proves they
   * exist). `compare()` calls them matched with no column rows, so a clean
   * result over them says nothing about columns.
   */
  modelsWithoutColumns: string[];
  fixes: Fix[];
  /**
   * The project relationship checks that concern this domain (the same
   * findings as `erd-studio check`). Advisory: they never affect `clean`.
   */
  integrity: RelationshipFinding[];
  /** Absent for a v4 domain or a domain that could not be read. */
  report?: DiscrepancyReport;
  plan?: SyncPlan;
  /** A v4 (inline-model) domain: run "ERD Studio: Migrate Domains to Central Model Store" before fixing anything. */
  needsMigration?: boolean;
  /** Why this domain could not be compared (`--all` only; a single `--domain` exits 3 instead). */
  error?: { code: string; message: string };
}

export interface DiffResult extends Envelope {
  inputs: { manifest: ArtifactStatus; catalog: ArtifactStatus };
  /** Every domain clean (and none errored or needing migration). */
  clean: boolean;
  domains: DomainDiff[];
  /**
   * Set when the relationship checks could not run: why. Every `integrity`
   * list is then empty because nothing was checked — not because nothing is
   * wrong. (Advisory, like `integrity`: it does not change `clean`.)
   */
  integrityError?: string;
}

export interface DiffOptions {
  domains?: string[];
  all?: boolean;
  strict?: boolean;
  cwd?: string;
}

/** Resolve a `--domain` argument: as given (from the cwd), else relative to the project root. */
export function resolveDomainPath(ctx: CliContext, arg: string, cwd: string = process.cwd()): string {
  const candidates = path.isAbsolute(arg) ? [arg] : [path.resolve(cwd, arg), path.resolve(ctx.root, arg)];
  const hit = candidates.find((c) => fs.existsSync(c));
  if (!hit) {
    throw new CliEnvError('domain-missing', `Domain file not found: ${redactPaths(arg)}`);
  }
  return hit;
}

/** Map a thrown domain-load error to a stable code and a redacted message with the project-relative path. */
function describeDomainError(ctx: CliContext, file: string, err: unknown): { code: string; message: string } {
  const rel = relPath(ctx.root, file);
  const raw = err instanceof Error ? err.message : String(err);
  const message = redactPaths(raw.split(file).join(rel));
  if (err instanceof DomainFileError) {
    return { code: err.reason === 'missing' ? 'domain-missing' : 'domain-invalid', message };
  }
  if (/invalid layer/.test(raw)) { return { code: 'unknown-layer', message }; }
  if (/pre-v\d|mixes inline model|schemaVersion/.test(raw)) { return { code: 'unsupported-format', message }; }
  return { code: 'domain-invalid', message };
}

const SEVERITY_ORDER: Record<Fix['severity'], number> = { blocking: 0, advisory: 1 };

function sortFixes(fixes: Fix[]): Fix[] {
  return fixes.sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || a.model.localeCompare(b.model)
    || (a.column ?? '').localeCompare(b.column ?? '')
    || a.kind.localeCompare(b.kind));
}

/** Where a domain's relationships are defined, so a relationship fix names the right file. */
export interface RelationshipHome {
  /**
   * The links (`linkKey`, either way round) this domain draws from model yml
   * files, each with the model whose file holds the copy that is drawn.
   */
  inLibrary: ReadonlyMap<string, string>;
  /** Whether a new relationship goes to the from-model's yml (`usesLibraryRelationships`). */
  addToLibrary: boolean;
  /**
   * By link: every other stored copy besides the drawn one — a model's yml
   * (`{ model }`) or this domain file (`{ domain: true }`).
   */
  otherCopies?: ReadonlyMap<string, ReadonlyArray<{ model: string } | { domain: true }>>;
  /**
   * By link: the role of the copy that is drawn, exactly as written on disk
   * (a long or multi-line label the reader shows shortened is not cut), kept
   * when the fix rewrites the entry.
   */
  roles?: ReadonlyMap<string, string>;
}

/** Where a drawn copy is stored: a model's yml, or this domain file. */
export type RelationshipHolder = { model: string } | { domain: true };

/**
 * The `role` exactly as written on the entry of `entries` (a model yml's
 * `relationships:` — whose entries' `fromModel` is `fromModel` — or a domain
 * file's `logical.relationships`, as parsed) that stores `rel`'s link with
 * the role the reader shows for it; undefined when there is none.
 */
export function storedRoleIn(entries: unknown, rel: RelationshipEnds & { role?: string }, fromModel?: string): unknown {
  if (!Array.isArray(entries) || rel.role === undefined) return undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const o = entry as Record<string, unknown>;
    const ends = { fromModel: fromModel ?? o.fromModel, fromColumn: o.fromColumn, toModel: o.toModel, toColumn: o.toColumn };
    if (![ends.fromModel, ends.fromColumn, ends.toModel, ends.toColumn].every((v) => typeof v === 'string')) continue;
    if (!sameLink(ends as RelationshipEnds, rel)) continue;
    if (normaliseRelationshipRole(o.role) === rel.role) return o.role;
  }
  return undefined;
}

/**
 * Re-read a physical-truth sync plan as edits to the logical model. Every
 * plan resolution becomes exactly one fix, except those about a phantom,
 * which collapse into one `resolve-phantom` each. An `undeclared` column
 * whose physical type is empty is advisory (spec D7): dbt knows no type yet,
 * and blanking the logical one to match would break the schema rules.
 */
export function fixesFromPlan(
  plan: SyncPlan,
  domainFile: string,
  semanticDir: string,
  phantoms: DomainDiff['phantoms'],
  unreadable: UnreadableModelFile[] = [],
  relationshipHome: RelationshipHome = { inLibrary: new Map(), addToLibrary: false },
): Fix[] {
  const ymlFile = (model: string): string =>
    plan.modelContext[model]?.logicalModelPath ?? `${semanticDir}/logical-models/${model}.yml`;
  // A relationship is fixed where it is defined (#126): the yml of the model
  // whose file holds it when the library holds it, else the domain file —
  // found by link, whichever way round it is stored (#133). A relationship
  // being written goes to its home: the yml of its many-side model in a
  // project that keeps relationships in the library, else the domain file.
  const heldBy = (r: RelationshipEnds): string | undefined => relationshipHome.inLibrary.get(linkKey(r));
  const currentFile = (r: RelationshipEnds): string => {
    const holder = heldBy(r);
    return holder ? ymlFile(holder) : domainFile;
  };
  const homeFile = (stored: RelationshipEnds, inLibrary: boolean): string =>
    (inLibrary ? ymlFile(stored.fromModel) : domainFile);
  /**
   * Every further copy of the link besides the drawn one, by file, in the
   * order found — a second entry in the very file the fix edits included
   * (`relationshipHomeOf` keeps every further copy, even in the same file).
   */
  const furtherCopies = (r: RelationshipEnds): Array<{ file: string; count: number }> => {
    const byFile = new Map<string, number>();
    for (const c of relationshipHome.otherCopies?.get(linkKey(r)) ?? []) {
      const f = 'model' in c ? ymlFile(c.model) : domainFile;
      byFile.set(f, (byFile.get(f) ?? 0) + 1);
    }
    return [...byFile].map(([file, count]) => ({ file, count }));
  };
  const role = (r: RelationshipEnds): string | undefined => relationshipHome.roles?.get(linkKey(r));
  /** The sentence naming every further copy; `edited` are the files the fix itself edits. */
  const andRemove = (copies: ReadonlyArray<{ file: string; count: number }>, edited: readonly string[]): string => {
    if (copies.length === 0) return '';
    const total = copies.reduce((n, c) => n + c.count, 0);
    const where = copies.map((c) => (edited.includes(c.file)
      ? `${c.file} (${c.count === 1 ? 'another entry' : `${c.count} more entries`} besides the one this fix is about)`
      : `${c.file}${c.count > 1 ? ` (${c.count} entries)` : ''}`));
    return ` It is also stored in ${where.join(' and ')} — remove ${total === 1 ? 'that copy' : 'those copies'} too.`;
  };
  const fixes: Fix[] = [];
  // A phantom is one question (rename it or drop it), not one fix per column
  // and edge: from the logical side compare() reports it 'extra' with every
  // column 'extra', and each of those would be answered by that one question.
  const phantomNames = new Set(phantoms.map((p) => p.name));
  // A model whose file does not parse loads with no columns, so every dbt
  // column would read as "add it" — to a file the assistant cannot edit
  // safely until it parses. One fix-model-yaml replaces them all.
  const unreadableNames = new Set(unreadable.map((u) => u.name));

  for (const c of plan.columns) {
    if (phantomNames.has(c.modelName) || unreadableNames.has(c.modelName)) { continue; }
    const logicalType = c.sourceDataType ?? '';
    const physicalType = c.resolvedDataType ?? '';
    const where = `${c.modelName}.${c.columnName}`;
    switch (c.action) {
      case 'add-column-to-logical':
        fixes.push({
          severity: 'blocking', kind: 'add-column', model: c.modelName, column: c.columnName, file: ymlFile(c.modelName),
          to: physicalType,
          explain: physicalType
            ? `dbt has a column ${where} (${physicalType}) that the logical model is missing — add it.`
            : `dbt has a column ${where} that the logical model is missing — add it (dbt has no type for it yet, so use your best guess).`,
        });
        break;
      case 'remove-column-from-logical':
        fixes.push({
          severity: 'blocking', kind: 'remove-column', model: c.modelName, column: c.columnName, file: ymlFile(c.modelName),
          explain: `The logical model has a column ${where} that dbt does not have — remove it (and any relationship that uses it).`,
        });
        break;
      case 'update-type-in-logical': {
        const advisory = c.discrepancyStatus === 'undeclared' && !physicalType;
        fixes.push({
          severity: advisory ? 'advisory' : 'blocking',
          kind: 'set-type', model: c.modelName, column: c.columnName, file: ymlFile(c.modelName),
          from: logicalType, to: physicalType,
          explain: advisory
            ? `dbt has no type for ${where} yet — keep the logical type (${logicalType}); generating the catalog will fill it in.`
            : `${where} is ${logicalType || 'untyped'} in the logical model but ${physicalType} in dbt — change the logical type to ${physicalType}.`,
        });
        break;
      }
      default:
        break; // Physical-side actions never appear with physical as the ground truth.
    }
  }

  for (const r of plan.relationships) {
    if (phantomNames.has(r.fromModel) || phantomNames.has(r.toModel)) { continue; }
    const rel = { fromModel: r.fromModel, fromColumn: r.fromColumn, toModel: r.toModel, toColumn: r.toColumn };
    const link = `${r.fromModel}.${r.fromColumn} → ${r.toModel}.${r.toColumn}`;
    // A one-to-one the two stages store the other way round is a remove and
    // an add of one link (#133): each says the other model holds the key.
    const flipped = plan.relationships.some((o) => o !== r && o.action !== r.action && sameLink(o, r));
    if (flipped && r.action === 'remove-relationship-from-logical') {
      const file = currentFile(rel);
      const copies = furtherCopies(rel);
      const alsoIn = copies.map((c) => c.file);
      fixes.push({
        severity: 'blocking', kind: 'remove-relationship', model: r.fromModel, column: r.fromColumn, file,
        relationship: { ...rel, ...(r.sourceCardinality ? { cardinality: r.sourceCardinality } : {}) },
        ...(alsoIn.length > 0 ? { alsoIn } : {}),
        flipped: true,
        explain: `The logical model stores ${link} as a one-to-one held by ${r.fromModel}, but dbt tests it from the other end — `
          + 'remove this entry; the matching add-relationship stores it the way dbt has it.' + andRemove(copies, [file]),
      });
      continue;
    }
    if (flipped && r.action === 'add-relationship-to-logical') {
      fixes.push({
        severity: 'blocking', kind: 'add-relationship', model: r.fromModel, column: r.fromColumn,
        file: homeFile(rel, relationshipHome.addToLibrary),
        relationship: { ...rel, cardinality: r.targetCardinality ?? 'one-to-one' },
        flipped: true,
        explain: `dbt tests ${link} as a one-to-one held by ${r.fromModel}; the logical model stores it the other way round — `
          + 'add it this way, in place of the entry the matching remove-relationship takes out.',
      });
      continue;
    }
    switch (r.action) {
      case 'add-relationship-to-logical': {
        // Written on its many side (#133): a one-to-many is the same link
        // stored from the other end, in the other model's file.
        const stored = r.targetCardinality ? canonicalRelationship({ ...rel, cardinality: r.targetCardinality }) : rel;
        fixes.push({
          severity: 'blocking', kind: 'add-relationship', model: stored.fromModel, column: stored.fromColumn,
          file: homeFile(stored, relationshipHome.addToLibrary),
          relationship: stored,
          explain: `dbt tests the link ${link}, but the logical model does not draw it — add the relationship.`,
        });
        break;
      }
      case 'remove-relationship-from-logical': {
        const file = currentFile(rel);
        const copies = furtherCopies(rel);
        const alsoIn = copies.map((c) => c.file);
        fixes.push({
          severity: 'blocking', kind: 'remove-relationship', model: r.fromModel, column: r.fromColumn, file,
          relationship: { ...rel, ...(r.sourceCardinality ? { cardinality: r.sourceCardinality } : {}) },
          ...(alsoIn.length > 0 ? { alsoIn } : {}),
          explain: `The logical model draws ${link}, but dbt has no relationships test for it — remove it, or add the test to dbt.`
            + andRemove(copies, [file]),
        });
        break;
      }
      case 'update-cardinality-in-logical': {
        // The entry as it should be stored (D10): a one-to-many is the same
        // link turned round, many-to-one, on the other model — so in a
        // library project it also moves to that model's file. In a library
        // project an entry the diagram file holds goes to the model library
        // too, exactly as the canvas's commit writes an edited relationship
        // (`planRelationshipCommit`): the two never disagree on where the
        // same relationship ends up (#133 review 8).
        const target: Cardinality = r.targetCardinality ?? 'many-to-one';
        const stored = canonicalRelationship({ ...rel, cardinality: target });
        const turned = stored.fromModel !== rel.fromModel || stored.fromColumn !== rel.fromColumn;
        const current = currentFile(rel);
        const file = homeFile(stored, relationshipHome.addToLibrary || heldBy(rel) !== undefined);
        const movesFrom = file !== current ? current : undefined;
        const copies = furtherCopies(rel);
        const alsoIn = copies.map((c) => c.file);
        const source = r.sourceCardinality ? (turned ? reverseCardinality(r.sourceCardinality) : r.sourceCardinality) : undefined;
        const storedLink = `${stored.fromModel}.${stored.fromColumn} → ${stored.toModel}.${stored.toColumn}`;
        const keptRole = role(rel);
        fixes.push({
          severity: 'blocking', kind: 'set-cardinality', model: stored.fromModel, column: stored.fromColumn, file,
          ...(source ? { from: source } : {}), to: stored.cardinality,
          relationship: { ...stored, cardinality: stored.cardinality, ...(keptRole ? { role: keptRole } : {}) },
          ...(movesFrom ? { movesFrom } : {}),
          ...(alsoIn.length > 0 ? { alsoIn } : {}),
          explain: (turned
            ? `${link} is ${r.sourceCardinality} in the logical model but ${r.targetCardinality} according to dbt's tests, `
              + `so ${stored.fromModel} is the many side — store it the other way round, as ${storedLink} ${stored.cardinality}`
              + (movesFrom ? `: take it out of ${movesFrom} and add it to ${file}.` : ', replacing the old entry.')
            : `${link} is ${r.sourceCardinality} in the logical model but ${r.targetCardinality} according to dbt's tests — change it to ${r.targetCardinality}`
              + (movesFrom ? `, and move it: take it out of ${movesFrom} and add it to ${file}, where ${stored.fromModel} (the side holding the foreign key) keeps it.` : '.'))
            + andRemove(copies, [file, current]),
        });
        break;
      }
      default:
        break;
    }
  }

  for (const p of phantoms) {
    fixes.push({
      severity: 'blocking', kind: 'resolve-phantom', model: p.name, file: domainFile,
      explain: p.reason === 'disabled'
        ? `${p.name} is disabled in dbt — ask whether to remove it from this domain or re-enable it in dbt.`
        : `dbt has no model called ${p.name} — ask whether it is a typo for a real model, or should be removed from this domain.`,
    });
  }
  for (const u of unreadable) {
    fixes.push({
      severity: 'blocking', kind: 'fix-model-yaml', model: u.name, file: u.file,
      ...(u.line !== undefined ? { line: u.line } : {}),
      explain: `${describeUnreadable(u)}. Fix this file before anything else — until it parses, `
        + 'ERD Studio sees the model as empty and every other difference for it is meaningless.',
    });
  }
  // A model-level resolution would only arise for a model compare() did not
  // hide; surface it as a phantom question rather than dropping it silently.
  for (const m of plan.models) {
    if (phantomNames.has(m.modelName)) { continue; }
    fixes.push({
      severity: 'blocking', kind: 'resolve-phantom', model: m.modelName, file: domainFile,
      explain: `${m.modelName} is in only one of the two views — ask the user whether to keep it in this domain.`,
    });
  }

  return sortFixes(fixes);
}

/** The same cardinality read from the other end. */
function reverseCardinality(c: Cardinality): Cardinality {
  if (c === 'many-to-one') return 'one-to-many';
  if (c === 'one-to-many') return 'many-to-one';
  return c;
}

/**
 * Where each link a domain draws is stored, from the drawn relationships' own
 * provenance (`source`, set by core's `normaliseRelationships` — the copy the
 * canvas draws), never a first-match scan: the drawn copy's holder, the role
 * on it, and every other copy (another model's yml, this domain file) a fix
 * must also take out. `own` is the domain file's own relationships as read.
 */
export function relationshipHomeOf(
  drawn: readonly Relationship[],
  models: readonly SemanticModel[],
  own: readonly Relationship[],
  addToLibrary: boolean,
  /**
   * The role as written on disk for the drawn copy, when it can be read: the
   * readers collapse whitespace and cut a role at 60 characters, and a fix
   * that hands the shortened text back would cut the label on disk.
   */
  rawRoleOf?: (holder: RelationshipHolder, rel: Relationship) => unknown,
): RelationshipHome {
  const inLibrary = new Map<string, string>();
  const roles = new Map<string, string>();
  const drawnHolder = new Map<string, { model: string } | { domain: true }>();
  for (const rel of drawn) {
    const key = linkKey(rel);
    if (rel.source?.kind === 'library') {
      inLibrary.set(key, rel.source.model);
      drawnHolder.set(key, { model: rel.source.model });
    } else if (rel.source?.kind === 'domain') {
      drawnHolder.set(key, { domain: true });
    }
    if (rel.role) {
      const holder = drawnHolder.get(key);
      const raw = holder && rawRoleOf ? rawRoleOf(holder, rel) : undefined;
      roles.set(key, keepStoredRole(raw, rel.role) ?? rel.role);
    }
  }
  const copies = new Map<string, Array<{ model: string } | { domain: true }>>();
  const add = (key: string, holder: { model: string } | { domain: true }): void => {
    if (!drawnHolder.has(key)) return; // only links this domain draws
    const list = copies.get(key) ?? [];
    list.push(holder);
    copies.set(key, list);
  };
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.name)) continue;
    seen.add(model.name);
    for (const rel of libraryRelationshipsOf(model)) add(linkKey(rel), { model: model.name });
  }
  for (const rel of own) add(linkKey(rel), { domain: true });
  const otherCopies = new Map<string, Array<{ model: string } | { domain: true }>>();
  for (const [key, list] of copies) {
    const holder = drawnHolder.get(key)!;
    let skipped = false;
    // Drop the drawn copy once; every further copy, even in the same file, is another to remove.
    const others = list.filter((c) => {
      const same = 'model' in holder ? 'model' in c && c.model === holder.model : 'domain' in c;
      if (same && !skipped) { skipped = true; return false; }
      return true;
    });
    if (others.length > 0) otherCopies.set(key, others);
  }
  return { inLibrary, addToLibrary, otherCopies, roles };
}

/**
 * The project's relationship findings, or null with the reason when the checks
 * could not run — diff still compares, and says the checks were skipped.
 */
function projectFindingsOf(ctx: CliContext): { findings: RelationshipFinding[] | null; error?: string } {
  try {
    return { findings: checkProjectRelationships(ctx).findings };
  } catch (err) {
    return { findings: null, error: redactPaths(err instanceof Error ? err.message : String(err)) };
  }
}

/** The findings that concern one domain file (its own records, and links between its models). */
function integrityFor(
  ctx: CliContext,
  findings: readonly RelationshipFinding[] | null,
  file: string,
  modelNames: readonly string[],
  olderFormat = false,
): RelationshipFinding[] {
  if (!findings || findings.length === 0) return [];
  // A v4 diagram never draws the library's relationships: only its own file's
  // findings concern it (the canvas applies the same rule).
  const modelFiles = olderFormat ? [] : modelNames
    .map((name) => ctx.logicalModelService.resolveModelPath(name))
    .filter((p): p is string => p !== null && fs.existsSync(p))
    .map((p) => relPath(ctx.root, p));
  return findingsForDomain(findings, { filePath: relPath(ctx.root, file), models: modelNames, modelFiles, olderFormat });
}

/**
 * Compare one domain file. Load errors are thrown (the caller decides between
 * exit 3 and `domains[i].error`). `projectFindings` are the project's
 * relationship checks, computed once by `runDiff`; omitted, they are computed
 * here.
 */
export function diffDomain(
  ctx: CliContext,
  file: string,
  strict: boolean,
  projectFindings: readonly RelationshipFinding[] | null = projectFindingsOf(ctx).findings,
): DomainDiff {
  const rel = relPath(ctx.root, file);

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    raw = undefined; // getDomain below produces the precise error
  }
  const format = raw === undefined ? null : detectDomainFormat(raw);

  // A v4 (inline-model) file gets the migration answer before anything tries
  // the v5 load path — the migration command is what fixes it, whatever else
  // that load might have tripped over (an unknown layer, say). A file with no
  // numeric schemaVersion also detects as v4, but it is not a v4 domain —
  // getDomain reports that one precisely.
  const obj = (raw ?? {}) as { domain?: unknown; layer?: unknown; schemaVersion?: unknown; logical?: { models?: unknown } };
  if (format === 'v4' && typeof obj.schemaVersion === 'number') {
    const inlineNames = (Array.isArray(obj.logical?.models) ? obj.logical!.models : [])
      .map((m) => (m && typeof m === 'object' ? (m as { name?: unknown }).name : undefined))
      .filter((n): n is string => typeof n === 'string');
    return {
      file: rel,
      domain: typeof obj.domain === 'string' ? obj.domain : path.basename(file, '.json'),
      layer: typeof obj.layer === 'string' ? obj.layer : path.basename(path.dirname(file)),
      clean: false,
      counts: { blocking: 0, advisory: 0, matchedModels: 0, matchedColumns: 0, matchedRelationships: 0 },
      phantoms: [],
      missingModelFiles: [],
      unreadableModelFiles: [],
      modelsWithoutColumns: [],
      fixes: [],
      integrity: integrityFor(ctx, projectFindings, file, inlineNames, true),
      needsMigration: true,
    };
  }

  const { unified, target, report } = computeDomainDiff(
    { domainService: ctx.domainService, ymlData: ctx.ymlData, manifest: ctx.manifest, catalog: ctx.catalog },
    file,
    'logical',
  );

  const base = {
    file: rel,
    domain: unified.domain,
    layer: unified.layer,
  };

  const phantoms = target.models
    .filter((m) => m.existsInProject === false)
    .map((m) => ({ name: m.name, reason: m.missingReason ?? ('absent' as const) }));
  const modelsWithoutColumns = target.models
    .filter((m) => m.existsInProject !== false && m.columns.length === 0)
    .map((m) => m.name);

  const plan = buildSyncPlan(report, allSelections(report, 'physical'), {
    manifest: ctx.manifest,
    ymlData: ctx.ymlData,
    projectRoot: ctx.root,
    semanticDir: ctx.semanticDir,
    domain: unified.domain,
    layer: unified.layer,
    modelFolder: (name) => ctx.logicalModelService.modelFolder(name),
  });
  const unreadableModelFiles = unreadableModels(ctx, unified);
  const rawOwn = (obj.logical as { relationships?: unknown } | undefined)?.relationships;
  // A fix that keeps a role hands it back exactly as written (never the
  // reader's shortened, single-line copy): read from the file that holds it.
  const rawRoleOf = (holder: RelationshipHolder, drawnRel: Relationship): unknown => {
    if ('domain' in holder) return storedRoleIn(rawOwn, drawnRel);
    const filePath = ctx.logicalModelService.findModelFile(holder.model);
    if (!filePath) return undefined;
    try {
      const doc = parseYaml(fs.readFileSync(filePath, 'utf-8')) as { relationships?: unknown } | null;
      return storedRoleIn(doc?.relationships, drawnRel, holder.model);
    } catch {
      return undefined; // unreadable: the role as read is the best there is
    }
  };
  const relationshipHome = relationshipHomeOf(
    unified.logical.relationships,
    unified.logical.models,
    readDomainRelationshipEntries(rawOwn, rel).relationships,
    (() => {
      // A relationship check that cannot run is reported as `integrityError`;
      // the fixes still need a mode, read from the models that load.
      let library: { models: SemanticModel[]; unreadableWithRelationships: number };
      try {
        library = ctx.logicalModelService.relationshipModeInputs();
      } catch {
        library = { models: ctx.logicalModelService.listModels(), unreadableWithRelationships: 0 };
      }
      return usesLibraryRelationships(
        library.models,
        ctx.domainService.countDomainFileRelationships(ctx.root, ctx.semanticDir),
        library.unreadableWithRelationships,
      );
    })(),
    rawRoleOf,
  );
  const fixes = fixesFromPlan(plan, rel, ctx.semanticDir, phantoms, unreadableModelFiles, relationshipHome);
  const blocking = fixes.filter((f) => f.severity === 'blocking').length;
  const advisory = fixes.length - blocking;

  return {
    ...base,
    clean: blocking === 0 && (!strict || advisory === 0),
    counts: {
      blocking,
      advisory,
      matchedModels: report.summary.matchedModels,
      matchedColumns: report.summary.matchedColumns,
      matchedRelationships: report.relationships.filter((r) => r.status === 'matched').length,
    },
    phantoms,
    missingModelFiles: missingModelFiles(ctx, unified),
    unreadableModelFiles,
    modelsWithoutColumns,
    fixes,
    integrity: integrityFor(ctx, projectFindings, file, unified.logical.models.map((m) => m.name)),
    report,
    plan,
  };
}

function missingModelFiles(ctx: CliContext, unified: UnifiedDomain): string[] {
  return unified.logical.models
    .map((m) => m.name)
    .filter((name) => !ctx.logicalModelService.modelExists(name));
}

function unreadableModels(ctx: CliContext, unified: UnifiedDomain): UnreadableModelFile[] {
  const out: UnreadableModelFile[] = [];
  for (const m of unified.logical.models) {
    const err = ctx.logicalModelService.getModelFileError(m.name);
    if (err) { out.push(toUnreadableModelFile(ctx.root, err)); }
  }
  return out;
}

/**
 * Run the diff. `--domain` files that cannot be compared are a `CliEnvError`
 * (exit 3); under `--all` each failure is recorded on its own domain entry so
 * one broken file does not hide the rest.
 */
export function runDiff(ctx: CliContext, opts: DiffOptions): { result: DiffResult; exitCode: 0 | 1 } {
  const domains: DomainDiff[] = [];
  const { findings: projectFindings, error: integrityError } = projectFindingsOf(ctx);

  if (opts.all) {
    // `--all` over nothing must never read as "clean": a wrong or omitted
    // `--semantic-dir` (the CLI cannot see VS Code settings) would otherwise
    // hand the skill a verified match over zero domains.
    const semanticRoot = path.join(ctx.root, ctx.semanticDir);
    if (!fs.existsSync(semanticRoot)) {
      throw new CliEnvError(
        'no-semantic-dir',
        `No ${ctx.semanticDir}/ folder in this project — check --semantic-dir (it must match the erdStudio.semanticDir setting).`,
      );
    }
    const summaries = ctx.domainService.listDomains(ctx.root, ctx.semanticDir);
    if (summaries.length === 0) {
      throw new CliEnvError(
        'no-domains',
        `No domain files under ${ctx.semanticDir}/ — check --semantic-dir (it must match the erdStudio.semanticDir setting).`,
      );
    }
    for (const summary of summaries) {
      try {
        domains.push(diffDomain(ctx, summary.filePath, opts.strict === true, projectFindings));
      } catch (err) {
        domains.push({
          file: relPath(ctx.root, summary.filePath),
          domain: summary.domain,
          layer: summary.layer,
          clean: false,
          counts: { blocking: 0, advisory: 0, matchedModels: 0, matchedColumns: 0, matchedRelationships: 0 },
          phantoms: [],
          missingModelFiles: [],
          unreadableModelFiles: [],
          modelsWithoutColumns: [],
          fixes: [],
          integrity: [],
          error: describeDomainError(ctx, summary.filePath, err),
        });
      }
    }
  } else {
    for (const arg of opts.domains ?? []) {
      const file = resolveDomainPath(ctx, arg, opts.cwd);
      try {
        domains.push(diffDomain(ctx, file, opts.strict === true, projectFindings));
      } catch (err) {
        const { code, message } = describeDomainError(ctx, file, err);
        throw new CliEnvError(code, message);
      }
    }
  }

  const clean = domains.every((d) => d.clean);
  return {
    result: { ...ctx.envelope, inputs: inputsOf(ctx), clean, domains, ...(integrityError !== undefined ? { integrityError } : {}) },
    exitCode: clean ? 0 : 1,
  };
}
