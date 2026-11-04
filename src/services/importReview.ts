/**
 * Everything an import brings in, as data: the dry run of any import (Import
 * DBML…, Import SQL DDL…, Import Semantic Model…, the coffee-shop example) in
 * full — every table grouped by schema (with its column count and keys),
 * every relationship, what the Table Library already has or gains, what was
 * renamed, what was left out and why, and every note.
 *
 * Draft-first (`docs/dev/draft-first.md` §10): the Review All… page this
 * once fed is gone; the draft preview's details drawer is built from
 * {@link buildImportReview}'s sections (`draftFromImportPlan`).
 *
 * Pure and vscode-free.
 */

import {
  thousands,
  type ConvertReviewItem,
  type ConvertReviewSection,
} from './dbmlConversionReview';
import {
  importLayoutSentence,
  importLeftOut,
  importPlanNotes,
  importSchemaCounts,
  importSchemaOf,
  renameEntries,
  summariseDbmlImportPlan,
  type DbmlImportPlan,
  type DescribeDbmlImportOptions,
} from './dbmlImport';
import type { Relationship, SemanticTable } from '../types/semantic';

export interface ImportReviewView {
  heading: string;
  intro: string[];
  counts: Array<{ label: string; value: number }>;
  sections: ConvertReviewSection[];
  /** A quick import: Change Options… beside Import and Cancel. */
  changeOptions: boolean;
  /** The primary button's label (Import). */
  importLabel: string;
}

export interface ImportReviewOptions extends DescribeDbmlImportOptions {
  /** The diagram file the import creates, as the user sees it (project-relative). */
  diagramFile?: string;
  changeOptions?: boolean;
  importLabel?: string;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${thousands(n)} ${n === 1 ? one : many}`;

/** A table's columns and keys in one short line: `12 columns · primary key id · 2 foreign keys`. */
export function describeImportTable(table: SemanticTable, foreignKeys: number): string {
  const columns = table.columns ?? [];
  const parts = [plural(columns.length, 'column')];
  const pk = columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  if (pk.length > 0) parts.push(`primary key ${pk.join(', ')}`);
  else parts.push('no primary key');
  if (foreignKeys > 0) parts.push(plural(foreignKeys, 'foreign key'));
  return parts.join(' · ');
}

/** Each relationship once (a composite's column pairs together), with the columns it joins. */
export function relationshipLines(relationships: readonly Relationship[]): Array<{ from: string; to: string; label: string; cardinality: string }> {
  const groups = new Map<string, Relationship[]>();
  relationships.forEach((rel, i) => {
    const key = rel.compositeKey !== undefined ? `${rel.fromModel}\u0000${rel.toModel}\u0000${rel.compositeKey}` : `#${i}`;
    groups.set(key, [...(groups.get(key) ?? []), rel]);
  });
  return [...groups.values()].map((rels) => {
    const first = rels[0];
    const cols = (pick: (r: Relationship) => string): string => (rels.length === 1 ? pick(first) : `(${rels.map(pick).join(', ')})`);
    const label = `${first.fromModel}.${cols((r) => r.fromColumn)} → ${first.toModel}.${cols((r) => r.toColumn)}`;
    return { from: first.fromModel, to: first.toModel, label, cardinality: first.cardinality + (first.role ? ` · ${first.role}` : '') };
  });
}

/** The page's content for a plan. Every table, every relationship, everything left out: no cut-off. */
export function buildImportReview(plan: DbmlImportPlan, options: ImportReviewOptions = {}): ImportReviewView {
  const { report } = plan;
  const { headline } = summariseDbmlImportPlan(plan, options);
  const links = relationshipLines(plan.relationships);
  const fkCount = new Map<string, number>();
  for (const l of links) fkCount.set(l.from, (fkCount.get(l.from) ?? 0) + 1);

  // The new tables, a section per schema (most tables first), each table by name.
  const bySchema = new Map<string, SemanticTable[]>();
  for (const t of plan.newTables) bySchema.set(importSchemaOf(t), [...(bySchema.get(importSchemaOf(t)) ?? []), t]);
  const schemaSections: ConvertReviewSection[] = importSchemaCounts(plan).map(({ schema }) => ({
    id: `schema:${schema}`,
    title: schema ? `Schema ${schema}` : (bySchema.size === 1 ? 'New tables' : 'No schema'),
    items: [...(bySchema.get(schema) ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
      .map((t): ConvertReviewItem => ({ path: t.name, tag: 'new', text: describeImportTable(t, fkCount.get(t.name) ?? 0) })),
  }));

  const library: ConvertReviewItem[] = [
    ...report.reusedTables.map((r): ConvertReviewItem => ({
      path: r.name,
      tag: 'already in your Table Library',
      text: r.missingColumns.length > 0
        ? `Used as it is. Not added: ${r.missingColumns.join(', ')} (in the import, not in the library's table).`
        : 'Used as it is.',
    })),
    ...plan.changedLibraryTables.map((t): ConvertReviewItem => ({ path: t.name, tag: 'gains relationships', text: 'Its table file gets the new relationships.' })),
  ];

  const leftOut = importLeftOut(plan, options);
  const notes = importPlanNotes(plan, options);
  const renames = renameEntries(report.renamed);
  const sections: ConvertReviewSection[] = [
    ...schemaSections,
    {
      id: 'relationships',
      title: 'Relationships',
      items: links.map((l): ConvertReviewItem => ({ path: l.label, tag: l.cardinality })),
      count: report.relationships,
      ...(report.relationshipsAlreadyInLibrary > 0
        ? { hint: `${plural(report.relationshipsAlreadyInLibrary, 'is', 'are')} already in your Table Library and kept as it has them.` }
        : {}),
    },
    { id: 'library', title: 'Your Table Library', items: library },
    { id: 'renamed', title: 'Renamed to names ERD Studio can use', items: renames.map((text) => ({ text })) },
    {
      id: 'left',
      title: 'Not imported',
      items: leftOut.map((text) => ({ text })),
      ...(leftOut.length > 0 ? { hint: 'These stay in your own files only: the import writes none of them.' } : {}),
    },
    { id: 'notes', title: 'Notes', items: notes.map((text) => ({ text })) },
  ].filter((section) => section.items.length > 0);

  const schemas = importSchemaCounts(plan).length;
  return {
    heading: headline,
    intro: [
      ...(options.diagramFile ? [`The new diagram is saved as ${options.diagramFile}.`] : []),
      importLayoutSentence(plan, options),
      'Nothing is written until you choose Import.',
    ],
    counts: [
      { label: plan.modelNames.length === 1 ? 'table' : 'tables', value: plan.modelNames.length },
      { label: report.relationships === 1 ? 'relationship' : 'relationships', value: report.relationships },
      ...(schemas > 1 ? [{ label: 'schemas', value: schemas }] : []),
      ...(report.reusedTables.length > 0 ? [{ label: 'already in your Table Library', value: report.reusedTables.length }] : []),
      ...(leftOut.length > 0 ? [{ label: leftOut.length === 1 ? 'thing not imported' : 'things not imported', value: leftOut.length }] : []),
      ...(notes.length > 0 ? [{ label: notes.length === 1 ? 'note' : 'notes', value: notes.length }] : []),
    ],
    sections,
    changeOptions: options.changeOptions === true,
    importLabel: options.importLabel ?? 'Import',
  };
}
