/**
 * Generated tests: the DBML round trip import → export → import, pure (no
 * files written): Import DBML's reader and planner into an empty project,
 * the plan's tables and relationships as a subject area through core's
 * `toDisplaySubjectArea` (the function the canvas and `loadDisplaySubjectArea`
 * use), exported with core's `toDbmlRich` (the repo's DBML exporter), and
 * imported again.
 *
 * {@link canonicalImport} is what must come back the same: each table's
 * name, schema and unique indexes; each column's name, type, primary-key,
 * NOT NULL and unique flags, in order;
 * each relationship as its column pairs (from the foreign-key end), its
 * cardinality and whether it is one composite link. The differences allowed
 * (and why) are listed in docs/dev/generated-tests.md.
 */
import { toDbmlRich, toDisplaySubjectArea } from '@erd-studio/core';
import type { SemanticSubjectArea } from '../../../src/types/semantic';
import { planDbmlImport, type DbmlImportPlan } from '../../../src/services/dbmlImport';
import { readDbml, readDbmlImportLayout } from '../../../src/services/dbmlImportParse';

export interface CanonicalImport {
  tables: Array<{ name: string; schema: string; columns: Array<{ name: string; type: string; pk: boolean; notNull: boolean; unique: boolean }>; uniqueKeys: string[] }>;
  relationships: string[];
}

/** Import `text` into an empty project; throws with the diagnostics when it does not read. */
export function importDbmlText(text: string, fileName = 'gen.dbml'): DbmlImportPlan {
  const read = readDbml(text);
  if (!read.ok) throw new Error(`does not read: ${JSON.stringify(read.diagnostics.slice(0, 3))}`);
  const layout = readDbmlImportLayout(text);
  return planDbmlImport({
    model: read.model,
    ...(layout ? { layout } : {}),
    layer: 'main',
    subjectAreaName: 'gen',
    fileName,
    library: { findTableName: () => null, getTable: () => null },
    libraryRelationships: false,
  });
}

/** The plan's diagram exported as rich DBML, as Export Diagram… writes it. */
export function exportPlan(plan: DbmlImportPlan): string {
  const area: SemanticSubjectArea = {
    schemaVersion: 5,
    domain: plan.subjectAreaName,
    layer: plan.layer as SemanticSubjectArea['layer'],
    stage: 'logical',
    description: plan.document.description,
    models: plan.newTables,
    relationships: plan.relationships,
  };
  const display = toDisplaySubjectArea(area, {
    viewConfig: (plan.document as { viewConfig?: object }).viewConfig ?? {},
    layerConfig: undefined,
    readOnly: false,
  } as Parameters<typeof toDisplaySubjectArea>[1]);
  return toDbmlRich(display);
}

const dbmlMeta = (m: { meta?: unknown }): Record<string, unknown> => (((m.meta ?? {}) as Record<string, unknown>).dbml ?? {}) as Record<string, unknown>;

/** What a round trip must keep. */
export function canonicalImport(plan: DbmlImportPlan): CanonicalImport {
  const tables = plan.newTables.map((t) => ({
    name: t.name,
    schema: t.schema ?? '',
    columns: (t.columns ?? []).map((c) => ({
      name: c.name,
      type: c.dataType ?? '',
      pk: c.isPrimaryKey === true,
      notNull: dbmlMeta(c).not_null === true,
      unique: dbmlMeta(c).unique === true,
    })),
    // Unique indexes over plain columns (an expression index is not a key).
    uniqueKeys: (Array.isArray(dbmlMeta(t).indexes) ? dbmlMeta(t).indexes as Array<Record<string, unknown>> : [])
      .filter((ix) => ix.unique === true && ix.pk !== true && Array.isArray(ix.columns))
      .map((ix) => (ix.columns as unknown[]).map((c) => (typeof c === 'string' ? c : String((c as Record<string, unknown>)?.value ?? ''))).join(','))
      .sort(),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const groups = new Map<string, string[]>();
  for (const r of plan.relationships) {
    const fk = r.cardinality === 'one-to-many'
      ? { f: r.toModel, fc: r.toColumn, t: r.fromModel, tc: r.fromColumn, card: 'many-to-one' }
      : { f: r.fromModel, fc: r.fromColumn, t: r.toModel, tc: r.toColumn, card: r.cardinality };
    const key = r.compositeKey ? `${fk.f}:${r.compositeKey}` : `${fk.f}.${fk.fc}>${fk.t}.${fk.tc}`;
    groups.set(key, [...(groups.get(key) ?? []), `${fk.f}.${fk.fc}>${fk.t}.${fk.tc} ${fk.card}`]);
  }
  const relationships = [...groups.values()].map((pairs) => pairs.sort().join(' + ')).sort();
  return { tables, relationships };
}

/** Import → export → import: both canonical forms and the exported text. */
export function roundTripDbml(text: string, fileName?: string): { first: CanonicalImport; second: CanonicalImport; exported: string; plan: DbmlImportPlan } {
  const plan = importDbmlText(text, fileName);
  const exported = exportPlan(plan);
  const again = importDbmlText(exported, fileName);
  return { first: canonicalImport(plan), second: canonicalImport(again), exported, plan };
}
