/**
 * The parts of a DBML parser module the DBML readers use, as ERD Studio's
 * own structural type, so the optional `parser` argument of every reader
 * never names a type from the parser package (whose own declarations import the
 * uninstalled `monaco-editor-core`). The pinned 11.0.0 parser is the
 * default; tests pass the `dbml-parse-v9` (9.1.1) and `dbml-parse-v10`
 * (10.3.1) aliases to read the same text with each.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface DbmlParserModule {
  /** `new Compiler(layout)`; ERD Studio uses `parse.ast`, `parse.errors`, `parse.rawDb` and (the formatter) `parseFile`. */
  Compiler: new (layout: any) => any;
  /** `new MemoryProjectLayout()`, then `setSource(filepath, text)` per file. */
  MemoryProjectLayout: new (...args: any[]) => any;
  /** `Filepath.from(absolutePath)`; a path is read back only through `.absolute`. */
  Filepath: { from(absolutePath: string): any };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
