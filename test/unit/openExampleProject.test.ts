/**
 * Open an Example Project… (`erdStudio.openExampleProject`): pick an example,
 * pick a folder, every file written into a new `<folder>/<id>` all or
 * nothing, the pending record stored, then the folder opened (a new window
 * when one is open). An existing copy is offered as it is; any other folder
 * of that name stops it before a write; a failed write leaves nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';

import {
  CHOOSE_ANOTHER_FOLDER_BUTTON,
  OPEN_EXAMPLE_PROJECT_COMMAND,
  OPEN_EXAMPLE_PROJECT_PLACEHOLDER,
  OPEN_EXAMPLE_PROJECT_TITLE,
  OPEN_IT_BUTTON,
  openExampleProject,
  type ExampleQuickPickItem,
  type OpenExampleProjectDeps,
  type OpenExampleProjectUi,
} from '../../src/commands/openExampleProject';
import {
  EXAMPLE_PARENT_FOLDER_KEY,
  EXAMPLE_PROJECTS,
  PENDING_EXAMPLE_OPEN_KEY,
  exampleFiles,
  takePendingExample,
} from '../../src/services/exampleProjects';
import type { FileWriteIo } from '../../src/services/fsFileWrites';
import { telemetry } from '../../src/services/telemetryService';

let tmp: string;
let home: string;
let feature: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

const features = () => feature.mock.calls.map((c: unknown[]) => c[0]);
const errors = () => error.mock.calls.map((c: unknown[]) => c[0]);

function memento(seed: Record<string, unknown> = {}): OpenExampleProjectDeps['globalState'] & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(seed));
  return {
    data,
    get: (<T>(key: string, fallback?: T) => (data.has(key) ? data.get(key) : fallback)) as vscode.Memento['get'],
    update: async (key: string, value: unknown) => { data.set(key, value); },
  };
}

interface Fake extends OpenExampleProjectUi {
  picks: Array<{ items: ExampleQuickPickItem[]; options: vscode.QuickPickOptions }>;
  folderDialogs: Array<{ defaultFolder: string; exampleId: string }>;
  confirms: string[];
  errorMessages: Array<{ message: string; items: string[] }>;
  openedFolders: Array<{ folder: string; forceNewWindow: boolean }>;
  openedDiagrams: string[];
}

function fakeUi(answers: { example?: string; parent?: string; confirm?: boolean; open?: string[] } = {}): Fake {
  const ui: Fake = {
    picks: [], folderDialogs: [], confirms: [], errorMessages: [], openedFolders: [], openedDiagrams: [],
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[], options: vscode.QuickPickOptions) => {
      const rows = items as unknown as ExampleQuickPickItem[];
      ui.picks.push({ items: rows, options });
      return rows.find((i) => i.example.id === answers.example) as unknown as T | undefined;
    },
    pickParentFolder: async (defaultFolder, exampleId) => { ui.folderDialogs.push({ defaultFolder, exampleId }); return answers.parent; },
    confirm: async (message) => { ui.confirms.push(message); return answers.confirm ?? false; },
    showErrorMessage: async (message, ...items) => { ui.errorMessages.push({ message, items }); return undefined; },
    workspaceFolders: () => answers.open ?? [],
    openFolder: async (folder, forceNewWindow) => { ui.openedFolders.push({ folder, forceNewWindow }); },
    openDiagram: async (p) => { ui.openedDiagrams.push(p); },
  };
  return ui;
}

/** Every file under `dir`, relative, posix. */
function filesUnder(dir: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? filesUnder(dir, p) : [p];
  });
}

const NOW = 1_800_000_000_000;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-example-project-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  feature = vi.spyOn(telemetry, 'feature');
  error = vi.spyOn(telemetry, 'error');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Open an Example Project…', () => {
  it('is erdStudio.openExampleProject', () => {
    expect(OPEN_EXAMPLE_PROJECT_COMMAND).toBe('erdStudio.openExampleProject');
  });

  it('lists every example in catalog order, under its title and placeholder', async () => {
    const ui = fakeUi();
    await openExampleProject({ globalState: memento(), ui, homeDir: home });
    expect(ui.picks).toHaveLength(1);
    const [{ items, options }] = ui.picks;
    expect(items.map((i) => i.example.id)).toEqual(EXAMPLE_PROJECTS.map((e) => e.id));
    expect(items[0]).toMatchObject({ label: EXAMPLE_PROJECTS[0].label, description: EXAMPLE_PROJECTS[0].description, detail: EXAMPLE_PROJECTS[0].detail });
    expect(options).toMatchObject({ title: OPEN_EXAMPLE_PROJECT_TITLE, placeHolder: OPEN_EXAMPLE_PROJECT_PLACEHOLDER });
  });

  it('cancelled at the picker: counts exampleCancelled, asks nothing more, writes nothing', async () => {
    const ui = fakeUi();
    const state = memento();
    expect(await openExampleProject({ globalState: state, ui, homeDir: home })).toBeUndefined();
    expect(features()).toEqual(['exampleCancelled']);
    expect(ui.folderDialogs).toEqual([]);
    expect(state.data.size).toBe(0);
  });

  it('cancelled at the folder dialog: counts exampleCancelled, writes nothing; the dialog starts at home', async () => {
    const ui = fakeUi({ example: 'medallion' });
    const state = memento();
    expect(await openExampleProject({ globalState: state, ui, homeDir: home })).toBeUndefined();
    expect(features()).toEqual(['exampleCancelled']);
    expect(ui.folderDialogs).toEqual([{ defaultFolder: home, exampleId: 'medallion' }]);
    expect(fs.readdirSync(home)).toEqual([]);
    expect(ui.openedFolders).toEqual([]);
    expect(state.data.size).toBe(0);
  });

  it('the folder dialog starts where the last example was saved, while that folder exists', async () => {
    const last = path.join(tmp, 'last');
    fs.mkdirSync(last);
    const ui = fakeUi({ example: 'medallion' });
    await openExampleProject({ globalState: memento({ [EXAMPLE_PARENT_FOLDER_KEY]: last }), ui, homeDir: home });
    await openExampleProject({ globalState: memento({ [EXAMPLE_PARENT_FOLDER_KEY]: path.join(tmp, 'gone') }), ui, homeDir: home });
    expect(ui.folderDialogs.map((d) => d.defaultFolder)).toEqual([last, home]);
  });

  it.each([
    ['an empty window: opens it here', [] as string[], false],
    ['a folder already open: opens a new window', ['/somewhere/else'], true],
  ])('writes every file into <folder>/<id>, then %s', async (_name, open, forceNewWindow) => {
    const ui = fakeUi({ example: 'enterprise-warehouse', parent: home, open });
    const state = memento();
    const result = await openExampleProject({ globalState: state, ui, homeDir: home, now: () => NOW });

    const folder = path.join(home, 'enterprise-warehouse');
    const files = exampleFiles('enterprise-warehouse');
    expect(filesUnder(folder).sort()).toEqual(Object.keys(files).sort());
    for (const [rel, text] of Object.entries(files)) expect(fs.readFileSync(path.join(folder, ...rel.split('/')), 'utf-8')).toBe(text);
    expect(fs.existsSync(path.join(folder, '.github', 'CODEOWNERS'))).toBe(true);

    expect(result).toEqual({ folder, diagram: '.erd-studio/landing/diagrams/source-systems.dbml', outcome: 'written' });
    expect(ui.openedFolders).toEqual([{ folder, forceNewWindow }]);
    expect(features()).toEqual(['exampleOpened', 'exampleEnterpriseWarehouse']);
    expect(errors()).toEqual([]);
    expect(state.data.get(EXAMPLE_PARENT_FOLDER_KEY)).toBe(home);
    const pending = state.data.get(PENDING_EXAMPLE_OPEN_KEY);
    expect(pending).toEqual({ folder, diagram: '.erd-studio/landing/diagrams/source-systems.dbml', at: NOW });
    // The new window's activation finds it.
    expect(takePendingExample(pending, folder, NOW + 2_000)).toBe(path.join(folder, '.erd-studio', 'landing', 'diagrams', 'source-systems.dbml'));
  });

  it('a copy already there: Open It opens it as it is, nothing overwritten', async () => {
    const folder = path.join(home, 'medallion');
    fs.mkdirSync(path.join(folder, '.erd-studio'), { recursive: true });
    fs.writeFileSync(path.join(folder, '.erd-studio', 'layers.json'), '{"mine":true}');
    const ui = fakeUi({ example: 'medallion', parent: home, confirm: true, open: ['/other'] });
    const state = memento();
    const result = await openExampleProject({ globalState: state, ui, homeDir: home, now: () => NOW });

    expect(ui.confirms).toEqual([`medallion is already in ${home}. Open that copy?`]);
    expect(fs.readFileSync(path.join(folder, '.erd-studio', 'layers.json'), 'utf-8')).toBe('{"mine":true}');
    expect(filesUnder(folder)).toEqual(['.erd-studio/layers.json']);
    expect(result?.outcome).toBe('reopened');
    expect(ui.openedFolders).toEqual([{ folder, forceNewWindow: true }]);
    expect(features()).toEqual(['exampleReopened']);
    expect(state.data.get(PENDING_EXAMPLE_OPEN_KEY)).toEqual({ folder, diagram: '.erd-studio/gold/diagrams/sales.dbml', at: NOW });
  });

  it('a copy already there, Open It declined: counts exampleCancelled, opens nothing', async () => {
    fs.mkdirSync(path.join(home, 'medallion', '.erd-studio'), { recursive: true });
    const ui = fakeUi({ example: 'medallion', parent: home, confirm: false });
    const state = memento();
    expect(await openExampleProject({ globalState: state, ui, homeDir: home })).toBeUndefined();
    expect(features()).toEqual(['exampleCancelled']);
    expect(ui.openedFolders).toEqual([]);
    expect(state.data.has(PENDING_EXAMPLE_OPEN_KEY)).toBe(false);
  });

  it('the copy is the folder this window has open: its first diagram opens here', async () => {
    const folder = path.join(home, 'medallion');
    fs.mkdirSync(path.join(folder, '.erd-studio'), { recursive: true });
    const ui = fakeUi({ example: 'medallion', parent: home, confirm: true, open: [folder] });
    const state = memento();
    await openExampleProject({ globalState: state, ui, homeDir: home });
    expect(ui.openedFolders).toEqual([]);
    expect(ui.openedDiagrams).toEqual([path.join(folder, '.erd-studio', 'gold', 'diagrams', 'sales.dbml')]);
    expect(state.data.has(PENDING_EXAMPLE_OPEN_KEY)).toBe(false);
    expect(features()).toEqual(['exampleReopened', 'exampleDiagramShown']);
  });

  it('another folder of that name: refuses, writes nothing, offers Choose Another Folder', async () => {
    const folder = path.join(home, 'data-vault');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'mine');
    const ui = fakeUi({ example: 'data-vault', parent: home });
    const state = memento();
    expect(await openExampleProject({ globalState: state, ui, homeDir: home })).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));

    expect(filesUnder(folder)).toEqual(['notes.txt']);
    expect(ui.confirms).toEqual([]);
    expect(ui.errorMessages).toHaveLength(1);
    expect(ui.errorMessages[0].message).toContain(`a folder named data-vault is already in ${home}`);
    expect(ui.errorMessages[0].message).toContain('Nothing was written');
    expect(ui.errorMessages[0].items).toEqual([CHOOSE_ANOTHER_FOLDER_BUTTON]);
    expect(ui.openedFolders).toEqual([]);
    expect(state.data.size).toBe(0);
    expect(features()).toEqual([]);
  });

  it('a file of that name: refuses the same way', async () => {
    fs.writeFileSync(path.join(home, 'data-vault'), 'a file');
    const ui = fakeUi({ example: 'data-vault', parent: home });
    expect(await openExampleProject({ globalState: memento(), ui, homeDir: home })).toBeUndefined();
    expect(fs.readFileSync(path.join(home, 'data-vault'), 'utf-8')).toBe('a file');
    expect(ui.errorMessages).toHaveLength(1);
  });

  it('Choose Another Folder asks for a folder again, for the same example', async () => {
    fs.mkdirSync(path.join(home, 'data-vault'));
    const other = path.join(tmp, 'other');
    fs.mkdirSync(other);
    const ui = fakeUi({ example: 'data-vault', parent: home });
    ui.showErrorMessage = async (message, ...items) => {
      ui.errorMessages.push({ message, items });
      // Answer the second dialog with a free folder.
      ui.pickParentFolder = async (defaultFolder, exampleId) => { ui.folderDialogs.push({ defaultFolder, exampleId }); return other; };
      return CHOOSE_ANOTHER_FOLDER_BUTTON;
    };
    await openExampleProject({ globalState: memento(), ui, homeDir: home });
    await vi.waitFor(() => expect(ui.openedFolders).toHaveLength(1));
    expect(ui.picks).toHaveLength(1);
    expect(ui.folderDialogs.map((d) => d.exampleId)).toEqual(['data-vault', 'data-vault']);
    expect(ui.openedFolders[0].folder).toBe(path.join(other, 'data-vault'));
    expect(fs.existsSync(path.join(other, 'data-vault', '.erd-studio', 'layers.json'))).toBe(true);
  });

  it('a write that fails: counts exampleWriteFailed, leaves nothing behind, opens nothing', async () => {
    let writes = 0;
    const io: FileWriteIo = {
      readFile: (p) => fs.readFileSync(p),
      writeFile: (p, data) => {
        if (++writes === 5) throw new Error('disk full');
        fs.writeFileSync(p, data);
      },
      rename: (from, to) => fs.renameSync(from, to),
      unlink: (p) => fs.unlinkSync(p),
      exists: (p) => fs.existsSync(p),
      mkdir: (p) => fs.mkdirSync(p),
      rmdir: (p) => fs.rmdirSync(p),
    };
    const ui = fakeUi({ example: 'kimball-bus-matrix', parent: home });
    const state = memento();
    expect(await openExampleProject({ globalState: state, ui, homeDir: home, io })).toBeUndefined();

    expect(errors()).toEqual(['exampleWriteFailed']);
    expect(features()).toEqual([]);
    expect(fs.readdirSync(home)).toEqual([]);
    expect(ui.errorMessages).toHaveLength(1);
    expect(ui.errorMessages[0].message).toContain(`couldn't save kimball-bus-matrix in ${home}`);
    expect(ui.errorMessages[0].message).toContain('Nothing was left behind.');
    expect(ui.openedFolders).toEqual([]);
    expect(state.data.size).toBe(0);
  });
});
