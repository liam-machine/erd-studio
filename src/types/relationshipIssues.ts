/**
 * How many relationships a list of relationship findings is about (#133).
 *
 * Used by the canvas banner ("N relationships need attention"), so it says
 * how many relationships, not how many findings. One relationship can carry several findings — a missing
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

/**
 * The entry a link-less finding is about: core words every per-entry read
 * problem as "<file>: Relationship entry N of <model | diagram label> …", and
 * one entry can have several (no cardinality and a role that is not text) —
 * still one relationship (#133 review 8).
 */
const ENTRY = /^(.*?Relationship entry \d+ of (?:diagram )?\S+)\s/;

/** The number of distinct relationships `issues` concern. */
export function countAffectedRelationships(issues: readonly CountableRelationshipIssue[]): number {
  const ids = new Set<string>();
  for (const issue of issues) {
    if (issue.link) {
      ids.add(`link\u0000${issue.link}`);
      continue;
    }
    const entry = ENTRY.exec(issue.message);
    ids.add(entry ? `entry\u0000${entry[1]}` : `finding\u0000${issue.code}\u0000${issue.message}`);
  }
  return ids.size;
}
