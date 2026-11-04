/**
 * A diagram's name as people type it, everywhere one is asked for: New
 * Diagram, Import DBML…, Import SQL DDL…, Import Semantic Model… and Draw
 * from dbt. "Sales" or "Customer 360" is accepted and saved as its file name
 * (`sales`, `customer-360`), with a quiet "Saved as …" under the box; only
 * what no file name can be made from is refused. One rule, so the same name
 * is never accepted by one start and refused by another.
 */

import * as vscode from 'vscode';

/**
 * The file name a typed name becomes, for a diagram or a layer folder: lower
 * case, every run of other characters one `-` ("Customer 360" →
 * `customer-360`), no `-` at either end. It may still start with a digit,
 * which the name checks refuse.
 */
export function slugFromName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The name box's `validateInput`: `rule` judges the file name the typed text
 * becomes (undefined = fine). A name that is not already a file name is
 * accepted with an information line saying what it is saved as.
 */
export function validateTypedDiagramName(
  value: string,
  rule: (slug: string) => string | undefined,
): string | vscode.InputBoxValidationMessage | undefined {
  if (!value.trim()) return 'Give the diagram a name';
  const slug = slugFromName(value);
  const problem = rule(slug);
  if (problem) return problem;
  return slug === value.trim() ? undefined : { message: `Saved as ${slug}`, severity: vscode.InputBoxValidationSeverity.Info };
}
