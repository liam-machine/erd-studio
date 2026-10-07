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
import type { Cardinality, SemanticModel, UnifiedDomain } from '../types/semantic';
import { detectDomainFormat } from '../types/semantic';
import type { SyncPlan } from '../types/syncPlan';
import { DomainFileError } from '../services/domainService';
import type { ModelFileError, ModelFileErrorKind } from '../services/logicalModelService';
import { findingsForDomain, libraryRelationshipsOf, usesLibraryRelationships } from '../services/libraryRelationships';
import { canonicalRelationship, linkKey, type RelationshipEnds, type RelationshipFinding } from '@erd-studio/core';
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
  relationship?: { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality?: Cardinality };
  /**
   * set-cardinality only: the file the relationship is stored in now, when
   * the fix stores it in another one (`file`) — take it out of this file.
   */
  movesFrom?: string;
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
  /** A v4 (inline-model) domain: run "ERD Studio: Migrate to v5" before fixing anything. */
  needsMigration?: boolean;
  /** Why this domain could not be compared (`--all` only; a single `--domain` exits 3 instead). */
  error?: { code: string; message: string };
}

export interface DiffResult extends Envelope {
  inputs: { manifest: ArtifactStatus; catalog: ArtifactStatus };
  /** Every domain clean (and none errored or needing migration). */
  clean: boolean;
  domains: DomainDiff[];
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
   * files, each with the model whose file holds it.
   */
  inLibrary: ReadonlyMap<string, string>;
  /** Whether a new relationship goes to the from-model's yml (`usesLibraryRelationships`). */
  addToLibrary: boolean;
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
      case 'remove-relationship-from-logical':
        fixes.push({
          severity: 'blocking', kind: 'remove-relationship', model: r.fromModel, column: r.fromColumn, file: currentFile(rel),
          relationship: { ...rel, ...(r.sourceCardinality ? { cardinality: r.sourceCardinality } : {}) },
          explain: `The logical model draws ${link}, but dbt has no relationships test for it — remove it, or add the test to dbt.`,
        });
        break;
      case 'update-cardinality-in-logical': {
        // The entry as it should be stored (D10): a one-to-many is the same
        // link turned round, many-to-one, on the other model — so in a
        // library project it also moves to that model's file.
        const target: Cardinality = r.targetCardinality ?? 'many-to-one';
        const stored = canonicalRelationship({ ...rel, cardinality: target });
        const turned = stored.fromModel !== rel.fromModel || stored.fromColumn !== rel.fromColumn;
        const current = currentFile(rel);
        const file = homeFile(stored, heldBy(rel) !== undefined);
        const movesFrom = file !== current ? current : undefined;
        const source = r.sourceCardinality ? (turned ? reverseCardinality(r.sourceCardinality) : r.sourceCardinality) : undefined;
        const storedLink = `${stored.fromModel}.${stored.fromColumn} → ${stored.toModel}.${stored.toColumn}`;
        fixes.push({
          severity: 'blocking', kind: 'set-cardinality', model: stored.fromModel, column: stored.fromColumn, file,
          ...(source ? { from: source } : {}), to: stored.cardinality,
          relationship: { ...stored, cardinality: stored.cardinality },
          ...(movesFrom ? { movesFrom } : {}),
          explain: turned
            ? `${link} is ${r.sourceCardinality} in the logical model but ${r.targetCardinality} according to dbt's tests, `
              + `so ${stored.fromModel} is the many side — store it the other way round, as ${storedLink} ${stored.cardinality}`
              + (movesFrom ? `: take it out of ${movesFrom} and add it to ${file}.` : ', replacing the old entry.')
            : `${link} is ${r.sourceCardinality} in the logical model but ${r.targetCardinality} according to dbt's tests — change it to ${r.targetCardinality}.`,
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

/** Library relationships a domain draws, by link, with the model whose file holds each. */
export function libraryHolders(models: readonly SemanticModel[]): Map<string, string> {
  const held = new Map<string, string>();
  for (const model of models) {
    for (const rel of libraryRelationshipsOf(model)) {
      const key = linkKey(rel);
      if (!held.has(key)) held.set(key, model.name);
    }
  }
  return held;
}

/**
 * The project's relationship findings, or null when the checks could not run —
 * diff still compares; `erd-studio check` reports the failure on its own.
 */
function projectFindingsOf(ctx: CliContext): RelationshipFinding[] | null {
  try {
    return checkProjectRelationships(ctx).findings;
  } catch {
    return null;
  }
}

/** The findings that concern one domain file (its own records, and links between its models). */
function integrityFor(
  ctx: CliContext,
  findings: readonly RelationshipFinding[] | null,
  file: string,
  modelNames: readonly string[],
): RelationshipFinding[] {
  if (!findings || findings.length === 0) return [];
  const modelFiles = modelNames
    .map((name) => ctx.logicalModelService.resolveModelPath(name))
    .filter((p): p is string => p !== null && fs.existsSync(p))
    .map((p) => relPath(ctx.root, p));
  return findingsForDomain(findings, { filePath: relPath(ctx.root, file), models: modelNames, modelFiles });
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
  projectFindings: readonly RelationshipFinding[] | null = projectFindingsOf(ctx),
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
      integrity: integrityFor(ctx, projectFindings, file, inlineNames),
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
  const relationshipHome: RelationshipHome = {
    inLibrary: libraryHolders(unified.logical.models),
    addToLibrary: usesLibraryRelationships(
      ctx.logicalModelService.listModels(),
      ctx.domainService.countDomainFileRelationships(ctx.root, ctx.semanticDir),
    ),
  };
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
  const projectFindings = projectFindingsOf(ctx);

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
    result: { ...ctx.envelope, inputs: inputsOf(ctx), clean, domains },
    exitCode: clean ? 0 : 1,
  };
}
