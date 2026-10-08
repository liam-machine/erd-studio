import type { Relationship } from '../../../src/types/semantic.js';

/** One relationship as `read_domain` reports it. */
export interface McpRelationship {
  from_model: string;
  from_column: string;
  to_model: string;
  to_column: string;
  cardinality: Relationship['cardinality'];
  role?: string;
  /**
   * What is wrong with it, as `erd-studio check` codes (REL001 stored twice,
   * REL002 saved on its "one" side, REL005 a case-only name, REL006 a
   * direction the keys contradict, REL009 a diagram-file copy of a model
   * library one); absent when nothing is.
   */
  issues?: string[];
}

/**
 * The relationships a domain's diagram draws, as `read_domain` reports them —
 * the canvas's and `diff`'s view (`buildLogicalDisplayDomain`): a domain-file
 * entry whose end is not one of the domain's models (REL003) has nothing to be
 * drawn between, so it is left out rather than reported as drawn. Every other
 * relationship carries its `issues`, so an assistant can tell a sound one from
 * one to look at with `erd-studio check`.
 */
export function drawnRelationships(relationships: readonly Relationship[]): McpRelationship[] {
  return relationships
    .filter((r) => !(r.issues ?? []).includes('REL003'))
    .map((r) => ({
      from_model: r.fromModel,
      from_column: r.fromColumn,
      to_model: r.toModel,
      to_column: r.toColumn,
      cardinality: r.cardinality,
      ...(r.role ? { role: r.role } : {}),
      ...(r.issues && r.issues.length > 0 ? { issues: [...r.issues] } : {}),
    }));
}
