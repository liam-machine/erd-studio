/**
 * The host side of the toolbar's dbt command (#378):
 * `SemanticEditorProvider.handleCopyDbtCommand`. It puts the command on the
 * clipboard and says so in a `canvasNotice`, on the Logical and the Physical
 * tab alike; tables the physical stage does not find in dbt are left out; it
 * writes no file; and a folder without dbt (logical-only) copies nothing.
 * The builder is `dbtCommand.test.ts`, the button `Toolbar.test.tsx`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { _appliedEdits, _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import { DBT_COMMAND_NEEDS_DBT_MESSAGE } from '../../src/services/projectDiscovery';
import { emptyYmlData } from '../../src/services/ymlParserService';
import { parseDocument } from 'yaml';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';
import type { YmlData } from '../../src/types/ymlData';
import type { ManifestModelInfo } from '../../src/types/manifest';

const NATIVE = path.resolve(__dirname, '../fixtures/dbml-native');
/** bqs and ccc each hold an `addresse` and a `kunde`; the kunden diagram shows all four. */
const TWINS = path.resolve(__dirname, '../../packages/core/test/fixtures/dbml/same-name-two-schemas');
const SALES = 'gold/diagrams/sales.dbml';
let root: string;

/** dbt has `fct_order` and `dim_customer` (declared in a schema yml); the diagram's other tables are design only. */
function dbtYml(names: readonly string[] = ['fct_order', 'dim_customer']): YmlData {
  const yml = emptyYmlData();
  for (const name of names) {
    yml.models.set(name, { name, description: '', columns: [], filePath: path.join(root, 'models', 'schema.yml'), tags: [] } as never);
  }
  return yml;
}

/** What dbt holds: the schema yml models, and manifest nodes. */
interface DbtData { yml?: readonly string[]; manifestModels?: readonly ManifestModelInfo[]; sourceFiles?: readonly string[] }

function manifestNode(name: string, schema: string, alias?: string): ManifestModelInfo {
  return { name, uniqueId: `model.shop.${name}`, projectName: 'shop', schema, ...(alias ? { alias } : {}), description: '', columns: [], originalFilePath: `models/${name}.sql` };
}

function buildProvider(projectRoot: string, dbt: DbtData = {}): SemanticEditorProvider {
  const layerService = new LayerService(projectRoot, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(projectRoot, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const context = {
    extensionUri: vscode.Uri.file(path.join(projectRoot, 'no-extension')),
    globalStorageUri: vscode.Uri.file(path.join(projectRoot, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;
  const manifest = {
    models: new Map((dbt.manifestModels ?? []).map((m) => [m.name, m])),
    relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set(),
  };
  return new SemanticEditorProvider(
    context,
    subjectAreaService,
    { loadManifest: async () => manifest, getManifestPath: () => path.join(projectRoot, 'target', 'manifest.json') } as unknown as ManifestService,
    { loadYmlData: async () => {
      const yml = dbtYml(dbt.yml);
      for (const file of dbt.sourceFiles ?? []) yml.sourceFiles!.set(path.basename(file, '.sql').toLowerCase(), file);
      return yml;
    } } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    projectRoot,
    new SelectorsService(subjectAreaService, projectRoot, '.erd-studio'),
    tableLibraryService,
    new OwnWriteTracker(),
  );
}

const at = (rel: string): string => path.join(root, '.erd-studio', rel);

async function loaded(options: { logicalOnly?: boolean; dbt?: DbtData; diagram?: string } = {}) {
  const provider = buildProvider(root, options.dbt);
  if (options.logicalOnly) provider.setLogicalOnly(true);
  const panel = createMockWebviewPanel();
  const file = at(options.diagram ?? SALES);
  const doc = createMockTextDocument(file, fs.readFileSync(file, 'utf-8'), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(doc);
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  await panel._simulateMessage({ type: 'ready' });
  panel._postedMessages.length = 0;
  return { provider, panel };
}

const notices = (panel: ReturnType<typeof createMockWebviewPanel>): string[] =>
  panel._postedMessages.filter((m) => (m as { type: string }).type === 'canvasNotice').map((m) => (m as { payload: { message: string } }).payload.message);
const errors = (panel: ReturnType<typeof createMockWebviewPanel>): string[] =>
  panel._postedMessages.filter((m) => (m as { type: string }).type === 'error').map((m) => (m as { payload: { message: string } }).payload.message);

/** Every file under the project with its bytes, to show nothing was written. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name);
    out.set(path.relative(dir, file), fs.readFileSync(file, 'utf-8'));
  }
  return out;
}

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbt-command-'));
  fs.cpSync(NATIVE, root, { recursive: true });
  fs.writeFileSync(path.join(root, 'dbt_project.yml'), 'name: shop\n', 'utf-8');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('copyDbtCommand', () => {
  it('copies dbt build for the diagram\'s tables in dbt, says which were left out, and writes nothing', async () => {
    const write = vi.spyOn(vscode.env.clipboard, 'writeText');
    const { panel } = await loaded();
    const before = snapshot(root);
    _appliedEdits.length = 0;
    await panel._simulateMessage({ type: 'copyDbtCommand', payload: { verb: 'build' } });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('dbt build --select fct_order dim_customer');
    expect(notices(panel)).toEqual(['Copied: dbt build for 2 of the 6 tables on this diagram. 4 left out: not in dbt yet.']);
    expect(errors(panel)).toEqual([]);
    expect(_appliedEdits).toEqual([]);
    expect(snapshot(root)).toEqual(before);
  });

  it('copies only the selected tables, by their canvas names in any case', async () => {
    const write = vi.spyOn(vscode.env.clipboard, 'writeText');
    const { panel } = await loaded();
    await panel._simulateMessage({ type: 'copyDbtCommand', payload: { verb: 'test', tables: ['DIM_CUSTOMER'] } });
    expect(write).toHaveBeenCalledWith('dbt test --select dim_customer');
    expect(notices(panel)).toEqual(['Copied: dbt test for 1 selected table.']);
  });

  it('copies nothing when no selected table is in dbt, and says so', async () => {
    const write = vi.spyOn(vscode.env.clipboard, 'writeText');
    const { panel } = await loaded();
    await panel._simulateMessage({ type: 'copyDbtCommand', payload: { verb: 'run', tables: ['dim_date', 'dim_region'] } });
    expect(write).not.toHaveBeenCalled();
    expect(notices(panel)).toEqual(['Nothing copied: none of the 2 selected tables is in dbt yet.']);
  });

  it('refuses a table that is not on the diagram, and a bad payload', async () => {
    const write = vi.spyOn(vscode.env.clipboard, 'writeText');
    const { panel } = await loaded();
    await panel._simulateMessage({ type: 'copyDbtCommand', payload: { verb: 'run', tables: ['no_such_table'] } });
    expect(notices(panel)).toEqual(['Nothing copied: "no_such_table" is not on this diagram.']);
    await panel._simulateMessage({ type: 'copyDbtCommand', payload: { verb: 'seed' } });
    await panel._simulateMessage({ type: 'copyDbtCommand', payload: { verb: 'run', tables: [7] } });
    expect(errors(panel)).toEqual(['Copying a dbt command needs build, run or test.', 'Table name is required.']);
    expect(write).not.toHaveBeenCalled();
  });

  it('names a table matched through its warehouse relation by its dbt model, not its diagram name', async () => {
    // dim_region (schema gold) is dbt's stg_region, which builds the relation gold.dim_region.
    const write = vi.spyOn(vscode.env.clipboard, 'writeText');
    const { panel } = await loaded({ dbt: { manifestModels: [manifestNode('stg_region', 'gold', 'dim_region')] } });
    await panel._simulateMessage({ type: 'copyDbtCommand', payload: { verb: 'build' } });
    expect(write).toHaveBeenLastCalledWith('dbt build --select fct_order dim_customer stg_region');
    expect(notices(panel)).toEqual(['Copied: dbt build for 3 of the 6 tables on this diagram. 3 left out: not in dbt yet.']);
    await panel._simulateMessage({ type: 'copyDbtCommand', payload: { verb: 'run', tables: ['dim_region'] } });
    expect(write).toHaveBeenLastCalledWith('dbt run --select stg_region');
  });

  it('spells a table as dbt does when the names differ only in case (dbt matches names exactly)', async () => {
    const write = vi.spyOn(vscode.env.clipboard, 'writeText');
    const { panel } = await loaded({ dbt: { yml: ['fct_order', 'DIM_Customer'], manifestModels: [manifestNode('FCT_Order', 'gold')] } });
    await panel._simulateMessage({ type: 'copyDbtCommand', payload: { verb: 'test' } });
    // The manifest node's spelling first, then (no file here) the schema yml's.
    expect(write).toHaveBeenLastCalledWith('dbt test --select FCT_Order DIM_Customer');
    expect(errors(panel)).toEqual([]);
  });

  it('with no manifest, names a model by its .sql file, which is what dbt names it', async () => {
    const write = vi.spyOn(vscode.env.clipboard, 'writeText');
    const { panel } = await loaded({ dbt: { yml: ['DIM_Customer'], sourceFiles: ['models/gold/Dim_Customer.sql'] } });
    await panel._simulateMessage({ type: 'copyDbtCommand', payload: { verb: 'run', tables: ['dim_customer'] } });
    expect(write).toHaveBeenLastCalledWith('dbt run --select Dim_Customer');
  });

  it('names tables two schema folders share as the dbt models the Physical tab and selectors.yml find them as', async () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.cpSync(TWINS, root, { recursive: true });
    fs.writeFileSync(path.join(root, 'dbt_project.yml'), 'name: p\n', 'utf-8');
    // bqs.addresse is dbt's addresse; ccc's two tables are built under aliases; bqs.kunde is not in dbt.
    const manifestModels = [manifestNode('addresse', 'bqs'), manifestNode('stg_ccc_addresse', 'ccc', 'addresse'), manifestNode('stg_ccc_kunde', 'ccc', 'kunde')];
    const write = vi.spyOn(vscode.env.clipboard, 'writeText');
    const { panel } = await loaded({ diagram: 'bronze/diagrams/kunden.dbml', dbt: { yml: [], manifestModels } });
    await panel._simulateMessage({ type: 'copyDbtCommand', payload: { verb: 'build' } });
    expect(errors(panel)).toEqual([]);
    expect(write).toHaveBeenCalledWith('dbt build --select addresse stg_ccc_addresse stg_ccc_kunde');
    expect(notices(panel)).toEqual(['Copied: dbt build for 3 of the 4 tables on this diagram. 1 left out: not in dbt yet.']);

    // The members selectors.yml writes for the same diagram from the same dbt data.
    const subjectAreas = new SubjectAreaService(new LayerService(root, '.erd-studio'));
    subjectAreas.setTableLibraryService(new TableLibraryService(root, '.erd-studio'));
    const manifest = { models: new Map(manifestModels.map((m) => [m.name, m])), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set<string>() };
    new SelectorsService(subjectAreas, root, '.erd-studio', { dbtModelsOf: (unified) => subjectAreas.dbtModelNamesOf(unified, emptyYmlData(), manifest) }).regenerate();
    const doc = parseDocument(fs.readFileSync(path.join(root, 'selectors.yml'), 'utf-8')).toJS() as {
      selectors: Array<{ name: string; definition: { union: Array<{ value: string }> } }>;
    };
    const members = doc.selectors.find((s) => s.name === 'domain_bronze_kunden')?.definition.union.map((u) => u.value);
    expect(`dbt build --select ${members?.join(' ')}`).toBe(write.mock.calls[0][0]);
  });

  it('past the length limit, the diagram\'s selector stands in only when it selects every model the list names', async () => {
    // dim_region and customer_profile are dbt models with very long names, found through their warehouse relations.
    const long = (stem: string): string => `${stem}_${'x'.repeat(4200)}`;
    const manifestModels = [manifestNode(long('stg_region'), 'gold', 'dim_region'), manifestNode(long('stg_profile'), 'gold', 'customer_profile')];
    const write = vi.spyOn(vscode.env.clipboard, 'writeText');
    const { panel } = await loaded({ dbt: { manifestModels } });

    // selectors.yml is current, and lists those two tables by their names on the diagram: it does not select their models.
    const subjectAreas = new SubjectAreaService(new LayerService(root, '.erd-studio'));
    subjectAreas.setTableLibraryService(new TableLibraryService(root, '.erd-studio'));
    const selectors = new SelectorsService(subjectAreas, root, '.erd-studio');
    selectors.regenerate();
    const selector = selectors.currentSelectorMembersFor(at(SALES));
    expect(selector?.members).toContain('dim_region');
    await panel._simulateMessage({ type: 'copyDbtCommand', payload: { verb: 'build' } });
    const copied = String(write.mock.calls.at(-1)?.[0]);
    expect(copied.startsWith('dbt build --select ')).toBe(true);
    expect(copied).toContain(long('stg_region'));
    expect(copied.length).toBeGreaterThan(8000);
    expect(notices(panel).at(-1)).toMatch(/may be too long for the Windows command prompt/);

    // A selector that lists dbt's names for them does stand in.
    vi.spyOn(SelectorsService.prototype, 'currentSelectorMembersFor').mockReturnValue({
      name: selector!.name,
      members: ['fct_order', 'dim_customer', long('stg_region'), long('stg_profile')],
    });
    await panel._simulateMessage({ type: 'copyDbtCommand', payload: { verb: 'build' } });
    expect(write).toHaveBeenLastCalledWith(`dbt build --selector ${selector!.name}`);
  });

  it('works the same on the Physical tab (it is on the read-only allowlist)', async () => {
    const write = vi.spyOn(vscode.env.clipboard, 'writeText');
    const { provider, panel } = await loaded();
    const entry = [...(provider as unknown as { openPanels: Map<string, { activeStage: string }> }).openPanels.values()][0];
    entry.activeStage = 'physical';
    await panel._simulateMessage({ type: 'copyDbtCommand', payload: { verb: 'run', tables: ['fct_order'] } });
    expect(write).toHaveBeenCalledWith('dbt run --select fct_order');
    expect(notices(panel)).toEqual(['Copied: dbt run for 1 selected table.']);
    expect(errors(panel)).toEqual([]);
  });

  it('in a folder without dbt, says it needs a dbt project and copies nothing', async () => {
    const write = vi.spyOn(vscode.env.clipboard, 'writeText');
    const { panel } = await loaded({ logicalOnly: true });
    await panel._simulateMessage({ type: 'copyDbtCommand', payload: { verb: 'build' } });
    expect(write).not.toHaveBeenCalled();
    expect(notices(panel)).toEqual([DBT_COMMAND_NEEDS_DBT_MESSAGE]);
    expect(DBT_COMMAND_NEEDS_DBT_MESSAGE).toBe('Copying a dbt command needs a dbt project. Open the folder that holds dbt_project.yml.');
  });
});
