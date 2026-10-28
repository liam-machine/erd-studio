/**
 * The outline of a `.dbml` file that `doctor` checks: its `use` lines
 * (resolved against the file's folder), the Enums it declares and the
 * targets of its `Metadata` blocks (D25). Read from
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
    return { parses: false, uses: [], enums: [], metadata: [], tables: [] };
  }
  const uses = useLinesOf(compiled.ast, text, filePath).map((use) => ({
    path: use.importPath,
    resolved: use.resolved,
    line: lineAt(text, use.node.start),
    wildcard: use.wildcard,
    tables: use.tables.map((t) => t.name),
  }));
  const enums: DbmlFileOutline['enums'] = [];
  const metadata: NonNullable<DbmlFileOutline['metadata']> = [];
  const tables: string[] = [];
  for (const node of topLevel(compiled.ast)) {
    const type = elementType(node)?.toLowerCase();
    if (type === 'table') {
      const parts = plainNames(node.name);
      if (parts && parts.length > 0) tables.push(parts[parts.length - 1]);
    } else if (type === 'enum') {
      const parts = plainNames(node.name);
      if (!parts || parts.length === 0) continue;
      enums.push({ name: parts.join('.'), line: lineAt(text, node.start) });
    } else if (type === 'metadata') {
      const parts = plainNames(node.name);
      const column = String(node.targetKind?.value ?? '').toLowerCase() === 'column';
      if (!parts || parts.length < (column ? 2 : 1)) continue;
      metadata.push({
        table: column ? parts[parts.length - 2] : parts[parts.length - 1],
        ...(column ? { column: parts[parts.length - 1] } : {}),
        line: lineAt(text, node.start),
      });
    }
  }
  return { parses: true, uses, enums, metadata, tables };
}
