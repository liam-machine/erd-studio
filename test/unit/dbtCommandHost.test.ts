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
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';
import type { YmlData } from '../../src/types/ymlData';

const NATIVE = path.resolve(__dirname, '../fixtures/dbml-native');
const SALES = 'gold/diagrams/sales.dbml';
let root: string;

/** dbt has `fct_order` and `dim_customer` (declared in a schema yml); the diagram's other tables are design only. */
function dbtYml(): YmlData {
  const yml = emptyYmlData();
  for (const name of ['fct_order', 'dim_customer']) {
    yml.models.set(name, { name, description: '', columns: [] } as never);
  }
  return yml;
}

function buildProvider(projectRoot: string): SemanticEditorProvider {
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
  const manifest = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
  return new SemanticEditorProvider(
    context,
    subjectAreaService,
    { loadManifest: async () => manifest } as unknown as ManifestService,
    { loadYmlData: async () => dbtYml() } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    projectRoot,
    new SelectorsService(subjectAreaService, projectRoot, '.erd-studio'),
    tableLibraryService,
    new OwnWriteTracker(),
  );
}

const at = (rel: string): string => path.join(root, '.erd-studio', rel);

async function loaded(options: { logicalOnly?: boolean } = {}) {
  const provider = buildProvider(root);
  if (options.logicalOnly) provider.setLogicalOnly(true);
  const panel = createMockWebviewPanel();
  const doc = createMockTextDocument(at(SALES), fs.readFileSync(at(SALES), 'utf-8'), { persist: true });
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
