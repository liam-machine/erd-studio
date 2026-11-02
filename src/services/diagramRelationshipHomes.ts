/**
 * Which of a diagram's relationships its own file holds: the
 * detail panel's "Remove from this diagram" confirmation warns that a table's
 * relationships go with it only when the diagram file really holds them (a
 * YAML/JSON domain's `logical.relationships`, which `handleRemoveModels`
 * filters). A DBML diagram holds none (D5): they stay in the Table Library.
 *
 * Pure, and free of `vscode`, so it is tested on its own.
 */

import { sameLink } from '@erd-studio/core';
import type { DisplaySubjectArea } from '@erd-studio/core';

interface LinkEnds {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
}

function isLinkEnds(value: unknown): value is LinkEnds {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.fromModel === 'string' && typeof r.fromColumn === 'string'
    && typeof r.toModel === 'string' && typeof r.toColumn === 'string';
}

/**
 * `display` with `relationshipsInDiagramFile` set and `inDiagramFile` on each
 * relationship the diagram file's own list (`ownRelationships`, the parsed
 * file's `logical.relationships` under the v5 keys) also holds. `dbml` is a
 * DBML diagram, which holds none. `null` means the file could not be read:
 * `display` is returned as it is, so the panel keeps the cautious warning.
 */
export function withRelationshipHomes(
  display: DisplaySubjectArea,
  ownRelationships: unknown,
  dbml: boolean,
): DisplaySubjectArea {
  if (dbml) return { ...display, relationshipsInDiagramFile: false };
  if (ownRelationships === null) return display;
  const own = Array.isArray(ownRelationships) ? ownRelationships.filter(isLinkEnds) : [];
  if (own.length === 0) return { ...display, relationshipsInDiagramFile: false };
  return {
    ...display,
    relationshipsInDiagramFile: true,
    relationships: display.relationships.map((rel) =>
      own.some((o) => sameLink(o, rel)) ? { ...rel, inDiagramFile: true as const } : rel),
  };
}
