/**
 * A multi-file compile of a DBML project, the way other DBML tools read it:
 * for `doctor`, Convert's self-check, the end-to-end script and the
 * multi-parser tests. Display never uses it (D6: reads are per file).
 *
 * Files are mounted under the fixed, space-free virtual root `/erd-studio/`,
 * so the result never depends on where the project lives (the 10.3.1 parser
 * the tests feed drops imported tables when any folder in the absolute path
 * holds a space).
 */

import type { DbmlDiagnostic } from '../types/dbmlStorage.js';
import type { DbmlParserModule } from './parserModule.js';
import { PINNED_PARSER, diagnosticOf, stripBom } from './parser.js';

/** The virtual root every file is mounted under. */
const VIRTUAL_ROOT = '/erd-studio/';

function relativeTo(absolute: string | undefined, fallback: string): string {
  if (typeof absolute !== 'string') return fallback;
  return absolute.startsWith(VIRTUAL_ROOT) ? absolute.slice(VIRTUAL_ROOT.length) : absolute.replace(/^\/+/, '');
}

/**
 * Compile each of `entries` with every file of `files` visible to its `use`
 * lines. `files` maps posix paths relative to the semantic dir to their text
 * (a leading byte-order mark is dropped). The result holds every
 * diagnostic once, keyed by the relative path of the file it is in (an entry
 * with none is present with `[]`); a file two entries reach reports each of
 * its diagnostics once.
 */
export function compileDbmlProject(
  files: Readonly<Record<string, string>>,
  entries: readonly string[],
  parser: DbmlParserModule = PINNED_PARSER,
): Record<string, DbmlDiagnostic[]> {
  const layout = new parser.MemoryProjectLayout();
  const texts = new Map<string, string>();
  for (const [path, text] of Object.entries(files)) {
    const clean = path.replace(/^\/+/, '');
    const body = stripBom(text);
    texts.set(clean, body);
    layout.setSource(parser.Filepath.from(`${VIRTUAL_ROOT}${clean}`), body);
  }
  const compiler = new parser.Compiler(layout);
  const result: Record<string, DbmlDiagnostic[]> = {};
  const seen = new Set<string>();
  for (const entry of entries) {
    const clean = entry.replace(/^\/+/, '');
    result[clean] ??= [];
    const errors = (compiler.parse.errors(parser.Filepath.from(`${VIRTUAL_ROOT}${clean}`)) ?? []) as unknown[];
    for (const error of errors) {
      const e = error as { filepath?: { absolute?: string }; nodeOrToken?: { filepath?: { absolute?: string } } };
      const file = relativeTo(e.filepath?.absolute ?? e.nodeOrToken?.filepath?.absolute, clean);
      const d = diagnosticOf(error, texts.get(file) ?? '');
      const key = `${file}\u0000${d.code}\u0000${d.line}\u0000${d.column}\u0000${d.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      (result[file] ??= []).push({ code: d.code, message: d.message, line: d.line, column: d.column });
    }
  }
  return result;
}
