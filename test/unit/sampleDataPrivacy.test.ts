/**
 * Sample rows (D37) and privacy, from the extension's side: a cell of a
 * table file's `records` block may hold real data, and none of it may reach
 * anything that leaves the machine or is pasted into an issue. A sentinel
 * value sits in the shapes a script gets wrong (a dotted bare word the parser
 * quotes, a value in the header, an unclosed `'''`, a top-level `Records`
 * block) and in a valid block, and must be absent from:
 *
 * - the ERD Studio log and the host error log;
 * - Send Feedback: the diagnostics (log included), the issue URL, the copied
 *   report, the analysis prompt, a command's and a crash's prefill;
 * - Convert's self-check refusal and its reasons for leaving a file as it is;
 * - Format Document's log line for a file with a broken block;
 * - the telemetry heartbeat with its trail;
 * - Import DBML's log, ledger and report, for a broken block and a top-level one;
 * - the canvas's "Not shown" notes (the `filesNotShown` payload);
 * - `doctor`, `inventory`, `diff` and `changes` with `--json`.
 *
 * Modelled on feedbackRedaction.test.ts: the wiring is tested, not only the
 * sanitiser in core (packages/core/test/unit/dbmlRecordsPrivacy.test.ts).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { _resetMockWorkspace } from 'vscode';
import { editTableDbml, parseTableDbml } from '@erd-studio/core/dbml';

import { buildAnalysisPrompt } from '../../src/services/feedbackAnalysisService';
import { buildIssueUrl, collectDiagnostics, composeFeedbackFields, composeMarkdownReport, hostErrorLog } from '../../src/services/feedbackService';
import { crashFeedbackPrefill, feedbackPrefill } from '../../src/services/commandErrors';
import { clearLogBuffer, recentLogLines } from '../../src/services/logger';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { LayerService } from '../../src/services/layerService';
import { SubjectAreaService } from '../../src/services/domainService';
import { planDbmlConversion, describeDbmlConversion } from '../../src/services/dbmlConversion';
import { readDbmlConversionInput } from '../../src/services/dbmlConversionFiles';
import { compileDbmlFilesSeparately } from '../../src/services/dbmlFileCompile';
import { compileDbmlProject } from '@erd-studio/core/dbml';
import { DbmlFormattingProvider } from '../../src/providers/dbmlFormattingProvider';
import { TelemetryService, setTelemetryEndpointForTests, telemetry } from '../../src/services/telemetryService';
import { tableFileDetailCode } from '../../src/services/telemetryCanvas';
import { importDbml, type ImportDbmlDeps, type ImportDbmlUi } from '../../src/commands/importDbml';
import { buildImportReportView } from '../../src/services/importReport';
import { _resetImportReports, latestImportReport } from '../../src/services/importReportStore';
import { main } from '../../src/cli/index';
import { collectFilesNotShown } from '../../src/services/filesNotShown';
import type { FeedbackDraft } from '../../src/types/feedback';
import { fakeDraftPreview, type FakeDraftPreview } from './helpers/draftDriver';
import type { Draft } from '../../src/types/draft';

const SENTINEL = 'zqSENTX7';
const LEAK = /SENTX7/;

const head = (name: string): string => `Table gold.${name} {\n  id int [pk]\n  name varchar\n}\n`;
const nested = (name: string, list: string, rows: string): string => `Table gold.${name} {\n  id int [pk]\n  name varchar\n\n  records ${list} {\n${rows}  }\n}\n`;

/**
 * Table files (stem → text): four whose block does not read, one whose block does. Two of the four
 * (a dotted value, a value in the header) load without their rows, read-only (D37); the other two (a
 * block open to the end of the file, a top-level block) still make the file unreadable.
 */
const TABLES: Record<string, string> = {
  dim_dotted: nested('dim_dotted', '(id, name)', `    1, ${SENTINEL}.doe\n`),
  dim_header: nested('dim_header', `(id, "${SENTINEL}")`, "    1, 'a'\n"),
  dim_unclosed: nested('dim_unclosed', '(id, name)', `    1, '''${SENTINEL}\n`),
  dim_top: `${head('dim_top')}\nRecords gold.dim_top(id, name) {\n  1, ${SENTINEL}.doe\n}\n`,
  dim_good: nested('dim_good', '(id, name)', `    1, '${SENTINEL}'\n    2, '${SENTINEL}.doe'\n`),
};
const BROKEN = ['dim_dotted', 'dim_header', 'dim_unclosed', 'dim_top'];
/** The broken tables that load without their rows. */
const WITHOUT_ROWS = ['dim_dotted', 'dim_header'];
/** The broken tables that still do not read. */
const UNREADABLE = ['dim_unclosed', 'dim_top'];

const DIAGRAM = `${Object.keys(TABLES).map((t) => `use { table gold.${t} } from '../tables/gold/${t}.dbml'`).join('\n')}\n\nProject catalog {\n  erd_schema_version: '7'\n}\n`;

let tmp: string;

function write(root: string, rel: string, text: string): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A logical-only DBML project holding the sentinel tables and a diagram of them. */
function project(root = path.join(tmp, 'p')): string {
  write(root, '.erd-studio/layers.json', '{"layers":[{"id":"gold","label":"Gold"}]}\n');
  for (const [name, text] of Object.entries(TABLES)) write(root, `.erd-studio/gold/tables/gold/${name}.dbml`, text);
  write(root, '.erd-studio/gold/diagrams/catalog.dbml', DIAGRAM);
  return root;
}

beforeEach(() => {
  _resetMockWorkspace();
  clearLogBuffer();
  hostErrorLog.clear();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'erd-sample-privacy-')));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Read every table through the library, as the canvas does: the failures go to the log. */
function readAll(root: string): TableLibraryService {
  const library = new TableLibraryService(root, '.erd-studio');
  for (const name of Object.keys(TABLES)) {
    library.getTable(name);
    library.getTableFileError(name);
  }
  return library;
}

/** The writer's refusal of an edit to a broken table: a toast, so a webview error and a host error. */
function refusalOf(name: string): Error {
  const text = TABLES[name];
  try {
    editTableDbml(text, { name, schema: 'gold', columns: [{ name: 'id', dataType: 'int', description: '' }] }, { fileStem: name, schemaFolder: 'gold' });
  } catch (err) {
    return err as Error;
  }
  throw new Error(`expected ${name} to be refused`);
}

describe('the log, the host error log and Send Feedback', () => {
  it('a broken block is reported, and the report holds no value', () => {
    const root = project();
    const library = readAll(root);
    for (const name of UNREADABLE) {
      const err = library.getTableFileError(name);
      expect(err, name).not.toBeNull();
      expect(err!.message).not.toMatch(LEAK);
    }
    // A block that does not read leaves its table readable, without its rows (D37).
    for (const name of WITHOUT_ROWS) {
      expect(library.getTableFileError(name), name).toBeNull();
      expect(JSON.stringify(library.getTable(name))).not.toMatch(LEAK);
    }
    // The table is reported at its line, with its code: the log has the failures.
    expect(recentLogLines().some((l) => /dim_unclosed/.test(l) && /a value in the sample data \(records\) does not read as DBML \[1002\]/.test(l))).toBe(true);
    expect(recentLogLines().join('\n')).not.toMatch(LEAK);

    const refusals = BROKEN.map(refusalOf);
    for (const err of refusals) {
      expect(err.message).not.toMatch(LEAK);
      hostErrorLog.record('applyTableEdit', err.message);
    }
    expect(hostErrorLog.recent().join('\n')).not.toMatch(LEAK);

    const context = { extension: { packageJSON: { version: '2.0.11' } } };
    const webviewErrors = refusals.map((e) => `[host] ${e.message}`);
    const diagnostics = collectDiagnostics(context as never, undefined, webviewErrors, { includeLog: true });
    expect(JSON.stringify(diagnostics)).not.toMatch(LEAK);
    expect(diagnostics.recentLog?.length ?? 0).toBeGreaterThan(0);

    const draft: FeedbackDraft = { kind: 'bug', title: 'Editing a table failed', description: 'The edit was refused.', includeDiagnostics: true, includeLog: true };
    const fields = composeFeedbackFields(draft, diagnostics);
    expect(decodeURIComponent(buildIssueUrl(fields).replace(/\+/g, ' '))).not.toMatch(LEAK);
    expect(composeMarkdownReport(draft, diagnostics)).not.toMatch(LEAK);
    expect(buildAnalysisPrompt({ kind: 'bug', description: draft.description, context: refusals[0].message, issues: [] })).not.toMatch(LEAK);
    for (const err of refusals) {
      expect(JSON.stringify(feedbackPrefill('Edit table', 'while editing a table', err))).not.toMatch(LEAK);
      expect(JSON.stringify(crashFeedbackPrefill('canvas', { detail: err.message }))).not.toMatch(LEAK);
    }
  });

  it('the diagram loads (two broken tables without their rows, two as placeholders), and its warnings hold no value', () => {
    const root = project();
    const layers = new LayerService(root, '.erd-studio');
    const service = new SubjectAreaService(layers);
    service.setTableLibraryService(new TableLibraryService(root, '.erd-studio'));
    const unified = service.getSubjectArea(path.join(root, '.erd-studio', 'gold', 'diagrams', 'catalog.dbml'));
    expect(unified).toBeDefined();
    expect(recentLogLines().join('\n')).not.toMatch(LEAK);
  });
});

describe('the canvas\'s "Not shown" notes (the filesNotShown payload)', () => {
  it('name each table whose rows do not read by its file and line, and hold no value', () => {
    const root = project();
    const library = readAll(root);
    const memberTables = Object.keys(TABLES).flatMap((name) => {
      const found = library.dbmlTableProblems(name);
      return found ? [{ file: path.relative(path.join(root, '.erd-studio'), found.filePath).split(path.sep).join('/'), problems: found.problems }] : [];
    });
    const items = collectFilesNotShown({ importDrift: [], canAddImports: false, memberTables, relationshipsFiles: [], unreadFiles: [], shown: (rel) => `.erd-studio/${rel}` });
    expect(items.map((n) => [n.code, n.file, n.line])).toEqual([
      ['sampleDataNotRead', '.erd-studio/gold/tables/gold/dim_dotted.dbml', 5],
      ['sampleDataNotRead', '.erd-studio/gold/tables/gold/dim_header.dbml', 5],
    ]);
    expect(JSON.stringify({ items })).not.toMatch(LEAK);
  });
});

describe('Convert Project to DBML', () => {
  it('its reason for leaving an unreadable table file as it is holds no value', async () => {
    const root = project();
    const plan = await planDbmlConversion(readDbmlConversionInput(root, '.erd-studio'));
    expect(JSON.stringify([plan.refusals, plan.leftAsIs, plan.notes ?? null])).not.toMatch(LEAK);
    expect(describeDbmlConversion(plan)).not.toMatch(LEAK);
  });

  it('its self-check refusal (a file written that does not compile) holds no value, nor the prefill it feeds', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'yaml-'));
    fs.cpSync(path.resolve(__dirname, '../fixtures/logical-only'), root, { recursive: true });
    // A YAML project: the self-check compiles only the planned files, here with a broken table file among them.
    const compile = (files: Readonly<Record<string, string>>, entries: readonly string[]) => {
      const broken = 'gold/tables/gold/dim_dotted.dbml';
      return compileDbmlFilesSeparately({ ...files, [broken]: TABLES.dim_dotted }, [...entries, broken], compileDbmlProject);
    };
    const plan = await planDbmlConversion(readDbmlConversionInput(root, '.erd-studio'), { compile });
    expect(plan.refusals.some((r) => /does not compile/.test(r))).toBe(true);
    expect(plan.refusals.join('\n')).toMatch(/a value in the sample data \(records\) does not read as DBML \[4000\]/);
    expect(plan.refusals.join('\n')).not.toMatch(LEAK);
    expect(JSON.stringify(feedbackPrefill('Convert Project to DBML', 'while checking the converted files', new Error(plan.refusals[0])))).not.toMatch(LEAK);
  });
});

describe('Format Document', () => {
  it('on a file with a broken block: nothing changes, and its log line holds no value', () => {
    for (const name of ['dim_dotted', 'dim_unclosed']) {
      const unformatted = TABLES[name].replace('  id int [pk]', '    id   int [pk]');
      const doc = vscode.createMockTextDocument(`/p/.erd-studio/gold/tables/gold/${name}.dbml`, unformatted);
      new DbmlFormattingProvider().provideDocumentFormattingEdits(doc as never, { tabSize: 2, insertSpaces: true } as vscode.FormattingOptions);
    }
    // An unescaped apostrophe is a syntax error the formatter reports.
    const apostrophe = nested('dim_q', '(id, name)', "    1, 'zq'SENTX7'\n");
    new DbmlFormattingProvider().provideDocumentFormattingEdits(
      vscode.createMockTextDocument('/p/.erd-studio/gold/tables/gold/dim_q.dbml', apostrophe) as never,
      { tabSize: 2, insertSpaces: true } as vscode.FormattingOptions,
    );
    const lines = recentLogLines().filter((l) => l.includes('Format Document'));
    expect(lines.some((l) => /a value in the sample data \(records\) does not read as DBML/.test(l))).toBe(true);
    expect(recentLogLines().join('\n')).not.toMatch(LEAK);
  });
});

describe('telemetry', () => {
  const mock = vscode as unknown as {
    _resetMockConfiguration: () => void;
    _setMockTelemetryEnabled: (enabled: boolean) => void;
    createMockExtensionContext: (options: { storageRoot: string; extensionRoot: string; packageJSON?: unknown }) => vscode.ExtensionContext;
  };
  let services: TelemetryService[] = [];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T10:00:00Z'));
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    mock._resetMockConfiguration();
    mock._setMockTelemetryEnabled(true);
  });
  afterEach(() => {
    for (const s of services) s.dispose();
    services = [];
    setTelemetryEndpointForTests(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('the heartbeat with its trail counts the broken tables by fixed codes only', async () => {
    const root = project();
    const storage = path.join(tmp, 'telemetry');
    const context = mock.createMockExtensionContext({ storageRoot: storage, extensionRoot: storage, packageJSON: { version: '2.0.11' } });
    const service = new TelemetryService(context);
    services.push(service);
    service.start();
    telemetry.activation('project_found', true, 1);
    const library = readAll(root);
    // What the canvas records for a table file that does not read (a block that does not read no longer counts).
    for (const name of UNREADABLE) {
      const err = library.getTableFileError(name)!;
      telemetry.error('modelFileParse');
      const detail = tableFileDetailCode(err.kind, err.code);
      if (detail) telemetry.error(detail);
    }
    vi.setSystemTime(new Date('2026-11-06T00:30:00Z'));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalled();
    const bodies = fetchMock.mock.calls.map((c) => String((c[1] as RequestInit).body));
    const text = bodies.join('\n');
    expect(text).toMatch(/modelFileParse/);
    expect(text).toMatch(/"trail"/);
    expect(text).not.toMatch(LEAK);
  });
});

describe('Import DBML', () => {
  function ui(errors: string[]): ImportDbmlUi {
    return {
      pickFile: async (p) => p,
      readFile: async (p) => fs.readFileSync(p, 'utf-8'),
      showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[]) => items[0],
      showInputBox: async (options) => options.value,
      confirm: async () => true,
      showInformationMessage: async () => undefined,
      showErrorMessage: async (message) => { errors.push(message); return undefined; },
      openFileAt: async () => {},
      showFile: async () => {},
      openDiagram: async () => {},
      addLayer: async () => {},
      sendFeedback: async () => {},
      showImportReport: async () => {},
    };
  }

  function deps(root: string, theUi: ImportDbmlUi, draft: boolean): ImportDbmlDeps {
    const layerService = new LayerService(root, '.erd-studio');
    const subjectAreaService = new SubjectAreaService(layerService);
    const tableLibraryService = new TableLibraryService(root, '.erd-studio');
    subjectAreaService.setTableLibraryService(tableLibraryService);
    const preview = draft ? fakeDraftPreview(['closed']) : undefined;
    return {
      workspaceRoot: root,
      semanticDir: '.erd-studio',
      layerService,
      subjectAreaService,
      tableLibraryService,
      validateDomainName: () => undefined,
      onWritten: () => tableLibraryService.invalidateCache?.(),
      ui: theUi,
      ...(preview ? { draft: { preview, trigger: 'palette' as const } } : {}),
    };
  }

  beforeEach(() => {
    _resetImportReports();
    vi.spyOn(telemetry, 'feature');
    vi.spyOn(telemetry, 'error');
  });

  it('a file with a broken block: the failure message, the log, the ledger and the report hold no value', async () => {
    const root = path.join(tmp, 'import');
    write(root, '.erd-studio/layers.json', '{"layers":[{"id":"gold","label":"Gold"}]}\n');
    const file = path.join(tmp, 'shop.dbml');
    fs.writeFileSync(file, `Table customer {\n  id int [pk]\n  email varchar\n}\n\nRecords customer(id, email) {\n  1, ${SENTINEL}.doe\n}\n`);
    const errors: string[] = [];
    await importDbml(deps(root, ui(errors), false), { filePath: file });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/a value in the sample data \(records\) does not read as DBML/);
    const report = latestImportReport()!;
    expect(report).toMatchObject({ source: 'dbml', status: 'failed' });
    expect(JSON.stringify([errors, report, buildImportReportView(report), recentLogLines()])).not.toMatch(LEAK);
  });

  /** A draft as anything but its diagram's sample rows (D37: the one place a draft shows a value, by design). */
  const withoutRows = (drafts: readonly Draft[]): unknown[] => drafts.map((draft) => ({
    ...draft,
    display: { ...draft.display, models: draft.display.models.map(({ sampleData: _rows, ...model }) => model) },
  }));
  const rowsIn = (drafts: readonly Draft[]): string => JSON.stringify(drafts.map((draft) => draft.display.models.map((m) => m.sampleData ?? null)));

  it('a file with a top-level Records block that reads: the ledger, the report, the log and the draft (bar its rows) hold no value', async () => {
    const root = path.join(tmp, 'import');
    write(root, '.erd-studio/layers.json', '{"layers":[{"id":"gold","label":"Gold"}]}\n');
    const file = path.join(tmp, 'shop.dbml');
    fs.writeFileSync(file, `Table customer {\n  id int [pk]\n  email varchar\n}\n\nRecords customer(id, email) {\n  1, '${SENTINEL}@example.com'\n  2, '${SENTINEL}.doe'\n}\n`);
    const errors: string[] = [];
    const d = deps(root, ui(errors), true);
    await importDbml(d, { filePath: file });
    expect(errors).toEqual([]);
    const report = latestImportReport()!;
    expect(report).toMatchObject({ source: 'dbml' });
    const drafts = (d.draft as { preview: FakeDraftPreview }).preview.drafts;
    expect(JSON.stringify([report, buildImportReportView(report), recentLogLines(), withoutRows(drafts)])).not.toMatch(LEAK);
    // The positive control: the draft's diagram shows the rows the import keeps.
    expect(rowsIn(drafts)).toMatch(LEAK);
  });

  it('kept: the new table file holds the rows, and the ledger, the report and the log still hold none', async () => {
    const root = path.join(tmp, 'import');
    write(root, '.erd-studio/layers.json', '{"layers":[{"id":"gold","label":"Gold"}]}\n');
    const file = path.join(tmp, 'shop.dbml');
    fs.writeFileSync(file, [
      'Enum status {\n  active\n}\n',
      `Table customer {\n  id int [pk]\n  email varchar\n  st status\n\n  records (id, email, st) {\n    1, '${SENTINEL}@example.com', status.active\n    2, '${SENTINEL}.doe', null\n  }\n}\n`,
    ].join('\n'));
    const errors: string[] = [];
    const d = deps(root, ui(errors), false);
    const preview = fakeDraftPreview(['keep']);
    await importDbml({ ...d, draft: { preview, trigger: 'palette' } }, { filePath: file });
    expect(errors).toEqual([]);
    expect(preview.settled).toEqual([expect.objectContaining({ kept: true })]);
    const written = fs.readFileSync(path.join(root, '.erd-studio/gold/tables/gold/customer.dbml'), 'utf-8');
    expect(written).toContain(`  records (id, email, st) {\n    1, '${SENTINEL}@example.com', 'active'\n    2, '${SENTINEL}.doe', null\n  }`);
    const reading = parseTableDbml(written, 'customer', { schemaFolder: 'gold', sampleData: true });
    expect(reading.ok && reading.writable).toBe(true);
    const report = latestImportReport()!;
    expect(report).toMatchObject({ source: 'dbml' });
    expect(JSON.stringify([report, buildImportReportView(report), recentLogLines(), hostErrorLog.recent(), withoutRows(preview.drafts)])).not.toMatch(LEAK);
    expect(rowsIn(preview.drafts)).toMatch(LEAK);
  });

  it('a top-level Records block that does not read: the failure message, the ledger, the report and the log hold no value', async () => {
    const root = path.join(tmp, 'import');
    write(root, '.erd-studio/layers.json', '{"layers":[{"id":"gold","label":"Gold"}]}\n');
    const file = path.join(tmp, 'shop.dbml');
    fs.writeFileSync(file, `Table customer {\n  id int [pk]\n  email varchar\n}\n\nRecords customer(id, "${SENTINEL}") {\n  1, 'a'\n}\n`);
    const errors: string[] = [];
    await importDbml(deps(root, ui(errors), false), { filePath: file });
    expect(errors).toHaveLength(1);
    const report = latestImportReport()!;
    expect(report).toMatchObject({ source: 'dbml', status: 'failed' });
    expect(JSON.stringify([errors, report, buildImportReportView(report), recentLogLines()])).not.toMatch(LEAK);
  });
});

describe('the CLI with --json', () => {
  async function run(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
    let out = '';
    let err = '';
    const code = await main(argv, {
      stdout: { write: (s: string) => { out += s; } },
      stderr: { write: (s: string) => { err += s; } },
      cwd,
      env: { PATH: '' },
    });
    return { code, out, err };
  }

  it('doctor, inventory and diff', async () => {
    const root = project();
    const doctor = await run(['doctor', '--project', root, '--no-dbt', '--json'], root);
    expect(doctor.out).toMatch(/a value in the sample data \(records\) does not read as DBML/);
    const inventory = await run(['inventory', '--project', root, '--json'], root);
    const diff = await run(['diff', '--all', '--project', root, '--json'], root);
    for (const r of [doctor, inventory, diff]) expect(r.out + r.err).not.toMatch(LEAK);
  });

  it('changes', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
    const root = project();
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    // A broken block appears in the working tree, and a good table's rows change.
    write(root, '.erd-studio/gold/tables/gold/dim_good.dbml', nested('dim_good', '(id, name)', `    1, ${SENTINEL}.x\n`));
    const changes = await run(['changes', '--base', 'HEAD', '--project', root, '--json'], root);
    expect(changes.out + changes.err).not.toMatch(LEAK);
    expect(changes.out).toMatch(/does not read as DBML/);
  });
});

// The core reader, for the record: a value error in a block loads the table without its rows, read-only,
// with the block's line; the multi-file compile keeps the error's code, line and column in fixed words.
it('the reader names the block by its line, and the compile keeps the code, line and column of a value error', () => {
  const reading = parseTableDbml(TABLES.dim_dotted, 'dim_dotted', { schemaFolder: 'gold' });
  expect(reading.ok && !reading.writable && reading.problems.map((p) => [p.code, p.line])).toEqual([['recordsUnreadable', 5]]);
  expect(compileDbmlProject({ 't.dbml': TABLES.dim_dotted }, ['t.dbml'])['t.dbml']).toEqual([
    { code: 4000, line: 6, column: 8, message: 'a value in the sample data (records) does not read as DBML' },
  ]);
});
