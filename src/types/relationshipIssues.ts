/**
 * How many relationships a list of relationship findings is about (#133).
 *
 * Shared by the canvas banner ("N relationships need attention") and the
 * host's "Repair Relationships…" notification, so the two always say the
 * same number. One relationship can carry several findings — a missing
 * column on each end is two REL004s, a missing model plus a missing column
 * is a REL003 and a REL004, and the same link stored in two files is counted
 * per record — so the number counts distinct links (`link`, core's
 * `linkKey`), never findings. A finding with no link (a REL008 entry that
 * could not be read at all) is one relationship of its own.
 *
 * Pure and free of `vscode` and DOM types: compiled by both tsconfigs.
 */

/** The fields of a finding (`RelationshipFinding` or `DisplayRelationshipIssue`) the count reads. */
export interface CountableRelationshipIssue {
  code: string;
  message: string;
  link?: string;
}

/** The number of distinct relationships `issues` concern. */
export function countAffectedRelationships(issues: readonly CountableRelationshipIssue[]): number {
  const ids = new Set<string>();
  for (const issue of issues) {
    ids.add(issue.link ? `link\u0000${issue.link}` : `finding\u0000${issue.code}\u0000${issue.message}`);
  }
  return ids.size;
}
