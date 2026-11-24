/**
 * Every layer takes a new diagram, whatever its `creatable` flag in
 * layers.json says (#360). The flag was saved as `false` for a detected
 * `bronze/` folder and nothing in the UI could change it, so a Bronze layer
 * that already held a diagram offered no New Diagram (no inline +, no
 * right-click, no "New Diagram…" row) and New Diagram with no layer picked
 * Gold without asking. The flag is still read and written, never rewritten.
 *
 * The tree tests elsewhere mock LayerService, so they cannot pin this rule:
 * Real LayerService / SubjectAreaService / TableLibraryService over a DBML
 * (schemaVersion 7) project on disk: `bronze/` holds `humanresources`,
 * `gold/` holds `person`, as in the reporter's screenshot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { SubjectAreaTreeProvider, type TreeElement } from '../../src/providers/DomainTreeProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { activate, _resetFirstRunGuardForTests } from '../../src/extension';

type Context = vscode.ExtensionContext;

let root: string;
let semantic: string;

function write(rel: string, text: string): void {
  const file = path.join(semantic, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const table = (schema: string, name: string): string => `Table ${schema}.${name} {\n  id INT [pk]\n}\n`;
const diagram = (name: string, uses: string[]): string =>
  `Project ${name} {\n  erd_schema_version: '7'\n}\n\n${uses.map((u) => `use { table ${u.split('/').pop()} } from '../tables/${u}.dbml'`).join('\n')}\n`;

/** The reporter's project: Bronze holds humanresources (2 tables here), Gold holds person (0 tables). */
function reporterProject(): void {
  write('bronze/tables/humanresources/employee.dbml', table('humanresources', 'employee'));
  write('bronze/tables/humanresources/department.dbml', table('humanresources', 'department'));
  write('bronze/diagrams/humanresources.dbml', diagram('humanresources', ['humanresources/employee', 'humanresources/department']));
  write('gold/diagrams/person.dbml', diagram('person', []));
}

const BRONZE_FALSE = {
  schemaVersion: 1,
  layers: [
    { id: 'bronze', label: 'Bronze', abbreviation: 'BRZ', color: '#cd7f32', creatable: false, order: 0 },
    { id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 1 },
  ],
};

function tree(): { provider: SubjectAreaTreeProvider; layerService: LayerService } {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const provider = new SubjectAreaTreeProvider(subjectAreaService, layerService, root, '.erd-studio');
  provider.setRowDetails?.('full');
  return { provider, layerService };
}

function layerRow(provider: SubjectAreaTreeProvider, id: string): TreeElement | undefined {
  return (provider.getChildren() ?? []).find((e) => e.type === 'layer' && e.layer === id);
}

describe('#360: the Diagrams tree over bronze/ + gold/', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-360-'));
    semantic = path.join(root, '.erd-studio');
    reporterProject();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('(b) layers.json says bronze creatable:false — the Bronze row offers New Diagram', () => {
    write('layers.json', JSON.stringify(BRONZE_FALSE, null, 2));
    const { provider } = tree();
    const bronze = layerRow(provider, 'bronze');
    expect(bronze, 'Bronze is a layer row').toBeDefined();
    const children = provider.getChildren(bronze!) ?? [];
    expect(children.map((c) => c.type)).toContain('domain');
    // What the user needs: an inline + / right-click New Diagram on the Bronze row…
    expect(provider.getTreeItem(bronze!).contextValue).toBe('layerCreatable');
    // …and (full rows) a "New Diagram…" child row, as Gold has.
    expect(children.map((c) => c.type)).toContain('newDomain');
  });

  it('reads the flag as written and never rewrites layers.json to open the layer', () => {
    const text = JSON.stringify(BRONZE_FALSE, null, 2);
    write('layers.json', text);
    const { provider, layerService } = tree();
    provider.getChildren(layerRow(provider, 'bronze')!);
    expect(layerService.getLayer('bronze')?.creatable).toBe(false);
    expect(layerService.getCreatableLayers().map((l) => l.id)).toEqual(['bronze', 'gold']);
    expect(fs.readFileSync(path.join(semantic, 'layers.json'), 'utf-8')).toBe(text);
  });

  it('a layer that is not there, or one named for a stage (never a diagram folder), takes none', () => {
    write('layers.json', JSON.stringify({
      schemaVersion: 1,
      layers: [...BRONZE_FALSE.layers, { id: 'logical', label: 'Logical', abbreviation: 'LOG', color: '#888888', creatable: true, order: 2 }],
    }, null, 2));
    const { layerService } = tree();
    expect(layerService.isCreatable('platinum')).toBe(false);
    expect(layerService.isCreatable('logical')).toBe(false);
    expect(layerService.getCreatableLayers().map((l) => l.id)).toEqual(['bronze', 'gold']);
  });

  it('(a) no layers.json — a detected bronze/ folder is saved as creatable: true, as every other layer is', () => {
    const { layerService } = tree();
    // What Initialize Layer Configuration and the "Save Config" prompt write
    // (it was false for bronze): an older version reading the file honours it.
    expect(layerService.detectLayersFromFilesystem().map((l) => [l.id, l.creatable])).toEqual([['bronze', true], ['gold', true]]);
  });
});

// ---------------------------------------------------------------------------
// The real erdStudio.createDomain (no layer argument), through activate().
// ---------------------------------------------------------------------------

function makeContext(dir: string, info?: Map<string, unknown>): Context {
  const globalState = new Map<string, unknown>([['erdStudio.gettingStartedShown', true]]);
  const workspaceState = info ?? new Map<string, unknown>([
    ['erdStudio.harnessInstallPrompted', true],
    ['erdStudio.diagramsNudgeShown', true],
    ['erdStudio.startSuggestion', { shown: 1, answered: true }],
  ]);
  return {
    subscriptions: [],
    extension: { packageJSON: JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')) },
    extensionUri: vscode.Uri.file(path.resolve(__dirname, '../..')),
    globalStorageUri: vscode.Uri.file(path.join(dir, '.global-storage')),
    globalState: { get: (k: string) => globalState.get(k), update: async (k: string, v: unknown) => { globalState.set(k, v); } },
    workspaceState: { get: (k: string) => workspaceState.get(k), update: async (k: string, v: unknown) => { workspaceState.set(k, v); }, keys: () => [...workspaceState.keys()] },
    secrets: vscode.createMockSecretStorage(),
  } as unknown as Context;
}

describe('#360: New Diagram (no layer) in the reporter\'s project', () => {
  let context: Context;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-360-act-'));
    semantic = path.join(root, '.erd-studio');
    reporterProject();
    vscode._resetRegisteredCommands();
    vscode._resetMockConfiguration();
    vscode._resetMockWorkspace();
    vscode._clearMockFileWatchers();
    vscode._resetMockWebviewPanels();
    vscode._setMockExtensions([]);
    _resetFirstRunGuardForTests();
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    vi.useFakeTimers();
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'p', index: 0 }];
    context = makeContext(root);
  });
  afterEach(async () => {
    for (const sub of [...context.subscriptions].reverse()) { try { await sub.dispose(); } catch { /* */ } }
    vscode._resetMockWebviewPanels();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('the activation "Save Config" prompt saves a detected bronze as creatable: true (it used to save false)', async () => {
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (msg: string) =>
      (msg.startsWith('Detected layers') ? 'Save Config' : undefined)) as never);
    await activate(context);
    await vi.advanceTimersByTimeAsync(10_000);
    const asked = info.mock.calls.map((c) => c[0]);
    expect(asked).toContain('Detected layers: Bronze, Gold. Would you like to save layer configuration for customization?');
    const saved = JSON.parse(fs.readFileSync(path.join(semantic, 'layers.json'), 'utf-8')) as typeof BRONZE_FALSE;
    expect(saved.layers.map((l) => [l.id, l.creatable])).toEqual([['bronze', true], ['gold', true]]);
  });

  it('asks which layer (Bronze offered), rather than silently writing to Gold', async () => {
    write('layers.json', JSON.stringify(BRONZE_FALSE, null, 2));
    await activate(context);
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ value?: string }>) =>
      items.find((i) => i.value === 'bronze')) as never);
    const input = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('Payroll' as never);

    await vscode.commands.executeCommand('erdStudio.createDomain');

    const prompt = (input.mock.calls[0]?.[0] as { prompt?: string } | undefined)?.prompt;
    const offered = (pick.mock.calls[0]?.[0] as Array<{ value?: string }> | undefined)?.map((i) => i.value).filter(Boolean);
    expect({ pickShown: pick.mock.calls.length > 0, offered, prompt }).toMatchObject({ pickShown: true, offered: expect.arrayContaining(['bronze', 'gold']) });
    expect(fs.existsSync(path.join(semantic, 'bronze', 'diagrams', 'payroll.dbml'))).toBe(true);
    expect(fs.existsSync(path.join(semantic, 'gold', 'diagrams', 'payroll.dbml'))).toBe(false);
    // Asked, not rewritten: the flag on disk is as the user's file had it.
    expect(JSON.parse(fs.readFileSync(path.join(semantic, 'layers.json'), 'utf-8'))).toEqual(BRONZE_FALSE);
  });

  it('(c) a Bronze-only project: New Diagram starts one in Bronze, not "No layers are configured"', async () => {
    fs.rmSync(path.join(semantic, 'gold'), { recursive: true, force: true });
    write('layers.json', JSON.stringify({ schemaVersion: 1, layers: [BRONZE_FALSE.layers[0]] }, null, 2));
    await activate(context);
    const err = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    const input = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('Payroll' as never);

    await vscode.commands.executeCommand('erdStudio.createDomain');

    expect(err.mock.calls.map((c) => c[0])).toEqual([]);
    expect(input).toHaveBeenCalled();
    expect(fs.existsSync(path.join(semantic, 'bronze', 'diagrams', 'payroll.dbml'))).toBe(true);
  });
});
