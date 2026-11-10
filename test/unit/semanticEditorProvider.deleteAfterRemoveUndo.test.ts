/**
 * #274 item 1: Remove from Diagram on a DBML diagram, then Delete Table File
 * from the prompt that follows, then Undo with the canvas in front.
 *
 * VS Code's Undo on the canvas rewinds the most recent WorkspaceEdit that
 * touched the canvas's own document (and, for a multi-file edit, every file of
 * that edit, putting deleted files back). The test records each applied edit
 * with the canvas document's text just before it, so it can say exactly what
 * that Undo restores, and checks the restored diagram only `use`s table files
 * that exist afterwards.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  _fireDidChangeTextDocument,
  _mockDocuments,
  _resetMockWorkspace,
  createMockTextDocument,
  createMockWebviewPanel,
  TextDocumentChangeReason,
} from '../__mocks__/vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';

const REPO_ROOT = path.resolve(__dirname, '../..');
const NATIVE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native');

let root: string;
const at = (rel: string): string => path.join(root, '.erd-studio', rel);

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
    { loadYmlData: async () => ({ models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map() }) } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    projectRoot,
    new SelectorsService(subjectAreaService, projectRoot, '.erd-studio'),
    tableLibraryService,
    new OwnWriteTracker(),
  );
}

type Op = { kind: string; uri?: vscode.Uri; oldUri?: vscode.Uri; newUri?: vscode.Uri };
type Recorded = { ops: Op[]; canvasTextBefore: string };

/** Every `use { table … } from '<path>'` in a diagram's text, resolved against the diagram's folder. */
function usedTableFiles(diagramPath: string, text: string): string[] {
  return [...text.matchAll(/^use\s*\{\s*table\s+[^}]+\}\s*from\s*'([^']+)'/gm)]
    .map((m) => path.resolve(path.dirname(diagramPath), m[1]));
}

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-274-'));
  fs.cpSync(NATIVE, root, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('#274 item 1: Delete Table File after Remove from Diagram, then Undo on the canvas', () => {
  async function removeThenDelete(
    table = 'dim_region',
    answer: (choose: () => void, panel: ReturnType<typeof createMockWebviewPanel>, provider: SemanticEditorProvider) => void = (choose) => choose(),
    before: (provider: SemanticEditorProvider, sales: ReturnType<typeof createMockTextDocument>) => Promise<void> = async () => {},
  ) {
    const salesPath = at('gold/diagrams/sales.dbml');
    const regionPath = at(`gold/tables/gold/${table}.dbml`);
    const sales = createMockTextDocument(salesPath, fs.readFileSync(salesPath, 'utf-8'), { persist: true });
    const provider = buildProvider(root);
    const panel = createMockWebviewPanel();
    await provider.resolveCustomTextEditor(
      sales as unknown as vscode.TextDocument,
      panel as unknown as vscode.WebviewPanel,
      {} as vscode.CancellationToken,
    );
    await panel._simulateMessage({ type: 'ready' });
    await before(provider, sales);

    // Record every applied edit with the canvas document's text just before it.
    const recorded: Recorded[] = [];
    const applyEdit = vscode.workspace.applyEdit;
    vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async (edit) => {
      recorded.push({ ops: [...(edit as unknown as { _ops: Op[] })._ops], canvasTextBefore: sales.getText() });
      return applyEdit(edit);
    });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(((m: string, ...items: string[]) =>
      String(m).includes('Delete its table file too')
        ? new Promise((resolve) => answer(() => resolve(items[0]), panel, provider))
        : Promise.resolve(undefined)) as never);

    await panel._simulateMessage({ type: 'removeModels', payload: { modelNames: [table] } });
    await vi.waitFor(() => expect(fs.existsSync(regionPath)).toBe(false));
    // Let the cascade's saves and refresh finish.
    await vi.waitFor(() => expect(info.mock.calls.some((c) => String(c[0]).startsWith('Deleted'))).toBe(true));
    return { salesPath, regionPath, recorded, info, sales, panel };
  }

  /** Open one more canvas on `document` and let it load. */
  async function openCanvas(provider: SemanticEditorProvider, document: ReturnType<typeof createMockTextDocument>) {
    const panel = createMockWebviewPanel();
    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      panel as unknown as vscode.WebviewPanel,
      {} as vscode.CancellationToken,
    );
    await panel._simulateMessage({ type: 'ready' });
    return panel;
  }

  const anchoredOn = (ops: Op[], p: string): boolean =>
    ops.some((op) => op.kind === 'replace' && path.resolve(op.uri!.fsPath) === path.resolve(p));

  const drawn = (panel: ReturnType<typeof createMockWebviewPanel>): number =>
    (panel._postedMessages as Array<{ type: string }>).filter((m) => m.type === 'domainLoaded').length;

  it('one Undo on the canvas never restores a use line for a table file the delete removed', async () => {
    const { salesPath, recorded } = await removeThenDelete();
    const touches = (op: Op, p: string) => [op.uri, op.oldUri, op.newUri].some((u) => u && path.resolve(u.fsPath) === path.resolve(p));

    // The step Cmd+Z on the canvas rewinds: the last edit that touched sales.dbml.
    const step = [...recorded].reverse().find((r) => r.ops.some((op) => touches(op, salesPath)));
    expect(step).toBeDefined();
    const restoredText = step!.canvasTextBefore;
    // Files that same step deletes come back with it.
    const comeBack = new Set(step!.ops.filter((op) => op.kind === 'deleteFile').map((op) => path.resolve(op.uri!.fsPath)));
    const missing = usedTableFiles(salesPath, restoredText)
      .filter((f) => !fs.existsSync(f) && !comeBack.has(f))
      .map((f) => path.relative(path.join(root, '.erd-studio'), f).split(path.sep).join('/'));

    expect(missing, 'sales.dbml after one canvas Undo would `use` table files that no longer exist').toEqual([]);
  });

  it('the Delete Table File prompt does not offer "its place in 0 other diagrams"', async () => {
    const { info } = await removeThenDelete();
    const prompt = info.mock.calls.find((c) => String(c[0]).includes('Delete its table file too'));
    expect(String(prompt?.[0])).not.toMatch(/\b0 other diagrams\b/);
  });

  it('the delete is one edit with the diagram that asked (its undo anchor), and leaves the diagram saved', async () => {
    const { salesPath, regionPath, recorded, sales } = await removeThenDelete();
    const last = recorded[recorded.length - 1].ops;
    expect(last.some((op) => op.kind === 'deleteFile' && path.resolve(op.uri!.fsPath) === path.resolve(regionPath))).toBe(true);
    expect(last.some((op) => op.kind === 'replace' && path.resolve(op.uri!.fsPath) === path.resolve(salesPath))).toBe(true);
    // The anchor replaces a character with itself: nothing about the diagram changed, and nothing is left unsaved.
    expect(sales.isDirty).toBe(false);
    expect(fs.readFileSync(salesPath, 'utf-8')).toBe(sales.getText());
    expect(sales.getText()).not.toMatch(/\bdim_region\b/);
  });

  it('Cmd+Z on the canvas saves the relationships files the delete rewound (no Save All)', async () => {
    const customersPath = at('gold/relationships/customers.dbml');
    const before = fs.readFileSync(customersPath, 'utf-8');
    const { regionPath, sales, panel } = await removeThenDelete();
    expect(fs.readFileSync(customersPath, 'utf-8')).not.toBe(before);
    const customers = _mockDocuments.get(vscode.Uri.file(customersPath).toString())!;
    expect(customers).toBeDefined();
    const regionText = fs.readFileSync(path.join(NATIVE, '.erd-studio/gold/tables/gold/dim_region.dbml'), 'utf-8');

    // What VS Code's undo of the step does: the deleted file comes back, the
    // relationships file is rewound in memory, the diagram's anchor too.
    const draws = drawn(panel);
    fs.writeFileSync(regionPath, regionText);
    customers._setText(before);
    await _fireDidChangeTextDocument(customers, TextDocumentChangeReason.Undo);
    await _fireDidChangeTextDocument(sales, TextDocumentChangeReason.Undo);

    await vi.waitFor(() => expect(fs.readFileSync(customersPath, 'utf-8')).toBe(before));
    expect(customers.isDirty).toBe(false);
    await vi.waitFor(() => expect(drawn(panel)).toBeGreaterThan(draws));
  });

  it('a delete with no relationship and no other diagram: one plain sentence, and its Undo still redraws', async () => {
    const { regionPath, sales, panel, info } = await removeThenDelete('bridge_empty');
    const prompt = String(info.mock.calls.find((c) => String(c[0]).includes('Delete its table file too'))?.[0]);
    expect(prompt).toMatch(/Delete its table file too\? This removes the table's file\.$/);

    // Its undo: the file comes back and the diagram's anchor is rewound (its text as on disk).
    const draws = drawn(panel);
    fs.writeFileSync(regionPath, fs.readFileSync(path.join(NATIVE, '.erd-studio/gold/tables/gold/bridge_empty.dbml'), 'utf-8'));
    await _fireDidChangeTextDocument(sales, TextDocumentChangeReason.Undo);
    await vi.waitFor(() => expect(drawn(panel)).toBeGreaterThan(draws));
  });

  it('a canvas closed before the answer is not reopened for an anchor: the delete is made on its own', async () => {
    const { salesPath, recorded, sales } = await removeThenDelete('dim_region', (choose, panel) => {
      panel.dispose();
      choose();
    });
    const last = recorded[recorded.length - 1].ops;
    expect(last.some((op) => op.kind === 'deleteFile')).toBe(true);
    expect(last.some((op) => op.kind === 'replace' && path.resolve(op.uri!.fsPath) === path.resolve(salesPath))).toBe(false);
    expect(sales.isDirty).toBe(false);
  });

  it('a second canvas on the same diagram: answering in the first still anchors the delete on the diagram', async () => {
    const { salesPath, recorded, sales } = await removeThenDelete('dim_region', (choose) => choose(), async (provider, document) => {
      await openCanvas(provider, document);
    });
    const last = recorded[recorded.length - 1].ops;
    expect(last.some((op) => op.kind === 'deleteFile')).toBe(true);
    expect(anchoredOn(last, salesPath), 'delete anchored on sales.dbml').toBe(true);
    expect(sales.isDirty).toBe(false);
  });

  it('a canvas closed and reopened before the answer: the delete anchors on the reopened canvas\'s diagram', async () => {
    const salesPathFor = () => at('gold/diagrams/sales.dbml');
    let reopened: ReturnType<typeof createMockTextDocument> | undefined;
    const { salesPath, recorded } = await removeThenDelete('dim_region', (choose, panel, provider) => {
      panel.dispose();
      // Reopened as a new document (VS Code closed the old one with its last editor).
      reopened = createMockTextDocument(salesPathFor(), fs.readFileSync(salesPathFor(), 'utf-8'), { persist: true });
      void openCanvas(provider, reopened).then(choose);
    });
    const last = recorded[recorded.length - 1].ops;
    expect(last.some((op) => op.kind === 'deleteFile')).toBe(true);
    expect(anchoredOn(last, salesPath), 'delete anchored on the reopened sales.dbml').toBe(true);
    expect(reopened!.isDirty).toBe(false);
    expect(fs.readFileSync(salesPath, 'utf-8')).toBe(reopened!.getText());
  });
});
