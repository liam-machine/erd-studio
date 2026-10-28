/**
 * `erd-studio diff` — the canvas's "Compare to Physical", headless.
 *
 * Each domain goes through `computeSubjectAreaDiff(…, 'logical')` — the one
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
import type { Cardinality, Relationship, SubjectAreaSummary, UnifiedSubjectArea } from '../types/semantic';
import { detectSubjectAreaFormat } from '../types/semantic';
import type { SyncPlan } from '../types/syncPlan';
import { SubjectAreaFileError } from '../services/domainService';
import type { TableFileError, TableFileErrorKind } from '../services/logicalModelService';
import { usesLibraryRelationships } from '../services/libraryRelationships';
import { DBML_TABLE_QUOTE_HINT_CODES, canonicalRelationship, linkKey, mergeLibraryRelationships, reverseRelationship, subjectAreaStorageOf } from '@erd-studio/core';
import type { ColumnPair } from '@erd-studio/core';
import { computeSubjectAreaDiff } from '../services/stageDiff';
import { allSelections, buildSyncPlan } from '../services/syncPlanBuilder';
import { CliEnvError, inputsOf, relPath, type ArtifactStatus, type CliContext, type Envelope } from './context';

export type FixKind =
  | 'add-column' | 'remove-column' | 'set-type'
  | 'add-relationship' | 'remove-relationship' | 'set-cardinality'
  | 'declare-composite-foreign-key'
  | 'resolve-phantom' | 'fix-model-yaml';

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
  /**
   * Relationship fixes: the entry exactly as it belongs in `file` — on its
   * many side in a model yml (#133), never a `one-to-many` there.
   */
  relationship?: {
    fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality?: Cardinality;
    /** A composite foreign key's column pairs (#133 L2), in `fromModel` → `toModel` order; `fromColumn` / `toColumn` are the first. */
    pairs?: ColumnPair[];
    compositeKey?: string;
  };
  /** set-cardinality: the file the link is stored in now, when the fix moves it to `file`. */
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
export interface UnreadableTableFile {
  name: string;
  /** Project-relative, forward slashes. */
  file: string;
  kind: TableFileErrorKind;
  line?: number;
  column?: number;
  /** The parser's code: the `yaml` library's (`BLOCK_AS_IMPLICIT_KEY`) or a DBML diagnostic's (`3025`, `structure:notOneTable`). */
  code?: string;
  /** The file holds unresolved git merge conflicts (#145); `line` is the first `<<<<<<<`. */
  mergeConflict?: true;
  /**
   * The model still loads (#164): a key written twice, read with its last copy
   * as dbt reads it. ERD Studio will not write the file until one copy goes.
   */
  readable?: true;
  /** For `readable`: the key written twice. */
  key?: string;
  /** The parser's own message (may quote the file; never an absolute path). */
  message: string;
}

/**
 * One-line advice per failure kind, for the fix text and the human output.
 * `at that line` in a DBML hint becomes the line when one is known
 * ({@link unreadableHint}). A DBML hint is refined by the error's code
 * ({@link kindHint}): the quote advice only for an unquoted value
 * (`DBML_TABLE_QUOTE_HINT_CODES`), and a `structure:<rule>` its own fix.
 */
export const TABLE_FILE_HINTS: Record<TableFileErrorKind, string> = {
  yamlScalar: 'wrap the value in double quotes',
  yamlIndent: 'indent with spaces, never tabs',
  yamlDuplicateKey: 'a key appears twice — keep one',
  yamlStructure: 'one YAML document per file — remove any `---` separator or code fence',
  yamlOther: 'check the YAML syntax there',
  read: 'the file could not be read — check it exists and is readable',
  dbmlSyntax: 'fix the DBML at that line',
  dbmlInvalid: 'fix the DBML at that line',
  dbmlStructure: 'a table file holds exactly one Table, named as its file, and no Project, TableGroup or Note',
};

/** The quote advice, appended to a `dbmlInvalid` hint only for the codes of an unquoted value. */
const DBML_QUOTE_ADVICE = "quote the value, as in grain: 'One row per order line'";

/** The fix for each of ERD Studio's own table-file rules (`structure:<rule>` codes). */
const DBML_STRUCTURE_HINTS: Readonly<Record<string, string>> = {
  'structure:notOneTable': 'a table file holds exactly one Table — move any other Table to its own file',
  'structure:nameMismatch': 'name the Table as its file (or rename the file to the Table\'s name)',
  'structure:unsupportedElement': 'a table file holds one Table and nothing else — remove the Project, TableGroup, Note or other block',
  'structure:metadataTarget': 'a Metadata block names a table or column this file does not declare — rename or remove the block',
};

/**
 * The hint for `kind` and `code`, with a DBML hint's `at that line` made
 * `at line N` when the line is known. A `dbmlStructure` with a parser
 * (binding) code is fixed where the parser points.
 */
function kindHint(kind: TableFileErrorKind, line: number | undefined, code?: string): string {
  let hint = TABLE_FILE_HINTS[kind];
  if (kind === 'dbmlInvalid' && code !== undefined && DBML_TABLE_QUOTE_HINT_CODES.has(code)) {
    hint = `${hint} — ${DBML_QUOTE_ADVICE}`;
  } else if (kind === 'dbmlStructure' && code !== undefined) {
    hint = DBML_STRUCTURE_HINTS[code] ?? (code.startsWith('structure:') ? hint : TABLE_FILE_HINTS.dbmlInvalid);
  }
  return line !== undefined ? hint.replace('at that line', `at line ${line}`) : hint;
}

/**
 * The advice an AI assistant reads for an unreadable model file (doctor's
 * next step, diff's fix): the merge-conflict one, else its kind's. Which side
 * of a conflict to keep is the user's call — it is usually a teammate's work —
 * so the conflict advice asks the assistant to show it, not to resolve it.
 */
export function unreadableHint(u: Pick<UnreadableTableFile, 'kind' | 'mergeConflict' | 'readable' | 'key' | 'line' | 'code'>): string {
  if (u.readable) {
    return `${u.key ? `\`${u.key}\`` : 'a key'} is written twice in one block — the last copy is what loads; `
      + 'delete the other copy (ERD Studio will not change this file until you do)';
  }
  return u.mergeConflict
    ? 'unresolved git merge conflict — git left two versions there: show the user the file and line and ask which side '
      + "to keep (don't pick a side or run git commands yourself)"
    : kindHint(u.kind, u.line, u.code);
}

/** The terminal line's advice for a conflicted file: short, and it picks no side. */
export function mergeConflictHumanHint(rerun: 'doctor' | 'diff'): string {
  return `unresolved git merge conflict — resolve it (keep one side), save, then re-run ${rerun}`;
}

/** A {@link TableFileError} as the CLI reports it: project-relative, redacted. */
export function toUnreadableTableFile(root: string, err: TableFileError): UnreadableTableFile {
  const file = relPath(root, err.filePath);
  return {
    name: err.name,
    file,
    kind: err.kind,
    ...(err.line !== undefined ? { line: err.line } : {}),
    ...(err.column !== undefined ? { column: err.column } : {}),
    ...(err.code !== undefined ? { code: err.code } : {}),
    ...(err.mergeConflict ? { mergeConflict: true as const } : {}),
    ...(err.readable ? { readable: true as const } : {}),
    ...(err.key !== undefined ? { key: err.key } : {}),
    message: redactPaths(err.message.split(err.filePath).join(file)),
  };
}

/**
 * `fct_order.yml line 4: YAML error (BLOCK_AS_IMPLICIT_KEY) — wrap the value in double quotes`,
 * for the terminal; `rerun` names the command to run again once a conflict is resolved.
 */
export function describeUnreadable(u: UnreadableTableFile, rerun: 'doctor' | 'diff'): string {
  const where = `${path.posix.basename(u.file)}${u.line !== undefined ? ` line ${u.line}` : ''}`;
  if (u.mergeConflict) { return `${where}: ${mergeConflictHumanHint(rerun)}`; }
  if (u.readable) { return `${where}: ${unreadableHint(u)}`; }
  const format = u.kind.startsWith('dbml') ? 'DBML' : 'YAML';
  const what = u.kind === 'read' ? 'could not be read' : `${format} error${u.code ? ` (${u.code})` : ''}`;
  return u.kind === 'read' ? `${where}: ${TABLE_FILE_HINTS.read}` : `${where}: ${what} — ${kindHint(u.kind, u.line, u.code)}`;
}

export interface SubjectAreaDiff {
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
  unreadableModelFiles: UnreadableTableFile[];
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
  domains: SubjectAreaDiff[];
}

export interface DiffOptions {
  domains?: string[];
  all?: boolean;
  strict?: boolean;
  cwd?: string;
}

/** Resolve a `--domain` argument: as given (from the cwd), else relative to the project root. */
export function resolveSubjectAreaPath(ctx: CliContext, arg: string, cwd: string = process.cwd()): string {
  const candidates = path.isAbsolute(arg) ? [arg] : [path.resolve(cwd, arg), path.resolve(ctx.root, arg)];
  const hit = candidates.find((c) => fs.existsSync(c));
  if (!hit) {
    throw new CliEnvError('domain-missing', `Subject area file not found: ${redactPaths(arg)}`);
  }
  return hit;
}

/**
 * The advice for a diagram holding git merge conflicts (#145), in place of
 * core's neutral message (which the Confluence app shows as is): the same
 * line doctor's `resolve-merge-conflicts` step and {@link unreadableHint}
 * take — the assistant reading `diff` / `export` shows the user the file and
 * line and leaves the choice of side to them.
 */
export function conflictedSubjectAreaMessage(file: string, line: number | undefined): string {
  return `${file} has unresolved git merge conflicts${line !== undefined ? ` (first at line ${line})` : ''}: `
    + 'git left two versions there. Show the user the file and line; if only positions differ either side is safe to keep, '
    + "otherwise ask the user which side to keep. Don't pick a side or run git commands yourself.";
}

/**
 * Map a thrown domain-load error to a stable code and a redacted message with
 * the project-relative path. Shared with `export --domain`, so one broken file
 * reads the same from both subcommands.
 */
export function describeSubjectAreaError(ctx: CliContext, file: string, err: unknown): { code: string; message: string } {
  const rel = relPath(ctx.root, file);
  const raw = err instanceof Error ? err.message : String(err);
  const message = redactPaths(raw.split(file).join(rel));
  if (err instanceof SubjectAreaFileError) {
    if (err.mergeConflict) { return { code: 'merge-conflict', message: conflictedSubjectAreaMessage(rel, err.line) }; }
    // A `.dbml` diagram that does not parse: named with its file and line.
    if (err.reason === 'invalid-dbml') {
      return { code: 'dbml-invalid', message: `${rel}${err.line !== undefined ? `:${err.line}` : ''}: ${message}` };
    }
    return { code: err.reason === 'missing' ? 'domain-missing' : 'domain-invalid', message };
  }
  // A `--domain` that is a table, relationships or layout file, not a diagram.
  if (/is a DBML table or relationships file, not a diagram/.test(raw) || file.endsWith('.dbdiagram')) {
    return { code: 'not-a-diagram', message };
  }
  if (/invalid layer/.test(raw)) { return { code: 'unknown-layer', message }; }
  if (/pre-v\d|mixes inline (?:model|table)|schemaVersion|erd_schema_version/.test(raw)) { return { code: 'unsupported-format', message }; }
  return { code: 'domain-invalid', message };
}

const SEVERITY_ORDER: Record<Fix['severity'], number> = { blocking: 0, advisory: 1 };

const pickRelationship = (r: NonNullable<Fix['relationship']>): NonNullable<Fix['relationship']> =>
  ({ fromModel: r.fromModel, fromColumn: r.fromColumn, toModel: r.toModel, toColumn: r.toColumn, ...(r.cardinality ? { cardinality: r.cardinality } : {}) });

/** A composite's pairs read from the other end. */
const reversePairs = (pairs: readonly ColumnPair[]): ColumnPair[] => pairs.map((p) => ({ fromColumn: p.toColumn, toColumn: p.fromColumn }));
/** `pit_customer (customer_hk, as_of_date) → sat_customer (customer_hk, load_date)`. */
const describeComposite = (from: string, to: string, pairs: readonly ColumnPair[]): string =>
  `${from} (${pairs.map((p) => p.fromColumn).join(', ')}) → ${to} (${pairs.map((p) => p.toColumn).join(', ')})`;

function sortFixes(fixes: Fix[]): Fix[] {
  return fixes.sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || a.model.localeCompare(b.model)
    || (a.column ?? '').localeCompare(b.column ?? '')
    || a.kind.localeCompare(b.kind));
}

/** Where a domain's relationships are defined, so a relationship fix names the right file. */
export interface RelationshipHome {
  /** The model-library entry this domain draws for each link it draws from a yml, by `linkKey`. */
  inLibrary: ReadonlyMap<string, Relationship>;
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
  phantoms: SubjectAreaDiff['phantoms'],
  unreadable: UnreadableTableFile[] = [],
  relationshipHome: RelationshipHome = { inLibrary: new Map(), addToLibrary: false },
): Fix[] {
  const ymlFile = (model: string): string =>
    plan.modelContext[model]?.logicalModelPath ?? `${semanticDir}/logical-models/${model}.yml`;
  // A relationship is fixed where it is defined (#126): the yml of the model
  // holding its foreign key when the library holds it, else the domain file.
  // A new one goes where the project keeps relationships.
  const relationshipFile = (r: Parameters<typeof linkKey>[0], adding: boolean): string =>
    (adding ? relationshipHome.addToLibrary : relationshipHome.inLibrary.has(linkKey(r)))
      ? ymlFile(r.fromModel)
      : domainFile;
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
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
            ? `dbt has a column ${where} (${physicalType}) that the logical table is missing — add it.`
            : `dbt has a column ${where} that the logical table is missing — add it (dbt has no type for it yet, so use your best guess).`,
        });
        break;
      case 'remove-column-from-logical':
        fixes.push({
          severity: 'blocking', kind: 'remove-column', model: c.modelName, column: c.columnName, file: ymlFile(c.modelName),
          explain: `The logical table has a column ${where} that dbt does not have — remove it (and any relationship that uses it).`,
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
            : `${where} is ${logicalType || 'untyped'} in the logical table but ${physicalType} in dbt — change the logical type to ${physicalType}.`,
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
    // A composite foreign key (#133 L2) is one fix for all its pairs, stored
    // from its canonical (many) side like any other relationship.
    const pairs = r.pairs && r.pairs.length >= 2 ? r.pairs : undefined;
    const canonicalPairs = (cardinality: Cardinality | undefined): { fromModel: string; toModel: string; pairs: ColumnPair[] } =>
      cardinality === 'one-to-many'
        ? { fromModel: r.toModel, toModel: r.fromModel, pairs: reversePairs(pairs!) }
        : { fromModel: r.fromModel, toModel: r.toModel, pairs: [...pairs!] };
    if (pairs && r.composite) {
      const c = canonicalPairs(r.sourceCardinality);
      const cardinality = r.sourceCardinality === 'one-to-many' ? 'many-to-one' : r.sourceCardinality;
      fixes.push({
        severity: 'advisory', kind: 'declare-composite-foreign-key', model: c.fromModel, column: c.pairs[0].fromColumn, file: ymlFile(c.fromModel),
        relationship: {
          fromModel: c.fromModel, fromColumn: c.pairs[0].fromColumn, toModel: c.toModel, toColumn: c.pairs[0].toColumn,
          ...(cardinality ? { cardinality } : {}), pairs: c.pairs, ...(r.compositeKey ? { compositeKey: r.compositeKey } : {}),
        },
        explain: `The logical stage draws the composite foreign key ${describeComposite(c.fromModel, c.toModel, c.pairs)}, and dbt declares none. `
          + `Nothing to change in the logical stage. To make dbt check it, add a model-level \`foreign_key\` constraint to ${c.fromModel} `
          + `(\`columns: [${c.pairs.map((p) => p.fromColumn).join(', ')}]\`, \`to: ref('${c.toModel}')\`, \`to_columns: [${c.pairs.map((p) => p.toColumn).join(', ')}]\`, `
          + 'dbt 1.9+ with an enforced contract) or a `dbt_constraints.foreign_key` test.',
      });
      continue;
    }
    switch (r.action) {
      case 'add-relationship-to-logical': {
        if (pairs) {
          const c = canonicalPairs(r.targetCardinality);
          const cardinality = r.targetCardinality === 'one-to-many' ? 'many-to-one' : (r.targetCardinality ?? 'many-to-one');
          const stored = { fromModel: c.fromModel, fromColumn: c.pairs[0].fromColumn, toModel: c.toModel, toColumn: c.pairs[0].toColumn };
          const name = r.compositeKey ?? `fk_${c.toModel}`.toLowerCase();
          fixes.push({
            severity: 'blocking', kind: 'add-relationship', model: c.fromModel, column: c.pairs[0].fromColumn, file: relationshipFile(stored, true),
            relationship: { ...stored, cardinality, pairs: c.pairs, compositeKey: name },
            explain: `dbt declares the composite foreign key ${describeComposite(c.fromModel, c.toModel, c.pairs)}, but the logical stage `
              + `does not draw it — add it to the logical stage as ${c.pairs.length} entries sharing \`compositeKey: ${name}\`.`,
          });
          break;
        }
        // Written on its many side (#133): a one-to-many is the same link
        // stored from the other end, in the other model's file.
        const stored = r.targetCardinality ? canonicalRelationship({ ...rel, cardinality: r.targetCardinality }) : rel;
        fixes.push({
          severity: 'blocking', kind: 'add-relationship', model: stored.fromModel, column: stored.fromColumn, file: relationshipFile(stored, true),
          relationship: stored,
          explain: `dbt tests the link ${link}, but the logical stage does not draw it — add the relationship.`,
        });
        break;
      }
      case 'remove-relationship-from-logical': {
        // The entry as it is stored, so it can be found in its file.
        const stored = relationshipHome.inLibrary.get(linkKey(rel));
        const entry = stored ?? { ...rel, ...(r.sourceCardinality ? { cardinality: r.sourceCardinality } : {}) };
        fixes.push({
          severity: 'blocking', kind: 'remove-relationship', model: entry.fromModel, column: entry.fromColumn, file: relationshipFile(entry, false),
          relationship: pickRelationship(entry),
          explain: `The logical stage draws ${link}, but dbt has no relationships test for it — remove it, or add the test to dbt.`,
        });
        break;
      }
      case 'update-cardinality-in-logical': {
        // In the model library, the entry to write is the canonical one (#133),
        // in the file of its many side — which may be the other model's.
        const stored = relationshipHome.inLibrary.get(linkKey(rel));
        let entry: Relationship = { ...rel, cardinality: r.targetCardinality ?? 'many-to-one' };
        let movesFrom: string | undefined;
        if (stored) {
          // One-to-one and many-to-many keep the direction they are stored in.
          if (entry.cardinality !== 'many-to-one' && entry.cardinality !== 'one-to-many' && !same(stored.fromModel, entry.fromModel)) {
            entry = reverseRelationship(entry);
          }
          entry = canonicalRelationship(entry);
          if (!same(stored.fromModel, entry.fromModel)) movesFrom = ymlFile(stored.fromModel);
        }
        const file = stored ? ymlFile(entry.fromModel) : domainFile;
        // A composite's pairs, read from the end the entry is stored from.
        const entryPairs = pairs && (same(entry.fromModel, r.fromModel) && same(entry.fromColumn, r.fromColumn) ? [...pairs] : pairs && reversePairs(pairs));
        fixes.push({
          severity: 'blocking', kind: 'set-cardinality', model: entry.fromModel, column: entry.fromColumn, file,
          from: r.sourceCardinality, to: r.targetCardinality,
          relationship: { ...pickRelationship(entry), ...(entryPairs ? { pairs: entryPairs, ...(r.compositeKey ? { compositeKey: r.compositeKey } : {}) } : {}) },
          ...(movesFrom ? { movesFrom } : {}),
          explain: (entryPairs ? `The composite foreign key ${describeComposite(entry.fromModel, entry.toModel, entryPairs)}` : link) +
            ` is ${r.sourceCardinality} in the logical stage but ${r.targetCardinality} according to dbt's tests — ` +
            (movesFrom
              ? `store it as ${entry.fromModel}.${entry.fromColumn} → ${entry.toModel}.${entry.toColumn} ${entry.cardinality} in ${file}, and take it out of ${movesFrom}`
              : `change it to ${entry.cardinality}${stored && entry.cardinality !== r.targetCardinality ? ` (stored from ${entry.fromModel})` : ''}`) +
            (entryPairs ? `; set \`cardinality\` on every entry of ${r.compositeKey ? `compositeKey ${r.compositeKey}` : 'the composite key'}.` : '.'),
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
        ? `${p.name} is disabled in dbt — ask whether to remove it from this subject area or re-enable it in dbt.`
        : `dbt has no model called ${p.name} — ask whether it is a typo for a real model, or should be removed from this subject area.`,
    });
  }
  for (const u of unreadable) {
    fixes.push({
      severity: 'blocking', kind: 'fix-model-yaml', model: u.name, file: u.file,
      ...(u.line !== undefined ? { line: u.line } : {}),
      explain: u.mergeConflict
        ? `${u.file}${u.line !== undefined ? ` line ${u.line}` : ''}: ${unreadableHint(u)}. Raise this before anything `
          + 'else — until it is resolved, ERD Studio sees the table as empty and every other difference for it is meaningless.'
        : `${describeUnreadable(u, 'diff')}. Fix this file before anything else — until it parses, `
          + 'ERD Studio sees the table as empty and every other difference for it is meaningless.',
    });
  }
  // A model-level resolution would only arise for a model compare() did not
  // hide; surface it as a phantom question rather than dropping it silently.
  for (const m of plan.models) {
    if (phantomNames.has(m.modelName)) { continue; }
    fixes.push({
      severity: 'blocking', kind: 'resolve-phantom', model: m.modelName, file: domainFile,
      explain: `${m.modelName} is in only one of the two views — ask the user whether to keep it in this subject area.`,
    });
  }

  return sortFixes(fixes);
}

/** Compare one domain file. Load errors are thrown (the caller decides between exit 3 and `domains[i].error`). */
export function diffSubjectArea(ctx: CliContext, file: string, strict: boolean): SubjectAreaDiff {
  const rel = relPath(ctx.root, file);

  // The v4 probe is for JSON files only: a `.dbml` diagram is never v4.
  let raw: unknown;
  try {
    raw = subjectAreaStorageOf(file) === 'json' ? JSON.parse(fs.readFileSync(file, 'utf-8')) : undefined;
  } catch {
    raw = undefined; // getSubjectArea below produces the precise error
  }
  const format = raw === undefined ? null : detectSubjectAreaFormat(raw);

  // A v4 (inline-model) file gets the migration answer before anything tries
  // the v5 load path — the migration command is what fixes it, whatever else
  // that load might have tripped over (an unknown layer, say). A file with no
  // numeric schemaVersion also detects as v4, but it is not a v4 domain —
  // getSubjectArea reports that one precisely.
  const obj = (raw ?? {}) as { domain?: unknown; layer?: unknown; schemaVersion?: unknown };
  if (format === 'v4' && typeof obj.schemaVersion === 'number') {
    return {
      file: rel,
      domain: typeof obj.domain === 'string' ? obj.domain : path.basename(file, path.extname(file)),
      layer: typeof obj.layer === 'string' ? obj.layer : path.basename(path.dirname(file)),
      clean: false,
      counts: { blocking: 0, advisory: 0, matchedModels: 0, matchedColumns: 0, matchedRelationships: 0 },
      phantoms: [],
      missingModelFiles: [],
      unreadableModelFiles: [],
      modelsWithoutColumns: [],
      fixes: [],
      needsMigration: true,
    };
  }

  const { unified, target, report } = computeSubjectAreaDiff(
    { subjectAreaService: ctx.subjectAreaService, ymlData: ctx.ymlData, manifest: ctx.manifest, catalog: ctx.catalog },
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
    modelFolder: (name) => ctx.tableLibraryService.tableFolder(name),
    tableLibraryFile: (name) => ctx.tableLibraryService.tableLibraryFile(name),
    newTableLibraryDir: ctx.tableLibraryService.newTableLibraryDirName(),
  });
  const unreadableModelFiles = unreadableTables(ctx, unified);
  // The entry each link is drawn from (core's read winner), keyed by link.
  const libraryLines = mergeLibraryRelationships(unified.logical.models, []);
  const relationshipHome: RelationshipHome = {
    inLibrary: new Map(libraryLines.map((line) => [linkKey(line), line])),
    addToLibrary: usesLibraryRelationships(
      ctx.tableLibraryService.listTables(),
      ctx.subjectAreaService.countSubjectAreaFileRelationships(ctx.root, ctx.semanticDir),
      ctx.tableLibraryService.hasUnreadableRelationships(),
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
    missingModelFiles: missingTableFiles(ctx, unified),
    unreadableModelFiles,
    modelsWithoutColumns,
    fixes,
    report,
    plan,
  };
}

function missingTableFiles(ctx: CliContext, unified: UnifiedSubjectArea): string[] {
  return unified.logical.models
    .map((m) => m.name)
    .filter((name) => !ctx.tableLibraryService.tableExists(name));
}

function unreadableTables(ctx: CliContext, unified: UnifiedSubjectArea): UnreadableTableFile[] {
  const out: UnreadableTableFile[] = [];
  for (const m of unified.logical.models) {
    const err = ctx.tableLibraryService.getTableFileError(m.name);
    if (err) { out.push(toUnreadableTableFile(ctx.root, err)); }
  }
  return out;
}

/**
 * Every domain under the semantic dir, for `--all` (`diff` and `export`).
 * `--all` over nothing must never read as a result: a wrong or omitted
 * `--semantic-dir` (the CLI cannot see VS Code settings) would otherwise
 * hand the skill a verified match — or an empty export — over zero domains.
 * So no folder is `no-semantic-dir` and no domain is `no-domains` (exit 3).
 */
export function listAllSubjectAreas(ctx: CliContext): SubjectAreaSummary[] {
  const semanticRoot = path.join(ctx.root, ctx.semanticDir);
  if (!fs.existsSync(semanticRoot)) {
    throw new CliEnvError(
      'no-semantic-dir',
      `No ${ctx.semanticDir}/ folder in this project — check --semantic-dir (it must match the erdStudio.semanticDir setting).`,
    );
  }
  const summaries = ctx.subjectAreaService.listSubjectAreas(ctx.root, ctx.semanticDir);
  if (summaries.length === 0) {
    throw new CliEnvError(
      'no-domains',
      `No subject area files under ${ctx.semanticDir}/ — check --semantic-dir (it must match the erdStudio.semanticDir setting).`,
    );
  }
  return summaries;
}

/** `diff` in a logical-only folder (no dbt_project.yml): exit 3, `not-dbt-project`. */
export const DIFF_NEEDS_DBT_MESSAGE =
  'diff compares your design with what dbt built, so it needs a dbt project — this folder has no dbt_project.yml. '
  + 'Run it from the folder that holds dbt_project.yml, or pass --project <dir>. doctor, inventory and export work without one.';

/**
 * Run the diff. A logical-only project has nothing to compare with: a
 * `CliEnvError` (`not-dbt-project`, exit 3). `--domain` files that cannot be compared are a `CliEnvError`
 * (exit 3); under `--all` each failure is recorded on its own domain entry so
 * one broken file does not hide the rest.
 */
export function runDiff(ctx: CliContext, opts: DiffOptions): { result: DiffResult; exitCode: 0 | 1 } {
  if (!ctx.hasDbt) { throw new CliEnvError('not-dbt-project', DIFF_NEEDS_DBT_MESSAGE); }
  const domains: SubjectAreaDiff[] = [];

  if (opts.all) {
    for (const summary of listAllSubjectAreas(ctx)) {
      try {
        domains.push(diffSubjectArea(ctx, summary.filePath, opts.strict === true));
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
          error: describeSubjectAreaError(ctx, summary.filePath, err),
        });
      }
    }
  } else {
    for (const arg of opts.domains ?? []) {
      const file = resolveSubjectAreaPath(ctx, arg, opts.cwd);
      try {
        domains.push(diffSubjectArea(ctx, file, opts.strict === true));
      } catch (err) {
        const { code, message } = describeSubjectAreaError(ctx, file, err);
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
