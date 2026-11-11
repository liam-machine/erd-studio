/**
 * End to end on the live Databricks probe: the committed catalog export
 * (`test/fixtures/catalog-csv/databricks/probe.csv`) with its foreign-key
 * columns blanked — what a lakehouse with primary keys but no declared
 * foreign keys exports — goes through Import SQL DDL… (the catalog-export
 * path, Import DBML's flow, written to a temp folder), the diagram opens on a
 * real SemanticEditorProvider, and Suggest Relationships runs on it with
 * every suggestion ticked (an undecided one answered the way it was found).
 * Measured against the probe's nine foreign keys (its truth): how many come
 * back, in which section, and how many suggestions are not in the truth.
 *
 * Run with SUGGEST_REPORT_DIR set to print the table.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { _appliedEdits, _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import type { ImportDbmlUi } from '../../src/commands/importDbml';
import { importSqlDdl, type ImportSqlDdlUi } from '../../src/commands/importSqlDdl';
import { readDelimited } from '../../src/services/catalogCsvImport';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import * as engine from '../../src/services/sqlImportEngine';
import { telemetry } from '../../src/services/telemetryService';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import type { SuggestRelationshipsUi } from '../../src/providers/suggestRelationshipsFlow';
import type { ReviewGroup, SuggestionReview } from '../../src/services/relationshipSuggestionReview';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';

const CSV = path.join(__dirname, '../fixtures/catalog-csv/databricks/probe.csv');
/** The probe's foreign keys (`relationshipSuggestions.measure.ts` → probeSample): nine links, one of them composite. */
const TRUTH: string[] = [
  'dup_b.parent_k>dup_a.k',
  'dup_c.parent_k>dup_a.k',
  'employee.manager_id>employee.employee_id',
  'fx_transfer.from_currency>currency.currency_code',
  'fx_transfer.to_currency>currency.currency_code',
  'order_line.order_id>orders.order_id',
  'order_line_note.ln_no+ord_id>order_line.line_no+order_id',
  'order_line_note.ord_id>orders.order_id',
  'orders.customer_id>customer.customer_id',
];
const FK_COLUMNS = ['fk_constraint_name', 'fk_ordinal', 'fk_table_catalog', 'fk_table_schema', 'fk_table', 'fk_column'];

let tmp: string;
const erd = (...parts: string[]): string => path.join(tmp, '.erd-studio', ...parts);

/** The export with chosen columns emptied, written back as RFC 4180 CSV. */
function blanked(columns: readonly string[]): string {
  const file = readDelimited(fs.readFileSync(CSV, 'utf-8'));
  const blank = new Set(columns.map((c) => file.header.indexOf(c)));
  const cell = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [file.header, ...file.rows.map((r) => r.map((v, i) => (blank.has(i) ? '' : v)))].map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

async function importCsv(text: string): Promise<string> {
  const csv = path.join(tmp, 'exports', 'probe.csv');
  fs.mkdirSync(path.dirname(csv), { recursive: true });
  fs.writeFileSync(csv, text);
  const layerService = new LayerService(tmp, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(tmp, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const sqlUi = {
    pickSources: async () => ({ files: [csv] }),
    readDirectory: async () => [],
    readFile: async (p: string) => fs.readFileSync(p, 'utf-8'),
    fileSize: async (p: string) => fs.statSync(p).size,
    pickDialect: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    openFileAt: async () => {}, sendFeedback: async () => {}, showLogs: async () => {},
  } as unknown as ImportSqlDdlUi;
  const ui = {
    pickFile: async () => undefined, readFile: async () => '',
    showQuickPick: async <T>(items: readonly T[]) => (items as unknown as Array<{ id: string }>).find((i) => i.id === 'gold') as unknown as T,
    showInputBox: async (o: { value?: string }) => o.value,
    confirm: async () => true,
    showInformationMessage: async () => undefined, showErrorMessage: async () => undefined,
    openFileAt: async () => {}, showFile: async () => {}, openDiagram: async () => {}, addLayer: async () => {}, sendFeedback: async () => {},
  } as unknown as ImportDbmlUi;
  const result = await importSqlDdl({
    workspaceRoot: tmp, semanticDir: '.erd-studio', layerService, subjectAreaService, tableLibraryService,
    extensionPath: '/nowhere', validateDomainName: () => undefined, onWritten: () => {},
    sqlUi, ui, loadSqlImport: () => engine,
  });
  expect(result?.domainPath).toBe(erd('gold', 'diagrams', 'probe.dbml'));
  return result!.domainPath;
}

interface Run { review: SuggestionReview; written: number; links: Map<string, ReviewGroup>; stored: string[] }

/** Open the imported diagram, run Suggest Relationships ticking every row, and read back what was stored. */
async function suggestAll(domainPath: string): Promise<Run> {
  const layerService = new LayerService(tmp, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tables = new TableLibraryService(tmp, '.erd-studio');
  subjectAreaService.setTableLibraryService(tables);
  const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
  const selectors = new SelectorsService(subjectAreaService, tmp, '.erd-studio');
  vi.spyOn(selectors, 'scheduleRegenerate').mockImplementation(() => undefined);
  const provider = new SemanticEditorProvider(
    { extensionUri: vscode.Uri.file('/nowhere'), globalStorageUri: vscode.Uri.file(path.join(tmp, '.gs')), extension: { packageJSON: { version: '0' } },
      globalState: { get: () => true, update: async () => {} }, workspaceState: { get: () => true, update: async () => {} }, subscriptions: [] } as unknown as vscode.ExtensionContext,
    subjectAreaService,
    { loadManifest: async () => empty, getRelationshipTests: () => [] } as unknown as ManifestService,
    { loadYmlData: async () => empty } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService, tmp, selectors, tables, new OwnWriteTracker(),
  );
  provider.setLogicalOnly(true);
  const document = createMockTextDocument(domainPath, fs.readFileSync(domainPath, 'utf-8'), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(document);
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
  await panel._simulateMessage({ type: 'ready' });
  let review: SuggestionReview | undefined;
  const ui: SuggestRelationshipsUi = {
    pick: async (r) => { review = r(10_000); return review.sections.flatMap((s) => s.rows.map((row) => row.id)); },
    askDirection: async () => 'asIs',
    info: () => {}, error: (m) => { throw new Error(m); },
  };
  provider.useSuggestionUi(ui);
  _appliedEdits.length = 0;
  const outcome = await provider.suggestRelationships(vscode.Uri.file(domainPath));
  expect(_appliedEdits).toHaveLength(1);
  const links = new Map<string, ReviewGroup>();
  for (const section of review!.sections) {
    for (const row of section.rows) {
      const [from, to] = row.label.split(' → ');
      const [fm, ...fc] = from.split('.');
      const [tm, ...tc] = to.split('.');
      const fcs = fc.join('.').split(', ');
      const tcs = tc.join('.').split(', ');
      // Composite pairs sorted together, as the truth writes them.
      const order = fcs.map((c, i) => [c, tcs[i]]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      links.set(`${fm}.${order.map((p) => p[0]).join('+')}>${tm}.${order.map((p) => p[1]).join('+')}`, section.group);
    }
  }
  const library = new TableLibraryService(tmp, '.erd-studio');
  const stored = library.listTables().flatMap((t) => (t.relationships ?? []).map((r) => `${t.name}.${r.fromColumn}>${r.toModel}.${r.toColumn}`));
  return { review: review!, written: typeof outcome === 'object' ? outcome.written : 0, links, stored };
}

function score(run: Run): { found: Record<ReviewGroup, number>; missed: string[]; extra: Record<ReviewGroup, number> } {
  const found: Record<ReviewGroup, number> = { strong: 0, likely: 0, possible: 0, direction: 0 };
  const extra: Record<ReviewGroup, number> = { strong: 0, likely: 0, possible: 0, direction: 0 };
  const reverse = (k: string): string => { const [a, b] = k.split('>'); return `${b}>${a}`; };
  for (const [link, group] of run.links) {
    if (TRUTH.includes(link) || (group === 'direction' && TRUTH.includes(reverse(link)))) found[group]++;
    else extra[group]++;
  }
  const missed = TRUTH.filter((t) => !run.links.has(t) && !run.links.has(reverse(t)));
  return { found, missed, extra };
}

beforeEach(() => {
  _resetMockWorkspace();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-suggest-probe-'));
  vi.spyOn(telemetry, 'feature');
  vi.spyOn(telemetry, 'featureQuiet');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the Databricks probe, end to end: catalog CSV → Import SQL DDL… → Suggest Relationships', () => {
  it('foreign keys blanked, primary keys kept: the known relationships come back, the strong ones ticked and right', async () => {
    const domainPath = await importCsv(blanked(FK_COLUMNS));
    // The import itself wrote no relationship.
    expect(new TableLibraryService(tmp, '.erd-studio').listTables().flatMap((t) => t.relationships ?? [])).toEqual([]);
    const run = await suggestAll(domainPath);
    const { found, missed, extra } = score(run);
    if (process.env.SUGGEST_REPORT_DIR) {
      process.stdout.write(`probe (FK blanked, PK kept): ${run.links.size} suggested; truth found ${JSON.stringify(found)}; missed ${JSON.stringify(missed)}; not in truth ${JSON.stringify(extra)}; written ${run.written}\n`);
      for (const s of run.review.sections) for (const r of s.rows) process.stdout.write(`  [${s.group}] ${r.label} — ${r.detail}\n`);
    }
    // Every strong suggestion is a true foreign key.
    expect(extra.strong).toBe(0);
    expect(found.strong).toBeGreaterThanOrEqual(2);
    expect(found.strong + found.likely + found.possible + found.direction).toBeGreaterThanOrEqual(5);
    // Everything ticked was written, through the one write path, and reads back.
    expect(run.written).toBe(run.links.size);
    expect(run.stored.length).toBeGreaterThanOrEqual(run.links.size);
  });

  it('foreign and primary keys blanked (a lakehouse that declares nothing): nothing is strong, so nothing would be ticked', async () => {
    const domainPath = await importCsv(blanked([...FK_COLUMNS, 'is_primary_key', 'pk_ordinal']));
    const run = await suggestAll(domainPath);
    const { found, missed, extra } = score(run);
    if (process.env.SUGGEST_REPORT_DIR) {
      process.stdout.write(`probe (FK and PK blanked): ${run.links.size} suggested; truth found ${JSON.stringify(found)}; missed ${JSON.stringify(missed)}; not in truth ${JSON.stringify(extra)}\n`);
      for (const s of run.review.sections) for (const r of s.rows) process.stdout.write(`  [${s.group}] ${r.label} — ${r.detail}\n`);
    }
    expect(found.strong + extra.strong).toBe(0);
    expect(run.review.sections.flatMap((s) => s.rows).some((r) => r.picked)).toBe(false);
    expect(run.review.placeholder).toBe('Nothing is ticked: no table on this diagram marks a primary key, so every suggestion needs a look.');
  });
});
