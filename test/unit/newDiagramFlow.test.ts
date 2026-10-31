/**
 * New Diagram and New Layer as `activate()` wires them, over a temp copy of
 * the fixture project: the questions they ask and what they write. New
 * Diagram asks for the layer (with how many diagrams each holds, and New
 * Layer… to make one and carry on) and the name as people write it; New
 * Layer asks for one name. When they fail: `diagramCommands.failures.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, slugFromName, _resetFirstRunGuardForTests } from '../../src/extension';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));

type Context = import('vscode').ExtensionContext;
type Pick = { label: string; description?: string; kind?: number; value?: string; newLayer?: true };
type Validate = (value: string) => string | { message: string; severity: number } | undefined;

function makeContext(root: string): Context {
  const globalState = new Map<string, unknown>([['erdStudio.gettingStartedShown', true]]);
  const workspaceState = new Map<string, unknown>([
    ['erdStudio.harnessInstallPrompted', true],
    ['erdStudio.diagramsNudgeShown', true],
  ]);
  return {
    subscriptions: [],
    extension: { packageJSON: packageJson },
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    globalState: { get: (k: string) => globalState.get(k), update: async (k: string, v: unknown) => { globalState.set(k, v); } },
    workspaceState: { get: (k: string) => workspaceState.get(k), update: async (k: string, v: unknown) => { workspaceState.set(k, v); } },
    secrets: vscode.createMockSecretStorage(),
  } as unknown as Context;
}

let root: string;
let project: string;
let context: Context;

const layersFile = () => JSON.parse(fs.readFileSync(path.join(project, '.erd-studio', 'layers.json'), 'utf-8')) as {
  layers: Array<{ id: string; label: string; abbreviation: string; color: string; creatable: boolean }>;
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-new-'));
  project = path.join(root, 'project');
  fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
  context = makeContext(root);
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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.useFakeTimers();
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(project), name: 'project', index: 0 }];
  await activate(context);
});

afterEach(async () => {
  for (const sub of [...context.subscriptions].reverse()) {
    try { await sub.dispose(); } catch { /* best effort */ }
  }
  for (const panel of [...vscode.window._webviewPanels]) { panel.dispose(); }
  vscode._resetMockWebviewPanels();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('slugFromName', () => {
  it('turns a name as people write it into a file name', () => {
    expect(slugFromName('Customer 360')).toBe('customer-360');
    expect(slugFromName('  Sales & Marketing! ')).toBe('sales-marketing');
    expect(slugFromName('orders_v2')).toBe('orders_v2');
    expect(slugFromName('2024 plan')).toBe('2024-plan'); // the name check refuses a leading digit
  });
});

describe('New Diagram', () => {
  it('lists each layer with its diagram count, then New Layer…, and names the layer in the name box', async () => {
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Pick[]) => items.find((i) => i.value === 'gold')) as never);
    let validate: Validate | undefined;
    const input = vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (o: { validateInput: Validate }) => {
      validate = o.validateInput;
      return 'Customer 360';
    }) as never);

    await vscode.commands.executeCommand('erdStudio.createDomain');

    const items = pick.mock.calls[0][0] as Pick[];
    const counted = fs.readdirSync(path.join(project, '.erd-studio', 'silver')).filter((f) => f.endsWith('.json')).length;
    expect(items.map((i) => [i.label, i.description])).toEqual([
      ['Silver', `${counted} diagrams`],
      ['Gold', expect.stringMatching(/^(no diagrams yet|\d+ diagrams?)$/)],
      ['', undefined],
      ['$(new-folder) New Layer…', 'a new stage, such as staging or marts'],
    ]);
    expect(items[2].kind).toBe(vscode.QuickPickItemKind.Separator);
    expect(input).toHaveBeenCalledTimes(1);
    expect((input.mock.calls[0][0] as { prompt: string }).prompt).toBe('Name the diagram. It is saved in the Gold layer.');
    // "Customer 360" is fine: it says what the file is called.
    expect(validate!('Customer 360')).toEqual({ message: 'Saved as customer-360', severity: vscode.InputBoxValidationSeverity.Info });
    expect(validate!('customer-360')).toBeUndefined();
    expect(validate!('360 view')).toMatch(/starting with a letter/);
    expect(validate!('  ')).toBe('Give the diagram a name');
    expect(fs.existsSync(path.join(project, '.erd-studio', 'gold', 'customer-360.json'))).toBe(true);
  });

  it('New Layer… in the picker makes the layer and goes on to name the diagram in it', async () => {
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Pick[]) => items.find((i) => i.newLayer)) as never);
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    const input = vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('Marts' as never)
      .mockResolvedValueOnce('Revenue' as never);

    await vscode.commands.executeCommand('erdStudio.createDomain');

    expect(input).toHaveBeenCalledTimes(2);
    expect((input.mock.calls[1][0] as { prompt: string }).prompt).toBe('Name the diagram. It is saved in the Marts layer.');
    expect(layersFile().layers.map((l) => l.id)).toContain('marts');
    expect(fs.existsSync(path.join(project, '.erd-studio', 'marts', 'revenue.json'))).toBe(true);
    // Carried straight on: no "Layer added" toast offering the step it already took.
    expect(info.mock.calls.filter((c) => String(c[0]).startsWith('Layer "'))).toEqual([]);
  });
});

describe('New Layer', () => {
  it('asks one name: its folder follows from it, the label is the name, and the colour is one no layer uses', async () => {
    let validate: Validate | undefined;
    vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (o: { validateInput: Validate }) => {
      validate = o.validateInput;
      return 'sales mart';
    }) as never);
    const pick = vi.spyOn(vscode.window, 'showQuickPick');
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);

    const id = await vscode.commands.executeCommand('erdStudio.addLayer');

    expect(id).toBe('sales-mart');
    expect(pick).not.toHaveBeenCalled();
    const added = layersFile().layers.find((l) => l.id === 'sales-mart')!;
    expect(added).toMatchObject({ label: 'Sales mart', abbreviation: 'SAL', creatable: true });
    expect(layersFile().layers.filter((l) => l.color.toLowerCase() === added.color.toLowerCase())).toHaveLength(1);
    expect(fs.existsSync(path.join(project, '.erd-studio', 'sales-mart'))).toBe(true);
    expect(info).toHaveBeenCalledWith('Layer "Sales mart" added. Right-click it to rename or recolour it.', 'New Diagram in It…');

    expect(validate!('Gold')).toBe('There is already a layer "Gold"');
    expect(validate!('Templates')).toMatch(/reserved/);
    expect(validate!('9 lives')).toBe('Start the name with a letter');
    expect(validate!('Staging')).toEqual({ message: 'Its folder: .erd-studio/staging/', severity: vscode.InputBoxValidationSeverity.Info });
  });

  it('New Diagram in It… on the toast starts a diagram in the new layer', async () => {
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('Staging' as never)
      .mockResolvedValueOnce('Raw Orders' as never);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValueOnce('New Diagram in It…' as never);

    await vscode.commands.executeCommand('erdStudio.addLayer');
    await vi.waitFor(() => expect(fs.existsSync(path.join(project, '.erd-studio', 'staging', 'raw-orders.json'))).toBe(true));
  });
});

describe('Rename and Delete Diagram from the Command Palette', () => {
  it('ask which diagram (by layer) instead of stopping, and change nothing when cancelled', async () => {
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined as never);
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    const before = fs.readdirSync(path.join(project, '.erd-studio', 'gold')).sort();

    await vscode.commands.executeCommand('erdStudio.renameDomain');
    await vscode.commands.executeCommand('erdStudio.deleteDomain');

    expect(pick.mock.calls.map((c) => (c[1] as { placeHolder: string }).placeHolder)).toEqual(['Rename which diagram?', 'Delete which diagram?']);
    // Each diagram with its layer and tables, searchable by a table's name (matchOnDetail).
    const items = pick.mock.calls[0][0] as Array<{ label: string; description: string; detail?: string }>;
    const showcase = items.find((i) => i.label === 'showcase')!;
    expect(showcase.description).toMatch(/^Silver · \d+ tables$/);
    expect(showcase.detail).toContain('fct_order');
    expect((pick.mock.calls[0][1] as { matchOnDetail?: boolean }).matchOnDetail).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(project, '.erd-studio', 'gold')).sort()).toEqual(before);
  });
});
