/**
 * `erd-studio diff` — the canvas's "Compare to Physical", headless.
 *
 * Each domain goes through `computeDomainDiff(…, 'logical')` — the one
 * orchestration the canvas's toggle also calls — and then through
 * `buildSyncPlan` with physical as the ground truth for every item, exactly
 * as "All Physical → Generate sync plan" would. The `fixes` below are a
 * beginner-friendly re-reading of that plan and nothing more: there is no
 * comparison logic in this file, and there must never be (spec risk 6).
 */

import * as fs from 'fs';
import * as path from 'path';

import type { DiscrepancyReport } from '../types/discrepancy';
import { redactPaths } from '../types/feedback';
import type { Cardinality, UnifiedDomain } from '../types/semantic';
import { detectDomainFormat } from '../types/semantic';
import type { SyncPlan } from '../types/syncPlan';
import { DomainFileError } from '../services/domainService';
import { computeDomainDiff } from '../services/stageDiff';
import { allSelections, buildSyncPlan } from '../services/syncPlanBuilder';
import { CliEnvError, inputsOf, relPath, type ArtifactStatus, type CliContext, type Envelope } from './context';

export type FixKind =
  | 'add-column' | 'remove-column' | 'set-type'
  | 'add-relationship' | 'remove-relationship' | 'set-cardinality'
  | 'resolve-phantom';

export interface Fix {
  severity: 'blocking' | 'advisory';
  kind: FixKind;
  model: string;
  column?: string;
  /** The file to edit: `<semanticDir>/logical-models/<m>.yml` or the domain JSON, project-relative. */
  file: string;
  /** Types (set-type) or cardinalities (set-cardinality). */
  from?: string;
  to?: string;
  relationship?: { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality?: Cardinality };
  explain: string;
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
   * Models dbt has but lists no columns for (only the source file proves they
   * exist). `compare()` calls them matched with no column rows, so a clean
   * result over them says nothing about columns.
   */
  modelsWithoutColumns: string[];
  fixes: Fix[];
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
): Fix[] {
  const ymlFile = (model: string): string =>
    plan.modelContext[model]?.logicalModelPath ?? `${semanticDir}/logical-models/${model}.yml`;
  const fixes: Fix[] = [];
  // A phantom is one question (rename it or drop it), not one fix per column
  // and edge: from the logical side compare() reports it 'extra' with every
  // column 'extra', and each of those would be answered by that one question.
  const phantomNames = new Set(phantoms.map((p) => p.name));

  for (const c of plan.columns) {
    if (phantomNames.has(c.modelName)) { continue; }
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
      case 'add-relationship-to-logical':
        fixes.push({
          severity: 'blocking', kind: 'add-relationship', model: r.fromModel, column: r.fromColumn, file: domainFile,
          relationship: { ...rel, ...(r.targetCardinality ? { cardinality: r.targetCardinality } : {}) },
          explain: `dbt tests the link ${link}, but the logical model does not draw it — add the relationship.`,
        });
        break;
      case 'remove-relationship-from-logical':
        fixes.push({
          severity: 'blocking', kind: 'remove-relationship', model: r.fromModel, column: r.fromColumn, file: domainFile,
          relationship: { ...rel, ...(r.sourceCardinality ? { cardinality: r.sourceCardinality } : {}) },
          explain: `The logical model draws ${link}, but dbt has no relationships test for it — remove it, or add the test to dbt.`,
        });
        break;
      case 'update-cardinality-in-logical':
        fixes.push({
          severity: 'blocking', kind: 'set-cardinality', model: r.fromModel, column: r.fromColumn, file: domainFile,
          from: r.sourceCardinality, to: r.targetCardinality,
          relationship: { ...rel, ...(r.targetCardinality ? { cardinality: r.targetCardinality } : {}) },
          explain: `${link} is ${r.sourceCardinality} in the logical model but ${r.targetCardinality} according to dbt's tests — change it to ${r.targetCardinality}.`,
        });
        break;
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

/** Compare one domain file. Load errors are thrown (the caller decides between exit 3 and `domains[i].error`). */
export function diffDomain(ctx: CliContext, file: string, strict: boolean): DomainDiff {
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
  const obj = (raw ?? {}) as { domain?: unknown; layer?: unknown; schemaVersion?: unknown };
  if (format === 'v4' && typeof obj.schemaVersion === 'number') {
    return {
      file: rel,
      domain: typeof obj.domain === 'string' ? obj.domain : path.basename(file, '.json'),
      layer: typeof obj.layer === 'string' ? obj.layer : path.basename(path.dirname(file)),
      clean: false,
      counts: { blocking: 0, advisory: 0, matchedModels: 0, matchedColumns: 0, matchedRelationships: 0 },
      phantoms: [],
      missingModelFiles: [],
      modelsWithoutColumns: [],
      fixes: [],
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
  });
  const fixes = fixesFromPlan(plan, rel, ctx.semanticDir, phantoms);
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
    modelsWithoutColumns,
    fixes,
    report,
    plan,
  };
}

function missingModelFiles(ctx: CliContext, unified: UnifiedDomain): string[] {
  return unified.logical.models
    .map((m) => m.name)
    .filter((name) => !ctx.logicalModelService.modelExists(name));
}

/**
 * Run the diff. `--domain` files that cannot be compared are a `CliEnvError`
 * (exit 3); under `--all` each failure is recorded on its own domain entry so
 * one broken file does not hide the rest.
 */
export function runDiff(ctx: CliContext, opts: DiffOptions): { result: DiffResult; exitCode: 0 | 1 } {
  const domains: DomainDiff[] = [];

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
        domains.push(diffDomain(ctx, summary.filePath, opts.strict === true));
      } catch (err) {
        domains.push({
          file: relPath(ctx.root, summary.filePath),
          domain: summary.domain,
          layer: summary.layer,
          clean: false,
          counts: { blocking: 0, advisory: 0, matchedModels: 0, matchedColumns: 0, matchedRelationships: 0 },
          phantoms: [],
          missingModelFiles: [],
          modelsWithoutColumns: [],
          fixes: [],
          error: describeDomainError(ctx, summary.filePath, err),
        });
      }
    }
  } else {
    for (const arg of opts.domains ?? []) {
      const file = resolveDomainPath(ctx, arg, opts.cwd);
      try {
        domains.push(diffDomain(ctx, file, opts.strict === true));
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
