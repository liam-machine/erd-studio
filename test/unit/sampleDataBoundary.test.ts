/**
 * Where sample rows (D37: a table's DBML `records` block) may travel, held
 * statically (guards G5 and G7 of the sample-rows plan). A cell may hold real
 * data; the closed list of what may hold one is in docs/dev/feedback.md.
 *
 * - The parser's data lints quote cell values (`Duplicate PK: … = "…"`,
 *   `FK violation: … = …`, `Numeric value … exceeds precision`): no runtime
 *   code calls `getInfos()` or `getWarnings()`, reads `parse.warnings`, uses
 *   `DBMLDiagnosticsProvider` or the validate helpers.
 * - The sample-data type and field names appear only in the files listed
 *   here, and none of those is a telemetry module or a reader of the log's
 *   buffer (Send Feedback). A file that starts to carry rows joins the list
 *   on purpose, in review.
 * - Every throw in `records.ts` holds fixed words, a file, line and row
 *   numbers and column names, never source text, because an unexplained
 *   refusal's text reaches Send Feedback's prefill.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { FEEDBACK_LOG_READERS, TELEMETRY_MODULES } from './helpers/privacyModules';

const ROOT = path.resolve(__dirname, '../..');

/** The runtime source trees: the extension, both webviews, the packages and the MCP server. */
const RUNTIME_DIRS = ['src', 'webview', 'webview-draft', 'mcp-server/src', ...fs.readdirSync(path.join(ROOT, 'packages')).map((p) => `packages/${p}/src`)];

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return out;
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const file = path.join(d, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(file);
    }
  };
  walk(full);
  return out;
}

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');
const runtimeFiles = (): string[] => RUNTIME_DIRS.flatMap(filesUnder);

/** The parser APIs whose messages quote cell values. */
const FORBIDDEN_PARSER_APIS = /\bgetInfos\b|\bgetWarnings\b|\bparse\s*\??\.\s*warnings\b|\bDBMLDiagnosticsProvider\b|\bvalidateForeignKeys\b|\bvalidatePrimaryKey\b|\bvalidateUnique\b/;

/**
 * The files that may name the sample-data types or field. Each file that
 * reads, carries or draws rows is added here deliberately: core's types,
 * the table reader and writer, the reader object, the display mapping and
 * the loader's opt-in.
 */
const SAMPLE_DATA_FILES: readonly string[] = [
  'packages/core/src/types/semantic.ts',
  'packages/core/src/types/dbmlStorage.ts',
  'packages/core/src/types/display.ts',
  'packages/core/src/dbml/records.ts',
  // The one writer of row text (a new table file's block, an export's), parser-free.
  'packages/core/src/sampleRows.ts',
  // The rich DBML export writes a table's rows (the shared traversal carries them; plain DBML and Mermaid never read them).
  'packages/core/src/exportShared.ts',
  'packages/core/src/exportDbmlRich.ts',
  'packages/core/src/dbml/readTable.ts',
  'packages/core/src/dbml/writeTable.ts',
  'packages/core/src/dbml/index.ts',
  'packages/core/src/displayDomain.ts',
  'packages/core/src/loadDisplayDomain.ts',
  // A v4 inline table's hand-written key is dropped here, so rows come only from the table reader.
  'packages/core/src/domain.ts',
  // The host: the one table read that asks for rows, and Convert's guard that drops them before a YAML text.
  'src/services/logicalModelService.ts',
  'src/services/dbmlConversion.ts',
  // The draft's strip: a reused Table Library table reaches a draft without its rows; an import's new tables get theirs.
  'src/services/draftDisplay.ts',
  // Import DBML: the file's rows read by token, planned for the tables it creates, shown in the draft and
  // written to their new files (the report and the ledger name tables and counts only).
  'src/services/dbmlImportParse.ts',
  'src/services/dbmlImport.ts',
  'src/services/draftModel.ts',
  'src/commands/importDbml.ts',
  'src/services/newSubjectAreaWriter.ts',
  'src/services/dbmlLibraryWrites.ts',
  // The renderer: the Detail panel's read-only Sample data section, and the panel that places it.
  'packages/renderer/src/components/DetailPanel/SampleDataSection.tsx',
  'packages/renderer/src/components/DetailPanel/DetailPanel.tsx',
];

/**
 * The sample-data type and field names, and the cell type. The "Not shown" note's code for rows that
 * do not read (`sampleDataNotRead`, and the helpers named after it) names no row: it is not one of them.
 */
const SAMPLE_DATA_NAMES = /sampleData(?!NotRead)|SampleData|SampleCell|sampleCell|readRecordsBlocks|RecordsBlockReading|DbmlRecords/;

describe('sample rows stay where they are allowed (G5)', () => {
  it('no runtime code calls a parser API whose messages quote cell values', () => {
    const hits: string[] = [];
    for (const file of runtimeFiles()) {
      fs.readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
        if (FORBIDDEN_PARSER_APIS.test(line)) hits.push(`${rel(file)}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('the pattern catches each forbidden API', () => {
    for (const line of [
      'compiler.interpretFile(fp).getInfos()',
      'compiler.interpretFile(fp).getWarnings()',
      'compiler.interpretProject(fp).getWarnings()',
      'compiler.parse.warnings(entry)',
      'const p = new DBMLDiagnosticsProvider(compiler)',
      'validateForeignKeys(db)',
      'validatePrimaryKey(t)',
      'validateUnique(t)',
    ]) expect(FORBIDDEN_PARSER_APIS.test(line), line).toBe(true);
    // A reading's own `warnings` list is not the parser's.
    expect(FORBIDDEN_PARSER_APIS.test('for (const w of reading.warnings) log.warn(w);')).toBe(false);
  });

  it('the sample-data names appear only in the allowed files', () => {
    const named = runtimeFiles().filter((file) => SAMPLE_DATA_NAMES.test(fs.readFileSync(file, 'utf-8'))).map(rel).sort();
    expect(named).toEqual([...SAMPLE_DATA_FILES].sort());
  });

  it('the names pattern finds the field, the type and every other carrier of rows, and not the note code', () => {
    for (const line of ['model.sampleData', 'type X = SampleData;', 'sampleData: true', 'tableSampleDataOf(t)', 'rows: SampleCell[][]']) expect(SAMPLE_DATA_NAMES.test(line), line).toBe(true);
    // Rows travel under other names too: the core block reader, the cell helpers and Import's model.
    for (const line of ['const b = readRecordsBlocks(text);', 'blocks: RecordsBlockReading[]', 'sampleCellAsText(cell)', 'sampleCellOf(text, node)', 'records: DbmlRecords[]']) expect(SAMPLE_DATA_NAMES.test(line), line).toBe(true);
    for (const line of ["code: 'sampleDataNotRead'", 'sampleDataNotReadMessage(file, line)']) expect(SAMPLE_DATA_NAMES.test(line), line).toBe(false);
  });

  it('no allowed file sends anything off the machine (telemetry) or reads the log buffer (Send Feedback)', () => {
    for (const file of SAMPLE_DATA_FILES) {
      expect(TELEMETRY_MODULES, file).not.toContain(file);
      expect(FEEDBACK_LOG_READERS, file).not.toContain(file);
    }
    for (const file of [...TELEMETRY_MODULES, ...FEEDBACK_LOG_READERS]) {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf-8'), file).not.toMatch(SAMPLE_DATA_NAMES);
    }
  });
});

describe("records.ts's throws hold no source text (G7)", () => {
  const text = fs.readFileSync(path.join(ROOT, 'packages/core/src/dbml/records.ts'), 'utf-8');

  it('every throw is a refusal or an Error built from a fixed-message helper', () => {
    // Code only: every `throw` that is not in a comment line.
    const code = text.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');
    const throws = [...code.matchAll(/\bthrow\b[^;]*;/g)].map((m) => m[0].replace(/\s+/g, ' '));
    expect(throws.length).toBe((code.match(/\bthrow\b/g) ?? []).length);
    expect(throws.length).toBeGreaterThan(0);
    for (const t of throws) {
      expect(t, t).toMatch(/^throw new (DbmlEditRefused\(|Error\(records\w+Message\()/);
      // No slice of the source: neither the text, a cell, nor a node's offsets.
      expect(t, t).not.toMatch(/\.slice\(|cellText\(|\.start\b.*\.end\b/);
    }
  });

  it('the refusal message that names values does so by row and line number and column name only', () => {
    const refusals = [...text.matchAll(/new DbmlEditRefused\(([\s\S]*?)\);/g)].map((m) => m[1]);
    expect(refusals.length).toBeGreaterThan(0);
    for (const args of refusals) {
      const interpolated = [...args.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
      for (const expr of interpolated) expect(['file', 'column', 'r + 1', 'line'], `\${${expr}}`).toContain(expr);
    }
  });
});
