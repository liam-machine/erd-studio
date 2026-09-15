/**
 * Discrepancy service — compares two DisplayDomains to produce a cross-stage
 * discrepancy report.
 *
 * Pure functions with no I/O or side effects. Runs on the extension host.
 *
 * Usage:
 *   compare(physicalDomain, logicalDomain) → DiscrepancyReport
 */

import type { DisplayDomain, DisplayModel, DisplayRelationship } from '../types/display';
import type {
  DiscrepancyReport,
  ModelDiscrepancy,
  ColumnDiscrepancy,
  RelationshipDiscrepancy,
} from '../types/discrepancy';
import { normaliseName } from './nameUtils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Composite key for matching relationships across stages.
 * Model and column names are matched case-insensitively (dbt identifiers are
 * case-insensitive on most warehouses); raw names are preserved on the
 * resulting discrepancy entries for display.
 */
function relationshipKey(r: { fromModel: string; fromColumn: string; toModel: string; toColumn: string }): string {
  return [r.fromModel, r.fromColumn, r.toModel, r.toColumn].map(normaliseName).join('|');
}

/**
 * Alias map: the spellings dbt adapters actually emit → canonical type name.
 *
 * Applied to the *base* name only (see `splitDataType`), after lowercasing and
 * whitespace collapsing, so multi-word Postgres spellings such as
 * `character varying` and `timestamp without time zone` are keys in their own
 * right. Snowflake reports bare types with no precision at all (`TEXT`,
 * `NUMBER`, `TIMESTAMP_NTZ`), Postgres/Redshift carry precision and multi-word
 * names via `format_type()`, BigQuery uses `INT64` / `ARRAY<…>` and Databricks
 * `decimal(p,s)` / `array<…>` — all four have to land on the same canon.
 */
const TYPE_ALIASES: Record<string, string> = {
  // String family
  varchar:             'string',
  'character varying': 'string',
  character:           'string',
  text:                'string',
  char:                'string',
  nvarchar:            'string',
  nchar:               'string',
  ntext:               'string',
  // Integer family
  integer:  'int',
  tinyint:  'int',
  smallint: 'int',
  int64:    'int',
  int2:     'int',
  int4:     'int',
  // Big integer family
  bigint:   'bigint',
  int8:     'bigint',
  // Numeric / decimal family
  numeric:     'decimal',
  number:      'decimal',
  bignumeric:  'decimal',
  // Float family
  float:              'double',
  real:               'double',
  float64:            'double',
  'double precision': 'double',
  float4:             'double',
  float8:             'double',
  // Boolean family
  bool:     'boolean',
  // Timestamp family — naive (no zone)
  'timestamp without time zone': 'timestamp',
  timestamp_ntz:                 'timestamp',
  datetime:                      'timestamp',
  datetime2:                     'timestamp',
  // Timestamp family — zone-aware. TIMESTAMP_LTZ/TZ store an instant, so they
  // belong here rather than with the naive spellings.
  'timestamp with time zone': 'timestamptz',
  timestamp_tz:               'timestamptz',
  timestamp_ltz:              'timestamptz',
  // Time family
  'time without time zone': 'time',
  'time with time zone':    'time',
  // Binary family
  bytea:     'binary',
  blob:      'binary',
  varbinary: 'binary',
  bytes:     'binary',
  // JSON family
  jsonb:    'json',
  // Semi-structured family
  super:    'variant',
};

/** A data type split into its base name and its parameter list. */
interface SplitType {
  /** Canonical-ready base name, e.g. `character varying`, `timestamp without time zone`. */
  base: string;
  /** Whitespace-stripped parameter text, e.g. `255`, `10,2`, `string`. Empty when unparameterised. */
  params: string;
}

/** Closing delimiter for each opener a warehouse type can use. */
const TYPE_DELIMITERS: Record<string, string> = { '(': ')', '<': '>' };

/** Collapse runs of whitespace and trim. */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Split a raw data type into base name + parameters, tolerating the delimiter
 * shapes real adapters emit.
 *
 * A naive "everything before the first `(`" split is wrong for Postgres, whose
 * `format_type()` puts the parameter in the *middle* of the name:
 * `timestamp(6) without time zone` has to reduce to a base of
 * `timestamp without time zone`, not to `timestamp` plus an opaque suffix that
 * no alias can ever match. BigQuery and Databricks parameterise with angle
 * brackets (`ARRAY<STRING>`, `map<string,int>`), which nest, so the closer is
 * found with a depth counter rather than a search.
 */
function splitDataType(raw: string | undefined): SplitType {
  if (!raw) return { base: '', params: '' };
  const t = raw.trim().toLowerCase();

  let open = -1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(' || t[i] === '<') { open = i; break; }
  }
  if (open < 0) return { base: collapseWhitespace(t), params: '' };

  const opener = t[open];
  const closer = TYPE_DELIMITERS[opener];
  let depth = 0;
  let close = -1;
  for (let i = open; i < t.length; i++) {
    if (t[i] === opener) {
      depth++;
    } else if (t[i] === closer) {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }

  // An unbalanced type is malformed; treat everything after the opener as the
  // parameter text rather than throwing it away.
  const inner = close >= 0 ? t.slice(open + 1, close) : t.slice(open + 1);
  const after = close >= 0 ? t.slice(close + 1) : '';

  return {
    base: collapseWhitespace(`${t.slice(0, open)} ${after}`),
    params: collapseWhitespace(inner).replace(/\s*,\s*/g, ','),
  };
}

/** Map a split type's base name through the alias table. */
function canonicaliseType(raw: string | undefined): SplitType {
  const split = splitDataType(raw);
  if (!split.base) return { base: '', params: split.params };
  return { base: TYPE_ALIASES[split.base] ?? split.base, params: split.params };
}

/** Canonical bases that count as whole numbers for the decimal↔integer rule. */
const INTEGER_BASES = new Set(['int', 'bigint']);

/**
 * True when a decimal is really an integer: `NUMBER` (Snowflake reports every
 * numeric column bare), `numeric(10)` (SQL defaults the scale to 0) or an
 * explicit scale of 0.
 */
function isWholeNumberDecimal(t: SplitType): boolean {
  if (t.base !== 'decimal') return false;
  if (!t.params) return true;
  const parts = t.params.split(',');
  return parts.length === 1 || Number(parts[1]) === 0;
}

/**
 * Normalise a data type string for comparison purposes.
 *
 * Steps:
 * 1. Lowercase and trim
 * 2. Split base name from parameters with a matched-delimiter scan, so
 *    `timestamp(6) without time zone` → base `timestamp without time zone`
 * 3. Strip whitespace inside the parameters: `decimal( 15 , 5 )` → `15,5`
 * 4. Map the base through the alias table (varchar → string, integer → int, …)
 *
 * The result is `canonical` or `canonical(params)`; angle-bracket parameters
 * come back in parentheses because the form is only ever compared, never shown.
 * The original (un-normalised) strings are still stored on the discrepancy
 * result so the UI shows what the user actually typed / what dbt reports.
 */
export function normaliseDataType(raw: string | undefined): string {
  const { base, params } = canonicaliseType(raw);
  if (!base) return '';
  return params ? `${base}(${params})` : base;
}

/**
 * Compare two data type strings.
 *
 * Beyond the canonical-name match this is deliberately tolerant in exactly two
 * places, because the alternative is a report full of noise:
 *
 * - **Parameters are optional on either side.** `decimal(15,2)` matches a bare
 *   `decimal` and `varchar(255)` matches `string`; two *different* parameter
 *   lists still conflict.
 * - **A whole-number decimal is an integer**, in either direction. This is the
 *   one cross-family rule, and without it every integer column on a Snowflake
 *   project mismatches: the catalog reports them as bare `NUMBER`.
 *
 * An empty type on either side is not a difference — `compareColumns` reports
 * that case as `undeclared` instead.
 */
function dataTypesMatch(a: string | undefined, b: string | undefined): boolean {
  const left = canonicaliseType(a);
  const right = canonicaliseType(b);

  if (!left.base || !right.base) return true;

  if (left.base === right.base) {
    return !left.params || !right.params || left.params === right.params;
  }

  return (
    (isWholeNumberDecimal(left) && INTEGER_BASES.has(right.base)) ||
    (isWholeNumberDecimal(right) && INTEGER_BASES.has(left.base))
  );
}

/**
 * True when a model's shape is unknown rather than empty.
 *
 * A model found only as a `.sql`/`.py`/`.csv` file on disk has no column list
 * anywhere — not in a schema .yml, not in the manifest, not in the catalog — so
 * comparing it column by column would report the other side's entire column
 * list as a difference. That is a wall of rows and sync actions about a model
 * nobody has documented, not a finding.
 *
 * Distinct from the user-controlled `stubColumns` list, which suppresses only
 * target-side extras on models the user has told us are deliberately partial.
 * This one is automatic and fires only when there is no evidence at all.
 */
function hasNoColumnEvidence(m: DisplayModel): boolean {
  return m.columns.length === 0
    && m.provenance?.columns.length === 1
    && m.provenance.columns[0] === 'file';
}

/**
 * Compare columns between two matched models.
 *
 * @param stubColumns - When true, columns that exist in the target but not the
 *   source are suppressed. Used for stub/reference models where only a few key
 *   columns (PK/NK) are defined in logical — the physical model may have many
 *   more columns that should not surface as discrepancies.
 */
function compareColumns(
  sourceModel: DisplayModel,
  targetModel: DisplayModel,
  stubColumns: boolean,
): ColumnDiscrepancy[] {
  // Checked on BOTH sides: physical is the default comparison SOURCE, and an
  // empty source column list makes every logical column report as 'missing'.
  if (hasNoColumnEvidence(sourceModel) || hasNoColumnEvidence(targetModel)) { return []; }

  // Keyed by normalised name so `CUSTOMER_ID` (yml) matches `customer_id` (logical).
  const targetColumnMap = new Map(targetModel.columns.map((c) => [normaliseName(c.name), c]));
  const visited = new Set<string>();
  const result: ColumnDiscrepancy[] = [];

  for (const col of sourceModel.columns) {
    const key = normaliseName(col.name);
    const targetCol = targetColumnMap.get(key);
    visited.add(key);

    if (!targetCol) {
      result.push({ name: col.name, status: 'extra', sourceDataType: col.dataType });
      continue;
    }

    // A stage that declares no type conflicts with nothing — but it is not the
    // same thing as agreement either, so it gets its own status rather than
    // inflating the type-mismatch count (which is what it used to do on every
    // project whose dbt yml omits `data_type:`). Both raw types travel with the
    // entry so the panel can render `logical: bigint` / `physical: (none)`, and
    // `deriveColumnAction` still turns it into an update-type action.
    const sourceDeclared = normaliseDataType(col.dataType) !== '';
    const targetDeclared = normaliseDataType(targetCol.dataType) !== '';

    if (sourceDeclared !== targetDeclared) {
      result.push({
        name: col.name,
        status: 'undeclared',
        sourceDataType: col.dataType,
        targetDataType: targetCol.dataType,
      });
    } else if (sourceDeclared && !dataTypesMatch(col.dataType, targetCol.dataType)) {
      result.push({
        name: col.name,
        status: 'type-mismatch',
        sourceDataType: col.dataType,
        targetDataType: targetCol.dataType,
      });
    } else {
      result.push({ name: col.name, status: 'matched' });
    }
  }

  // Columns in target but not source — suppressed for stub models
  if (!stubColumns) {
    for (const col of targetModel.columns) {
      if (!visited.has(normaliseName(col.name))) {
        result.push({ name: col.name, status: 'missing', targetDataType: col.dataType });
      }
    }
  }

  return result;
}

/**
 * Compare relationships between source and target domains.
 */
function compareRelationships(
  sourceRels: DisplayRelationship[],
  targetRels: DisplayRelationship[],
): RelationshipDiscrepancy[] {
  const targetMap = new Map(targetRels.map((r) => [relationshipKey(r), r]));
  const visited = new Set<string>();
  const result: RelationshipDiscrepancy[] = [];

  for (const rel of sourceRels) {
    const key = relationshipKey(rel);
    const targetRel = targetMap.get(key);
    visited.add(key);

    if (!targetRel) {
      result.push({
        fromModel: rel.fromModel,
        fromColumn: rel.fromColumn,
        toModel: rel.toModel,
        toColumn: rel.toColumn,
        status: 'extra',
        sourceCardinality: rel.cardinality,
      });
    } else if (rel.cardinality !== targetRel.cardinality) {
      result.push({
        fromModel: rel.fromModel,
        fromColumn: rel.fromColumn,
        toModel: rel.toModel,
        toColumn: rel.toColumn,
        status: 'cardinality-mismatch',
        sourceCardinality: rel.cardinality,
        targetCardinality: targetRel.cardinality,
      });
    } else {
      result.push({
        fromModel: rel.fromModel,
        fromColumn: rel.fromColumn,
        toModel: rel.toModel,
        toColumn: rel.toColumn,
        status: 'matched',
      });
    }
  }

  // Relationships in target but not source
  for (const rel of targetRels) {
    if (!visited.has(relationshipKey(rel))) {
      result.push({
        fromModel: rel.fromModel,
        fromColumn: rel.fromColumn,
        toModel: rel.toModel,
        toColumn: rel.toColumn,
        status: 'missing',
        targetCardinality: rel.cardinality,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main compare function
// ---------------------------------------------------------------------------

/**
 * Compare two display domains and produce a discrepancy report.
 *
 * @param source - The domain being viewed (e.g., physical)
 * @param target - The domain being compared against (e.g., logical)
 * @param stubColumnModels - Model names whose physical-only (missing) column
 *   discrepancies should be suppressed. See UnifiedDomain.stubColumns.
 */
export function compare(
  source: DisplayDomain,
  target: DisplayDomain,
  stubColumnModels: ReadonlySet<string> = new Set(),
): DiscrepancyReport {
  // Models the dbt project does not have are dropped from BOTH sides before
  // anything is compared. The physical stage now emits them so the canvas can
  // ghost them, but a phantom carries no shape to compare — including it would
  // report a model as 'matched' with its whole column list 'missing'. Filtering
  // once here keeps the report byte-identical to the pre-ghost behaviour: from
  // logical the model is still 'extra', from physical it is still 'missing'.
  const sourceModels = source.models.filter((m) => m.existsInProject !== false);
  const targetModels = target.models.filter((m) => m.existsInProject !== false);

  // Model matching is case-insensitive; report entries keep the raw names.
  const targetModelMap = new Map(targetModels.map((m) => [normaliseName(m.name), m]));
  const stubModelKeys = new Set(Array.from(stubColumnModels, normaliseName));
  const visitedModels = new Set<string>();
  const models: ModelDiscrepancy[] = [];

  let totalColumns = 0;
  let matchedColumns = 0;
  let extraColumns = 0;
  let missingColumns = 0;
  let dataTypeMismatches = 0;
  let undeclaredColumns = 0;

  // Compare source models against target
  for (const model of sourceModels) {
    const modelKey = normaliseName(model.name);
    const targetModel = targetModelMap.get(modelKey);
    visitedModels.add(modelKey);

    if (!targetModel) {
      const extraCols: ColumnDiscrepancy[] = model.columns.map((c) => ({
        name: c.name,
        status: 'extra' as const,
        sourceDataType: c.dataType,
      }));
      models.push({ name: model.name, status: 'extra', columns: extraCols });
      totalColumns += model.columns.length;
      extraColumns += model.columns.length;
    } else {
      const isStub = stubModelKeys.has(modelKey);
      const columns = compareColumns(model, targetModel, isStub);
      models.push({ name: model.name, status: 'matched', columns });

      for (const col of columns) {
        totalColumns++;
        switch (col.status) {
          case 'matched': matchedColumns++; break;
          case 'extra': extraColumns++; break;
          case 'missing': missingColumns++; break;
          case 'type-mismatch': dataTypeMismatches++; break;
          case 'undeclared': undeclaredColumns++; break;
        }
      }
    }
  }

  // Models in target but not source
  for (const model of targetModels) {
    if (!visitedModels.has(normaliseName(model.name))) {
      const missingCols: ColumnDiscrepancy[] = model.columns.map((c) => ({
        name: c.name,
        status: 'missing' as const,
        targetDataType: c.dataType,
      }));
      models.push({ name: model.name, status: 'missing', columns: missingCols });
      totalColumns += model.columns.length;
      missingColumns += model.columns.length;
    }
  }

  const relationships = compareRelationships(source.relationships, target.relationships);

  return {
    domain: source.domain,
    layer: source.layer,
    sourceStage: source.stage,
    targetStage: target.stage,
    models,
    relationships,
    summary: {
      // Counts the filtered lists, not the raw ones: a phantom contributes no
      // row, so counting it here would make the summary disagree with the rows.
      totalModels: sourceModels.length + targetModels.filter((m) => !visitedModels.has(normaliseName(m.name))).length,
      matchedModels: models.filter((m) => m.status === 'matched').length,
      extraModels: models.filter((m) => m.status === 'extra').length,
      missingModels: models.filter((m) => m.status === 'missing').length,
      totalColumns,
      matchedColumns,
      extraColumns,
      missingColumns,
      dataTypeMismatches,
      undeclaredColumns,
    },
  };
}
