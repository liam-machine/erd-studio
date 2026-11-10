/**
 * #269 through the real Import DBML command, over a two-layer DBML project
 * (real LayerService, SubjectAreaService and TableLibraryService): the issue's
 * repro, the step-by-step question, and what each answer writes.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { _resetMockWorkspace } from '../__mocks__/vscode';
import { importDbml, type ImportDbmlDeps, type ImportDbmlResume, type ImportDbmlUi } from '../../src/commands/importDbml';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';

const LAYERS = JSON.stringify({ schemaVersion: 1, layers: [
  { id: 'warehouse', label: 'Warehouse', abbreviation: 'WH', color: '#a0a0a0', creatable: true, order: 0 },
  { id: 'reports', label: 'Reports', abbreviation: 'RPT', color: '#d4a800', creatable: true, order: 1 },
] }, null, 2);

const REPORTS = 'Table customer {\n  customer_id int [pk]\n  name varchar\n}\nTable sale {\n  sale_id int [pk]\n  customer_id int\n}\nRef: sale.customer_id > customer.customer_id\n';
const WAREHOUSE = 'Table customer {\n  customer_id int [pk]\n  name varchar\n  country_code varchar\n  segment varchar\n}\nTable country {\n  country_code varchar [pk]\n}\nRef: customer.country_code > country.country_code\n';

type Policy = 'auto' | 'reuse';
interface Asked { placeHolder?: string; items: Array<vscode.QuickPickItem & { policy?: Policy }> }

let tmp: string;
let inbox: string;
const erd = (...p: string[]) => path.join(tmp, '.erd-studio', ...p);
const files = (): string[] => (fs.readdirSync(erd(), { recursive: true }) as string[])
  .filter((f) => fs.statSync(erd(f)).isFile()).map((f) => f.split(path.sep).join('/')).sort();
const snapshot = (prefix: string): Record<string, string> =>
  Object.fromEntries(files().filter((f) => f.startsWith(prefix)).map((f) => [f, fs.readFileSync(erd(f), 'utf-8')]));

/** The import, step by step: the layer `layer`, the suggested name, and `answer` to the same-name question (undefined = Escape). */
async function run(
  name: string, text: string, layer: string, answer?: Policy, resume?: Omit<ImportDbmlResume, 'filePath'>,
  storageOf?: (table: string) => 'yaml' | 'dbml' | undefined,
) {
  const layerService = new LayerService(tmp, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(tmp, '.erd-studio');
  if (storageOf) tableLibraryService.tableStorage = storageOf;
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const file = path.join(inbox, name);
  fs.writeFileSync(file, text);
  const asked: Asked[] = [];
  const confirms: string[] = [];
  const ui: ImportDbmlUi = {
    pickFile: async () => file,
    readFile: async (p) => fs.readFileSync(p, 'utf-8'),
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[], options: vscode.QuickPickOptions) => {
      const pickable = items as unknown as Array<T & { id?: string; policy?: Policy }>;
      if (pickable.some((i) => i.policy !== undefined)) {
        asked.push({ placeHolder: options.placeHolder, items: [...pickable] });
        return pickable.find((i) => i.policy === answer) as T | undefined;
      }
      return pickable.find((i) => i.id === layer) as T | undefined;
    },
    showInputBox: async (o) => o.value,
    confirm: async (_message, detail) => { confirms.push(detail); return true; },
    showInformationMessage: async () => undefined,
    showErrorMessage: async (m) => { throw new Error(`error shown: ${m}`); },
    openFileAt: async () => {}, showFile: async () => {}, openDiagram: async () => {}, addLayer: async () => {}, sendFeedback: async () => {},
  };
  const deps: ImportDbmlDeps = {
    workspaceRoot: tmp, semanticDir: '.erd-studio', layerService, subjectAreaService, tableLibraryService,
    validateDomainName: (v) => (/^[a-z][a-z0-9_-]*$/.test(v.trim()) ? undefined : 'bad'), onWritten: () => {}, ui,
  };
  const result = await importDbml(deps, resume ? { filePath: file, ...resume } : undefined);
  return { result, asked, confirms };
}

beforeEach(() => {
  _resetMockWorkspace();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-269-'));
  inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-269-in-'));
  fs.mkdirSync(erd(), { recursive: true });
  fs.writeFileSync(erd('layers.json'), LAYERS);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(inbox, { recursive: true, force: true });
});

describe('#269 Import DBML: a table whose name another layer already has', () => {
  it('the issue\'s repro: Warehouse gets its own customer with all four columns and its relationship; the Reports layer is not touched', async () => {
    await run('reports.dbml', REPORTS, 'reports');
    const reports = snapshot('reports/');
    const { result, asked } = await run('warehouse.dbml', WAREHOUSE, 'warehouse', 'auto');

    expect(asked).toHaveLength(1);
    expect(asked[0].placeHolder).toBe('customer is already in your project (Reports layer) with other columns. Import the file\'s table as its own, or use the project\'s?');
    expect(asked[0].items.map((i) => i.label)).toEqual(['Keep it as its own table', 'Use the project\'s table as it is']);

    const diagram = fs.readFileSync(result!.domainPath, 'utf-8');
    expect(diagram).toContain("use { table warehouse.warehouse_customer } from '../tables/warehouse/warehouse_customer.dbml'");
    expect(diagram).not.toContain('reports/');
    const own = fs.readFileSync(erd('warehouse/tables/warehouse/warehouse_customer.dbml'), 'utf-8');
    for (const column of ['customer_id', 'name', 'country_code', 'segment']) expect(own).toContain(column);
    expect(own).toContain("alias: 'customer'");
    expect(fs.readFileSync(erd('warehouse/relationships/warehouse.dbml'), 'utf-8'))
      .toContain('Ref: warehouse.warehouse_customer.country_code >? warehouse.country.country_code');
    expect(snapshot('reports/')).toEqual(reports);
  });

  it('"Use the project\'s table as it is": the Reports customer, as before, and the relationship that needs its missing column is left out', async () => {
    await run('reports.dbml', REPORTS, 'reports');
    const { result, confirms } = await run('warehouse.dbml', WAREHOUSE, 'warehouse', 'reuse');
    expect(fs.readFileSync(result!.domainPath, 'utf-8')).toContain("use { table reports.customer }  from '../../reports/tables/reports/customer.dbml'");
    expect(files()).not.toContain('warehouse/tables/warehouse/warehouse_customer.dbml');
    expect(confirms[0]).toContain('1 table already in your Table Library (from the Reports layer), used as it is');
  });

  it('Escape on the question writes nothing', async () => {
    await run('reports.dbml', REPORTS, 'reports');
    const before = files();
    const { result } = await run('warehouse.dbml', WAREHOUSE, 'warehouse', undefined);
    expect(result).toBeUndefined();
    expect(files()).toEqual(before);
  });

  it('the same columns: reused without a question', async () => {
    await run('reports.dbml', REPORTS, 'reports');
    const { result, asked } = await run('again.dbml', REPORTS, 'warehouse');
    expect(asked).toEqual([]);
    expect(fs.readFileSync(result!.domainPath, 'utf-8')).toContain('reports/tables/reports/customer.dbml');
  });

  it('the quick path asks nothing and keeps the file\'s own table; an answer carried in the resume is not asked again', async () => {
    await run('reports.dbml', REPORTS, 'reports');
    const quick = await run('warehouse.dbml', WAREHOUSE, 'warehouse', undefined, { quick: true, layer: 'warehouse' });
    expect(quick.asked).toEqual([]);
    expect(quick.result?.plan.modelNames).toEqual(['warehouse_customer', 'country']);

    const kept = await run('warehouse2.dbml', WAREHOUSE.replace('segment varchar', 'tier varchar'), 'warehouse', undefined, { layer: 'warehouse', sameName: 'reuse' });
    expect(kept.asked).toEqual([]);
    expect(kept.result?.plan.reusedTables).toContain('customer');
  });

  it('importing the same file again into a new diagram reuses its own earlier copy: no warehouse_customer_2', async () => {
    await run('reports.dbml', REPORTS, 'reports');
    await run('warehouse.dbml', WAREHOUSE, 'warehouse', 'auto');
    const again = await run('warehouse.dbml', WAREHOUSE, 'warehouse');
    expect(again.asked).toEqual([]);
    expect(again.result?.plan.reusedTables).toEqual(['warehouse_customer', 'country']);
    expect(files().filter((f) => f.includes('warehouse_customer'))).toEqual(['warehouse/tables/warehouse/warehouse_customer.dbml']);
  });

  it('a project table that could not join anyway (a YAML table in a DBML project): no question, the file\'s own table', async () => {
    await run('reports.dbml', REPORTS, 'reports');
    const { result, asked } = await run('warehouse.dbml', WAREHOUSE, 'warehouse', 'reuse', undefined, (n) => (n.toLowerCase() === 'customer' ? 'yaml' : 'dbml'));
    expect(asked).toEqual([]);
    expect(result?.plan.modelNames).toEqual(['warehouse_customer', 'country']);
  });
});
