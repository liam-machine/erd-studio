/**
 * The outline of a `.dbml` file that `doctor` checks: its `use` lines
 * (resolved against the file's folder) and the Enums it declares. Read from
 * the AST alone, so a file with binding errors still outlines; a file that
 * does not parse at all has no outline (`parses: false`).
 */

import type { DbmlFileOutline } from '../types/dbmlStorage.js';
import { compileOne, elementType, lineAt, plainNames, stripBom, topLevel } from './parser.js';
import { useLinesOf } from './writeRelationships.js';

/** The `use` lines and Enum declarations of `rawText`, a file at `filePath` (posix, relative to the semantic dir). */
export function outlineDbmlFile(rawText: string, filePath: string): DbmlFileOutline {
  const text = stripBom(rawText);
  const compiled = compileOne(text);
  if (compiled.errors.some((d) => d.errorClass === 'syntax') || !compiled.ast) {
    return { parses: false, uses: [], enums: [] };
  }
  const uses = useLinesOf(compiled.ast, text, filePath).map((use) => ({
    path: use.importPath,
    resolved: use.resolved,
    line: lineAt(text, use.node.start),
    wildcard: use.wildcard,
    tables: use.tables.map((t) => t.name),
  }));
  const enums: DbmlFileOutline['enums'] = [];
  for (const node of topLevel(compiled.ast)) {
    if (elementType(node)?.toLowerCase() !== 'enum') continue;
    const parts = plainNames(node.name);
    if (!parts || parts.length === 0) continue;
    enums.push({ name: parts.join('.'), line: lineAt(text, node.start) });
  }
  return { parses: true, uses, enums };
}
