/**
 * The host side of finding a table (`SemanticEditorProvider`): `revealTable`
 * reaches a canvas only once it has its diagram (held while it opens, posted
 * at once to one already loaded, a stale one dropped); `addTablesToDiagram`
 * (Add to Diagram…) adds through the Add Existing Tables edit — one edit —
 * then selects the first table; and a table context menu's actions each do
 * their one thing, Move Table alone refused on the physical stage. The
 * webview side is `useRevealTable` (`test/unit/useRevealTable.test.tsx`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { _appliedEdits, _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import { PENDING_REVEAL_MS, SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';

const NATIVE = path.resolve(__dirname, '../fixtures/dbml-native');
let root: string;

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
  const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
  return new SemanticEditorProvider(
    context,
    subjectAreaService,
    { loadManifest: async () => empty } as unknown as ManifestService,
    { loadYmlData: async () => empty } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    projectRoot,
    new SelectorsService(subjectAreaService, projectRoot, '.erd-studio'),
    tableLibraryService,
    new OwnWriteTracker(),
  );
}

const at = (rel: string): string => path.join(root, '.erd-studio', rel);
const SALES = 'gold/diagrams/sales.dbml';
const STAGING = 'silver/diagrams/staging.dbml';

async function open(provider: SemanticEditorProvider, rel = SALES) {
  const panel = createMockWebviewPanel();
  const doc = createMockTextDocument(at(rel), fs.readFileSync(at(rel), 'utf-8'), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(doc);
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  return { panel, doc };
}

const types = (panel: ReturnType<typeof createMockWebviewPanel>): string[] =>
  panel._postedMessages.map((m) => (m as { type: string }).type);
const reveals = (panel: ReturnType<typeof createMockWebviewPanel>) =>
  panel._postedMessages.filter((m) => (m as { type: string }).type === 'revealTable');
const errors = (panel: ReturnType<typeof createMockWebviewPanel>): string[] =>
  panel._postedMessages.filter((m) => (m as { type: string }).type === 'error').map((m) => (m as { payload: { message: string } }).payload.message);

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-reveal-table-'));
  fs.cpSync(NATIVE, root, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('revealTable', () => {
  it('holds a reveal asked for while the canvas opens, and posts it right after the diagram', async () => {
    const provider = buildProvider(root);
    const { panel } = await open(provider);
    await provider.revealTable(vscode.Uri.file(at(SALES)), 'dim_customer');
    expect(types(panel)).not.toContain('revealTable');
    await panel._simulateMessage({ type: 'ready' });
    await vi.waitFor(() => expect(reveals(panel)).toEqual([{ type: 'revealTable', payload: { modelName: 'dim_customer' } }]));
    expect(types(panel).indexOf('revealTable')).toBeGreaterThan(types(panel).indexOf('domainLoaded'));
  });

  it('posts at once to a canvas that has its diagram, and only once', async () => {
    const provider = buildProvider(root);
    const { panel } = await open(provider);
    await panel._simulateMessage({ type: 'ready' });
    await provider.revealTable(vscode.Uri.file(at(SALES)), 'fct_order');
    expect(types(panel).at(-1)).toBe('revealTable');
    await panel._simulateMessage({ type: 'ready' });
    expect(reveals(panel)).toHaveLength(1);
  });

  it('drops a reveal its canvas never loaded in time', async () => {
    const provider = buildProvider(root);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await provider.revealTable(vscode.Uri.file(at(SALES)), 'fct_order');
    clock.mockReturnValue(now + PENDING_REVEAL_MS + 1);
    const { panel } = await open(provider);
    await panel._simulateMessage({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 20));
    expect(types(panel)).toContain('domainLoaded');
    expect(types(panel)).not.toContain('revealTable');
  });
});

describe('addTablesToDiagram (Add to Diagram…)', () => {
  it('adds the tables in one edit, then selects the first', async () => {
    const provider = buildProvider(root);
    const { panel, doc } = await open(provider, STAGING);
    await panel._simulateMessage({ type: 'ready' });
    _appliedEdits.length = 0;
    // It says what it added (Add to Open Diagram's status bar names exactly that).
    expect(await provider.addTablesToDiagram(vscode.Uri.file(at(STAGING)), ['dim_customer', 'dim_region'])).toEqual(['dim_customer', 'dim_region']);
    expect(errors(panel)).toEqual([]);
    expect(_appliedEdits).toHaveLength(1);
    expect(doc.getText()).toContain('use { table gold.dim_customer }');
    expect(doc.getText()).toContain('use { table gold.dim_region }');
    expect(reveals(panel)).toEqual([{ type: 'revealTable', payload: { modelName: 'dim_customer' } }]);
  });

  it('a table already on the diagram is selected and said to be there, on the canvas, and nothing is written', async () => {
    const provider = buildProvider(root);
    const { panel } = await open(provider, STAGING);
    await panel._simulateMessage({ type: 'ready' });
    _appliedEdits.length = 0;
    panel._postedMessages.length = 0;
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    expect(await provider.addTablesToDiagram(vscode.Uri.file(at(STAGING)), ['fct_order'])).toEqual([]);
    expect(_appliedEdits).toHaveLength(0);
    expect(panel._postedMessages).toContainEqual({ type: 'canvasNotice', payload: { message: '"fct_order" is already on this diagram.' } });
    expect(reveals(panel)).toEqual([{ type: 'revealTable', payload: { modelName: 'fct_order' } }]);
    expect(info).not.toHaveBeenCalled();
  });

  it('of a mix, adds the new one and names the one already there, on the canvas', async () => {
    const provider = buildProvider(root);
    const { panel, doc } = await open(provider, STAGING);
    await panel._simulateMessage({ type: 'ready' });
    _appliedEdits.length = 0;
    panel._postedMessages.length = 0;
    expect(await provider.addTablesToDiagram(vscode.Uri.file(at(STAGING)), ['fct_order', 'dim_region'])).toEqual(['dim_region']);
    expect(_appliedEdits).toHaveLength(1);
    expect(doc.getText()).toContain('use { table gold.dim_region }');
    expect(panel._postedMessages).toContainEqual({ type: 'canvasNotice', payload: { message: 'Added 1 table. Already on this diagram: fct_order.' } });
    expect(reveals(panel)).toEqual([{ type: 'revealTable', payload: { modelName: 'dim_region' } }]);
  });

  it('waits for a diagram that is still opening', async () => {
    const provider = buildProvider(root);
    // Held for the canvas's ready: what it will add is not known yet.
    expect(await provider.addTablesToDiagram(vscode.Uri.file(at(STAGING)), ['dim_region'])).toBeUndefined();
    const { panel, doc } = await open(provider, STAGING);
    await panel._simulateMessage({ type: 'ready' });
    await vi.waitFor(() => expect(reveals(panel)).toHaveLength(1));
    expect(doc.getText()).toContain('use { table gold.dim_region }');
  });
});

describe('a table\'s context menu', () => {
  async function loaded(rel = SALES) {
    const provider = buildProvider(root);
    const opened = await open(provider, rel);
    await opened.panel._simulateMessage({ type: 'ready' });
    opened.panel._postedMessages.length = 0;
    return { provider, ...opened };
  }

  it('Copy Path puts the file\'s path from the project folder on the clipboard', async () => {
    const write = vi.spyOn(vscode.env.clipboard, 'writeText');
    const { panel } = await loaded();
    await panel._simulateMessage({ type: 'copyTablePath', payload: { modelName: 'DIM_CUSTOMER' } });
    expect(write).toHaveBeenCalledWith('.erd-studio/gold/tables/gold/dim_customer.dbml');
    expect(errors(panel)).toEqual([]);
  });

  it('Move Table runs the sidebar\'s Move Table on the table\'s file', async () => {
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
    const { panel } = await loaded();
    await panel._simulateMessage({ type: 'moveTable', payload: { modelName: 'fct_order' } });
    expect(exec).toHaveBeenCalledWith('erdStudio.moveTable', at('gold/tables/gold/fct_order.dbml'));
  });

  it('Show on Other Diagrams… and Reveal in Table Library run their commands; the search hint runs Go to Table', async () => {
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
    const { panel } = await loaded();
    await panel._simulateMessage({ type: 'showTableOnOtherDiagrams', payload: { modelName: 'fct_order' } });
    expect(exec).toHaveBeenCalledWith('erdStudio.openInDiagram', { type: 'model', name: 'fct_order' }, { excludeDiagram: at(SALES) });
    await panel._simulateMessage({ type: 'revealTableInLibrary', payload: { modelName: 'fct_order' } });
    expect(exec).toHaveBeenCalledWith('erdStudio.revealInTableLibrary', 'fct_order');
    await panel._simulateMessage({ type: 'goToTable', payload: { query: ' dim_ ' } });
    expect(exec).toHaveBeenCalledWith('erdStudio.goToTable', 'dim_');
  });

  it('refuses a bad payload, and names a table the library does not have', async () => {
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
    const { panel } = await loaded();
    await panel._simulateMessage({ type: 'copyTablePath', payload: { modelName: '../x' } });
    await panel._simulateMessage({ type: 'goToTable', payload: { query: 42 } });
    await panel._simulateMessage({ type: 'moveTable', payload: { modelName: 'no_such_table' } });
    expect(errors(panel)).toEqual([
      'Table name cannot contain path separators.',
      'Failed to open Go to Table: The search text must be text.',
      'Table "no_such_table" not found in the Table Library.',
    ]);
    expect(exec).not.toHaveBeenCalledWith('erdStudio.moveTable', expect.anything());
  });

  it('on the physical stage refuses Move Table but still copies the path', async () => {
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
    const write = vi.spyOn(vscode.env.clipboard, 'writeText');
    const { provider, panel } = await loaded();
    const entry = [...(provider as unknown as { openPanels: Map<string, { activeStage: string }> }).openPanels.values()][0];
    entry.activeStage = 'physical';
    await panel._simulateMessage({ type: 'moveTable', payload: { modelName: 'fct_order' } });
    expect(exec).not.toHaveBeenCalledWith('erdStudio.moveTable', expect.anything());
    expect(errors(panel)).toHaveLength(1);
    await panel._simulateMessage({ type: 'copyTablePath', payload: { modelName: 'fct_order' } });
    expect(write).toHaveBeenCalledWith('.erd-studio/gold/tables/gold/fct_order.dbml');
  });
});
