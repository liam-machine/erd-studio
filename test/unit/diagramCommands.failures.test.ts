/**
 * The diagram and layer commands as `activate()` wires them, when they fail
 * (#229): real permission failures (chmod; the tests do not run as root, so
 * EACCES is genuine), over a temp copy of the fixture project. Each toast
 * says whose problem it is, has its buttons, and a button does what it says.
 * The words themselves are pinned in `diagramCommandErrors.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, _resetFirstRunGuardForTests } from '../../src/extension';
import { SelectorsService } from '../../src/services/selectorsService';
import { GETTING_STARTED_VIEW_TYPE } from '../../src/providers/GettingStartedPanel';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
/** chmod does not stop root: these tests need an ordinary user. */
const AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

type Context = import('vscode').ExtensionContext;

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
let error: ReturnType<typeof vi.spyOn>;
const readOnlyDirs: string[] = [];

function readOnly(dir: string): void { fs.chmodSync(dir, 0o555); readOnlyDirs.push(dir); }
function writable(dir: string): void { fs.chmodSync(dir, 0o755); }

/** Each error toast as its text and button labels. */
function toasts(): Array<{ message: string; buttons: string[] }> {
  return error.mock.calls.map((call: unknown[]) => ({ message: String(call[0]), buttons: call.slice(1).filter((a): a is string => typeof a === 'string') }));
}

/** Let a chosen button's action run (promise chains only; timers are fake). */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

async function openProject(dir: string): Promise<void> {
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(dir), name: path.basename(dir), index: 0 }];
  await activate(context);
}

function answer(layer: string, ...inputs: string[]): ReturnType<typeof vi.spyOn> {
  vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ value?: string }>) =>
    items.find((i) => i.value === layer) ?? items[0]) as never);
  return vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async () => inputs.shift()) as never);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-229-'));
  project = path.join(root, 'project');
  context = makeContext(root);
  vscode._resetRegisteredCommands();
  vscode._resetMockConfiguration();
  vscode._resetMockWorkspace();
  vscode._clearMockFileWatchers();
  vscode._resetMockGithubSession();
  vscode._resetMockLanguageModels();
  vscode.workspace.workspaceFolders = [];
  vscode.window.tabGroups.all = [];
  vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
  vscode._resetMockWebviewPanels();
  vscode._setMockExtensions([]);
  _resetFirstRunGuardForTests();
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const dir of readOnlyDirs.splice(0)) { try { writable(dir); } catch { /* gone */ } }
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

describe.skipIf(AS_ROOT)('New Diagram when it cannot write (#229)', () => {
  it('a read-only layer folder: plain words, Show Folder and Try Again; Try Again writes it without asking again', async () => {
    fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
    await openProject(project);
    const gold = path.join(project, '.erd-studio', 'gold');
    readOnly(gold);
    const input = answer('gold', 'orders', 'Orders');
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    error.mockImplementationOnce((async () => { writable(gold); return 'Try Again'; }) as never);

    await vscode.commands.executeCommand('erdStudio.createDomain');
    await settle();

    expect(toasts()).toEqual([{
      message: "New Diagram: ERD Studio isn't allowed to write to .erd-studio/gold/. Check the folder's permissions, then try again. Nothing was created.",
      buttons: ['Show Folder', 'Try Again'],
    }]);
    // Try Again: the file is written and opened, and the name and description were asked once.
    const created = path.join(gold, 'orders.json');
    expect(JSON.parse(fs.readFileSync(created, 'utf-8'))).toMatchObject({ description: 'Orders' });
    expect(input).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls.some((c) => c[0] === 'vscode.openWith' && (c[1] as vscode.Uri).fsPath === created)).toBe(true);
  });

  it('a read-only plain folder: names the project folder, Show Folder reveals it, and nothing is left behind', async () => {
    fs.mkdirSync(project);
    await openProject(project);
    readOnly(project);
    answer('gold', 'orders', '');
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    error.mockResolvedValueOnce('Show Folder' as never);

    await vscode.commands.executeCommand('erdStudio.createDomain');
    await settle();

    expect(toasts()[0]).toEqual({
      message: "New Diagram: ERD Studio isn't allowed to write to the project folder. Check the folder's permissions, then try again. Nothing was created.",
      buttons: ['Show Folder', 'Try Again'],
    });
    expect(fs.readdirSync(project)).toEqual([]);
    const reveal = exec.mock.calls.find((c) => c[0] === 'revealFileInOS');
    expect((reveal?.[1] as vscode.Uri).fsPath).toBe(project);
  });

  it("an unexpected failure is ERD Studio's: Send Feedback carries the error, redacted, and a layer folder it made is removed", async () => {
    fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
    await openProject(project);
    const gold = path.join(project, '.erd-studio', 'gold');
    fs.rmSync(gold, { recursive: true });
    // A name no file system takes (the name box would refuse it): Node throws, not the disk.
    answer('gold', 'orders\0', '');
    const real = vscode.commands.executeCommand;
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) =>
      (command === 'erdStudio.reportBug' ? undefined : real(command, ...args))) as never);
    error.mockResolvedValueOnce('Send Feedback' as never);

    await vscode.commands.executeCommand('erdStudio.createDomain');
    await settle();

    expect(toasts()[0]).toEqual({
      message: "New Diagram hit a problem in ERD Studio while writing the diagram file, so nothing was created. This isn't something you did. Please send us a report.",
      buttons: ['Send Feedback', 'Try Again'],
    });
    expect(fs.existsSync(gold)).toBe(false);
    const prefill = exec.mock.calls.find((c) => c[0] === 'erdStudio.reportBug')?.[1] as { title: string; description: string };
    expect(prefill.title).toBe('New Diagram failed');
    expect(prefill.description).toContain('null bytes');
    expect(prefill.description).not.toContain(root);
  });
});

describe('New Diagram: no layers, and a name taken since (#229)', () => {
  it('no creatable layers: Add Layer runs Add Layer', async () => {
    fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
    const layersPath = path.join(project, '.erd-studio', 'layers.json');
    const layers = JSON.parse(fs.readFileSync(layersPath, 'utf-8'));
    for (const layer of layers.layers) layer.creatable = false;
    fs.writeFileSync(layersPath, JSON.stringify(layers, null, 2));
    await openProject(project);
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    error.mockResolvedValueOnce('Add Layer' as never);

    await vscode.commands.executeCommand('erdStudio.createDomain');
    await settle();

    expect(toasts()[0]).toEqual({ message: 'No layers are configured for new diagrams. Add a layer first.', buttons: ['Add Layer'] });
    expect(exec).toHaveBeenCalledWith('erdStudio.addLayer');
  });

  it('a file of that name the sidebar did not list: Open It and Choose Another Name, the file untouched', async () => {
    fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
    await openProject(project);
    const taken = path.join(project, '.erd-studio', 'gold', 'orders.json');
    fs.writeFileSync(taken, 'not json');
    answer('gold', 'orders', '');
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    error.mockResolvedValueOnce('Open It' as never);

    await vscode.commands.executeCommand('erdStudio.createDomain');
    await settle();

    expect(toasts()[0]).toEqual({ message: 'A diagram named "orders" already exists in the Gold layer.', buttons: ['Open It', 'Choose Another Name'] });
    expect(fs.readFileSync(taken, 'utf-8')).toBe('not json');
    expect(exec.mock.calls.some((c) => c[0] === 'vscode.openWith' && (c[1] as vscode.Uri).fsPath === taken)).toBe(true);
  });
});

describe.skipIf(AS_ROOT)('Delete Diagram when it cannot delete (#229)', () => {
  const element = (file: string) => ({ type: 'domain', summary: { domain: 'finance', filePath: file, layer: 'gold' } });

  it('a read-only folder: Show File and Try Again, the file kept, nothing refreshed as if it went', async () => {
    fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
    await openProject(project);
    const gold = path.join(project, '.erd-studio', 'gold');
    const file = path.join(gold, 'finance.json');
    readOnly(gold);
    vi.spyOn(vscode.workspace.fs, 'delete').mockImplementation((async (uri: vscode.Uri) => { fs.rmSync(uri.fsPath); }) as never);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as never);
    const schedule = vi.spyOn(SelectorsService.prototype, 'scheduleRegenerate');
    let atToast: { kept: boolean; scheduled: number } | undefined;
    error.mockImplementationOnce((async () => {
      atToast = { kept: fs.existsSync(file), scheduled: schedule.mock.calls.length };
      writable(gold);
      return 'Try Again';
    }) as never);

    await vscode.commands.executeCommand('erdStudio.deleteDomain', element(file));
    await settle();

    expect(atToast).toEqual({ kept: true, scheduled: 0 });

    expect(toasts()).toEqual([{
      message: "\"finance\" couldn't be deleted: another program may have it open, or ERD Studio isn't allowed to change that folder. Nothing was deleted.",
      buttons: ['Show File', 'Try Again'],
    }]);
    // Try Again deletes it, without asking again.
    expect(fs.existsSync(file)).toBe(false);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('a file that is already gone is deleted: no error', async () => {
    fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
    await openProject(project);
    const file = path.join(project, '.erd-studio', 'gold', 'finance.json');
    vi.spyOn(vscode.workspace.fs, 'delete').mockImplementation((async () => {
      fs.rmSync(file, { force: true });
      throw Object.assign(new Error('EntryNotFound (FileSystemError)'), { code: 'FileNotFound' });
    }) as never);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as never);

    await vscode.commands.executeCommand('erdStudio.deleteDomain', element(file));

    expect(toasts()).toEqual([]);
  });
});

describe('Rename Diagram (#229)', () => {
  it('a file with the new name already there: says so before closing anything, and changes nothing', async () => {
    fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
    await openProject(project);
    const file = path.join(project, '.erd-studio', 'gold', 'finance.json');
    const taken = path.join(project, '.erd-studio', 'gold', 'sales.json');
    fs.writeFileSync(taken, 'not json');
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('sales' as never);
    const apply = vi.spyOn(vscode.workspace, 'applyEdit');

    await vscode.commands.executeCommand('erdStudio.renameDomain', { type: 'domain', summary: { domain: 'finance', filePath: file, layer: 'gold' } });

    expect(toasts()).toEqual([{ message: 'A diagram named "sales" already exists in the Gold layer.', buttons: ['Open It'] }]);
    expect(apply).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(true);
  });

  it('a diagram file with a JSON mistake: where it is, and Open File', async () => {
    fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
    await openProject(project);
    const file = path.join(project, '.erd-studio', 'gold', 'finance.json');
    fs.writeFileSync(file, '{\n  "schemaVersion": 5,\n}\n');
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('sales' as never);

    await vscode.commands.executeCommand('erdStudio.renameDomain', { type: 'domain', summary: { domain: 'finance', filePath: file, layer: 'gold' } });

    expect(toasts()).toEqual([{
      message: ".erd-studio/gold/finance.json can't be renamed because the diagram file has a problem: there is a mistake at line 2, column 21: " +
        'there is a comma after the last item, before a closing } or ].',
      buttons: ['Open File'],
    }]);
  });

  it('VS Code refusing the edit: Try Again and Send Feedback', async () => {
    fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
    await openProject(project);
    const file = path.join(project, '.erd-studio', 'gold', 'finance.json');
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('sales' as never);
    vi.spyOn(vscode.workspace, 'applyEdit').mockResolvedValue(false);

    await vscode.commands.executeCommand('erdStudio.renameDomain', { type: 'domain', summary: { domain: 'finance', filePath: file, layer: 'gold' } });

    expect(toasts()).toEqual([{
      message: "VS Code didn't accept renaming \"finance\" to \"sales\", usually because another program has the file open or ERD Studio isn't allowed to write to that folder. Nothing was changed.",
      buttons: ['Try Again', 'Send Feedback'],
    }]);
  });
});

describe('Rename Diagram: Try Again (#229)', () => {
  it('re-reads the file, so an edit saved after the refusal is kept, and asks nothing again', async () => {
    fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
    await openProject(project);
    const file = path.join(project, '.erd-studio', 'gold', 'finance.json');
    const input = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('sales' as never);
    const apply = vi.spyOn(vscode.workspace, 'applyEdit').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    error.mockImplementationOnce((async () => {
      const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
      fs.writeFileSync(file, JSON.stringify({ ...doc, description: 'Edited after the refusal' }, null, 2));
      return 'Try Again';
    }) as never);

    await vscode.commands.executeCommand('erdStudio.renameDomain', { type: 'domain', summary: { domain: 'finance', filePath: file, layer: 'gold' } });
    await settle();

    expect(apply).toHaveBeenCalledTimes(2);
    expect(input).toHaveBeenCalledTimes(1);
    const inserted = apply.mock.calls[1][0];
    expect(JSON.stringify(inserted)).toContain('Edited after the refusal');
  });
});

describe('the layer commands (#229)', () => {
  it('Edit Layer on a layer removed after it was picked: the sidebar was stale, not ERD Studio\'s problem', async () => {
    fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
    await openProject(project);
    const layersPath = path.join(project, '.erd-studio', 'layers.json');
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async () => {
      // Another window removes it while the edit menu is open.
      const layers = JSON.parse(fs.readFileSync(layersPath, 'utf-8'));
      layers.layers = layers.layers.filter((l: { id: string }) => l.id !== 'gold');
      fs.writeFileSync(layersPath, JSON.stringify(layers, null, 2));
      return { label: 'Abbreviation', value: 'abbreviation' };
    }) as never);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('GLX' as never);

    await vscode.commands.executeCommand('erdStudio.editLayer', { type: 'layer', layer: 'gold' });

    expect(toasts()).toEqual([{ message: 'The layer "gold" isn\'t in layers.json any more. The sidebar has been refreshed.', buttons: [] }]);
  });

  it('Edit Layer on a layer layers.json no longer has: says the sidebar was stale', async () => {
    fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
    await openProject(project);

    await vscode.commands.executeCommand('erdStudio.editLayer', { type: 'layer', layer: 'platinum' });

    expect(toasts()).toEqual([{ message: 'The layer "platinum" isn\'t in layers.json any more. The sidebar has been refreshed.', buttons: [] }]);
  });

  it('Edit Layer with a mistake in layers.json: says so, with Open File, not "isn\'t there"', async () => {
    fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
    fs.writeFileSync(path.join(project, '.erd-studio', 'layers.json'), '{ "layers": [ { "id": "platinum", } ] }');
    await openProject(project);

    await vscode.commands.executeCommand('erdStudio.editLayer', { type: 'layer', layer: 'platinum' });

    expect(toasts()).toEqual([{
      message: "Edit Layer: .erd-studio/layers.json has a mistake in it, so nothing was changed. Fix the file, then try again.",
      buttons: ['Open File'],
    }]);
  });

  it('Add Layer with a mistake in layers.json: Open File opens it', async () => {
    fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
    const layersPath = path.join(project, '.erd-studio', 'layers.json');
    fs.writeFileSync(layersPath, '{ "layers": [ }');
    await openProject(project);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('platinum' as never);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ value?: string }>) => items[0]) as never);
    const open = vi.spyOn(vscode.window, 'showTextDocument');
    error.mockResolvedValueOnce('Open File' as never);

    await vscode.commands.executeCommand('erdStudio.addLayer');
    await settle();

    expect(toasts()[0]).toEqual({
      message: "Add Layer: .erd-studio/layers.json has a mistake in it, so the layer wasn't added. Fix the file, then try again.",
      buttons: ['Open File'],
    });
    expect(fs.readFileSync(layersPath, 'utf-8')).toBe('{ "layers": [ }');
    expect(open).toHaveBeenCalled();
  });
});

describe('the Welcome tab with no folder open (#229)', () => {
  it("Open canvas says to open a folder, with Open Folder… and Open Settings", async () => {
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    await activate(context);
    await vscode.commands.executeCommand('erdStudio.showGettingStarted');
    const panel = vscode.window._webviewPanels.find((p) => p.viewType === GETTING_STARTED_VIEW_TYPE)!;

    await panel._simulateMessage({ type: 'openDomain' });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Open a folder first'), 'Open Folder…', 'Open Settings');
  });
});
