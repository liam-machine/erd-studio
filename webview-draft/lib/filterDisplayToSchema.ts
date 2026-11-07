/**
 * The schema panel's filter (docs/dev/draft-first.md §2.3): the draft's
 * tables in one schema and only the relationships between them. Page-local:
 * nothing is posted, and Keep keeps every table whatever the panel shows.
 */

import type { DisplaySubjectArea } from '../../src/types/display';

/** `schema` undefined: every table (the same object back). `''`: the tables with no schema. */
export function filterDisplayToSchema(display: DisplaySubjectArea, schema: string | undefined): DisplaySubjectArea {
  if (schema === undefined) return display;
  const models = display.models.filter((m) => (m.schema ?? '') === schema);
  const kept = new Set(models.map((m) => m.name));
  const relationships = display.relationships.filter((r) => kept.has(r.fromModel) && kept.has(r.toModel));
  const viewConfig = { ...display.viewConfig };
  if (display.viewConfig.positions) {
    viewConfig.positions = Object.fromEntries(
      Object.entries(display.viewConfig.positions).filter(([name]) => kept.has(name)),
    );
  }
  if (display.viewConfig.annotations) {
    // A note belongs to a schema only through the table it is linked to.
    viewConfig.annotations = display.viewConfig.annotations.filter((a) => a.linkedModel !== undefined && kept.has(a.linkedModel));
  }
  return { ...display, models, relationships, viewConfig };
}

/** How many tables `schema` holds in `display` (all of them for undefined). */
export function tablesInSchema(display: DisplaySubjectArea, schema: string | undefined): number {
  if (schema === undefined) return display.models.length;
  return display.models.filter((m) => (m.schema ?? '') === schema).length;
}
