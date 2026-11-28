/**
 * Reproducer: ERD Studio only changes a project file as a direct result of
 * something the user did in it. Opening a window or a diagram never writes.
 *
 * Every test states the RULE. On origin/develop (242f93f5) the S1 / S2 cases
 * (selectors.yml) and the P1 ones (positions: a partly placed diagram, and a
 * fresh one's first-open layout) failed, proving the unprompted write; the
 * rest are guards that passed then and must keep passing.
 *
 * Runs the real activate() on temp copies of test/fixtures/dbt-project and
 * its DBML twin.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { _appliedEdits } from '../__mocks__/vscode';
import { activate, _resetFirstRunGuardForTests } from '../../src/extension';
import type { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));

type Storage = 'yaml' | 'dbml';
type Posted = { type: string; payload?: any; autoLayout?: boolean };
type Panel = ReturnType<typeof vscode.createMockWebviewPanel>;

const SHOWCASE: Record<Storage, string> = { yaml: 'silver/showcase.json', dbml: 'silver/diagrams/showcase.dbml' };
/** Longer than SelectorsService's 250 ms debounce. */
const PAST_DEBOUNCE_MS = 600;
const settle = () => new Promise((r) => setTimeout(r, PAST_DEBOUNCE_MS));

function makeContext(root: string): vscode.ExtensionContext {
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
  } as unknown as vscode.ExtensionContext;
}

/** sha1 of every file under root, minus the test's own global storage. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      if (rel === '.global-storage') continue;
      if (e.isDirectory()) walk(abs);
      else out.set(rel, crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex'));
    }
  };
  walk(root);
  return out;
}

function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((k) => before.get(k) !== after.get(k)).sort();
}

const posted = (panel: Panel): Posted[] => panel._postedMessages as Posted[];

async function waitFor(panel: Panel, type: string): Promise<Posted> {
  await vi.waitFor(() => expect(posted(panel).some((m) => m.type === type)).toBe(true), { timeout: 8000, interval: 10 });
  return posted(panel).filter((m) => m.type === type).at(-1)!;
}

describe.each([
  ['yaml', 'dbt-project'],
  ['dbml', 'dbt-project-dbml'],
] as Array<[Storage, string]>)('no unprompted writes on %s storage (%s)', (storage, fixture) => {
  let ws: string;
  let context: vscode.ExtensionContext;
  let provider: SemanticEditorProvider;
  let statusItems: Array<{ text: string; command?: unknown; shown: boolean }>;
  const selectorsPath = () => path.join(ws, 'selectors.yml');
  const showcasePath = () => path.join(ws, '.erd-studio', ...SHOWCASE[storage].split('/'));

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), `erd-quiet-${fixture}-`));
    fs.cpSync(path.join(FIXTURES, fixture), ws, { recursive: true, preserveTimestamps: true });
    vscode._resetRegisteredCommands();
    vscode._resetMockConfiguration();
    vscode._resetMockWorkspace();
    vscode._clearMockFileWatchers();
    vscode._resetMockWebviewPanels();
    _resetFirstRunGuardForTests();
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws), name: path.basename(ws), index: 0 }];
    vi.stubEnv('HOME', ws);
    vi.stubEnv('USERPROFILE', ws);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    statusItems = [];
    vi.spyOn(vscode.window, 'createStatusBarItem').mockImplementation((() => {
      const item = { text: '', tooltip: undefined, command: undefined as unknown, backgroundColor: undefined, shown: false,
        show() { item.shown = true; }, hide() { item.shown = false; }, dispose() {} };
      statusItems.push(item);
      return item;
    }) as never);
  });

  afterEach(async () => {
    for (const sub of [...(context?.subscriptions ?? [])].reverse()) {
      try { await (sub as { dispose(): unknown }).dispose(); } catch { /* best effort */ }
    }
    for (const panel of [...vscode.window._webviewPanels]) panel.dispose();
    vscode._resetMockWebviewPanels();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  async function start(): Promise<void> {
    context = makeContext(ws);
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    await activate(context);
    provider = registerEditor.mock.calls[0][1] as unknown as SemanticEditorProvider;
  }

  /** Saves of the diagram's document, counted from its open. */
  let saves = 0;

  async function openShowcase(): Promise<Panel> {
    const file = showcasePath();
    const document = vscode.createMockTextDocument(file, fs.readFileSync(file, 'utf-8'), { persist: true });
    const save = document.save.bind(document);
    saves = 0;
    document.save = async () => { saves++; return save(); };
    (vscode.workspace.textDocuments as unknown[]).push(document);
    const panel = vscode.createMockWebviewPanel();
    await provider.resolveCustomTextEditor(document as never, panel as never, {} as vscode.CancellationToken);
    await panel._simulateMessage({ type: 'ready' });
    await waitFor(panel, 'domainLoaded');
    return panel;
  }

  /** Drop dim_date's stored position (the table keeps its place in the diagram). */
  function forgetDimDatePosition(): void {
    const file = showcasePath();
    const text = fs.readFileSync(file, 'utf-8');
    if (storage === 'yaml') {
      const json = JSON.parse(text);
      delete json.viewConfig.positions.dim_date;
      fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
    } else {
      fs.writeFileSync(file, text.replace('    dim_date 40 520\n', ''));
    }
  }

  function forgetAllPositions(): void {
    const file = showcasePath();
    const text = fs.readFileSync(file, 'utf-8');
    if (storage === 'yaml') {
      const json = JSON.parse(text);
      json.viewConfig.positions = {};
      fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
    } else {
      fs.writeFileSync(file, text.replace(/ {2}erd_layout: '''\n[\s\S]*?\n {2}'''\n/, ''));
    }
  }

  // ---- S1: activation -------------------------------------------------------

  it('S1 activation never creates selectors.yml when the project has none', async () => {
    fs.rmSync(selectorsPath());
    await start();
    await settle();
    expect(fs.existsSync(selectorsPath())).toBe(false);
  });

  it('S1 activation never rewrites a stale selectors.yml', async () => {
    const stale = fs.readFileSync(selectorsPath(), 'utf-8').replace('domain_silver_showcase', 'domain_silver_old');
    fs.writeFileSync(selectorsPath(), stale);
    await start();
    await settle();
    expect(fs.readFileSync(selectorsPath(), 'utf-8')).toBe(stale);
  });

  it('S1 a stale selectors.yml at activation shows the "out of sync" status item that runs Regenerate', async () => {
    fs.writeFileSync(selectorsPath(), fs.readFileSync(selectorsPath(), 'utf-8').replace('domain_silver_showcase', 'domain_silver_old'));
    await start();
    await settle();
    const item = statusItems.find((i) => i.text.includes('selectors.yml out of sync'));
    expect(item?.shown).toBe(true);
    expect(item?.command).toBe('erdStudio.syncDomainTags');
  });

  it('guard: an up-to-date selectors.yml at activation is untouched and shows no status item', async () => {
    const before = fs.readFileSync(selectorsPath(), 'utf-8');
    await start();
    await settle();
    expect(fs.readFileSync(selectorsPath(), 'utf-8')).toBe(before);
    expect(statusItems.some((i) => i.shown && i.text.includes('selectors.yml'))).toBe(false);
  });

  // ---- S2 / S3: edits and the command ---------------------------------------

  it('S2 adding a table does not create selectors.yml when the project has none', async () => {
    await start();
    await settle();
    // Remove it after activation, so only the edit can (re)create it.
    fs.rmSync(selectorsPath(), { force: true });
    const panel = await openShowcase();
    await panel._simulateMessage({ type: 'addExistingModel', payload: { modelName: 'fct_sale' } });
    await settle();
    expect(fs.readFileSync(showcasePath(), 'utf-8')).toMatch(/fct_sale/);
    expect(fs.existsSync(selectorsPath())).toBe(false);
  });

  it('boundary: adding a table still rebuilds an existing selectors.yml', async () => {
    await start();
    await settle();
    const panel = await openShowcase();
    expect(fs.readFileSync(selectorsPath(), 'utf-8')).not.toMatch(/value: fct_sale/);
    await panel._simulateMessage({ type: 'addExistingModel', payload: { modelName: 'fct_sale' } });
    await settle();
    expect(fs.readFileSync(selectorsPath(), 'utf-8')).toMatch(/value: fct_sale/);
  });

  it('S3 Regenerate dbt selectors.yml creates the file when there is none', async () => {
    fs.rmSync(selectorsPath());
    await start();
    await settle();
    fs.rmSync(selectorsPath(), { force: true });
    await vscode.commands.executeCommand('erdStudio.syncDomainTags');
    expect(fs.readFileSync(selectorsPath(), 'utf-8')).toMatch(/domain_silver_showcase/);
  });

  // ---- P1: opening a diagram ------------------------------------------------

  it('P1 opening a diagram with a table that has no saved position writes nothing', async () => {
    forgetDimDatePosition();
    await start();
    await settle();
    const before = fs.readFileSync(showcasePath(), 'utf-8');
    const panel = await openShowcase();
    await settle();
    // The canvas still draws dim_date somewhere...
    const loaded = posted(panel).find((m) => m.type === 'domainLoaded')!;
    expect(loaded.payload.viewConfig.positions.dim_date).toBeDefined();
    // ...but the diagram file is not touched.
    expect(fs.readFileSync(showcasePath(), 'utf-8')).toBe(before);
  });

  it('P1 a fresh diagram (no positions): opening, the webview\'s unsaved first-open layout and layoutFinished write nothing', async () => {
    forgetAllPositions();
    await start();
    await settle();
    const before = snapshot(ws);
    const panel = await openShowcase();
    const loaded = posted(panel).find((m) => m.type === 'domainLoaded')!;
    expect(loaded.autoLayout).toBe(true);
    expect(loaded).not.toHaveProperty('saveLayout');
    // What the webview's first-open ELK run sends back (Toolbar.runLayout(true, false), pinned by
    // firstOpenAutoLayout.test.tsx): every table, marked unsaved, then its timing.
    const elk = Object.fromEntries(Object.keys(loaded.payload.viewConfig.positions).map((n, i) => [n, { x: i * 300, y: 0 }]));
    const editsAtOpen = _appliedEdits.length;
    await panel._simulateMessage({ type: 'updatePositions', payload: { positions: elk, unsaved: true } });
    await panel._simulateMessage({ type: 'layoutFinished', payload: { ms: 80, ok: true, firstOpen: true } });
    await settle();
    expect(_appliedEdits.length).toBe(editsAtOpen);
    expect(saves).toBe(0);
    expect(changed(before, snapshot(ws))).toEqual([]);
    // Still a position for every table on the canvas, and a refresh draws the layout it holds.
    const models = (loaded.payload.models as Array<{ name: string }>).map((m) => m.name);
    for (const name of models) expect(loaded.payload.viewConfig.positions[name]).toBeDefined();
    await provider.refreshAllOpenSubjectAreas();
    const redrawn = posted(panel).filter((m) => m.type === 'domainLoaded').at(-1)!;
    expect(redrawn).not.toHaveProperty('autoLayout');
    expect(redrawn.payload.viewConfig.positions).toEqual(elk);
    expect(changed(before, snapshot(ws))).toEqual([]);
  });

  it('boundary: the first drag of that fresh diagram saves the layout the user saw', async () => {
    forgetAllPositions();
    await start();
    await settle();
    const panel = await openShowcase();
    const loaded = posted(panel).find((m) => m.type === 'domainLoaded')!;
    const elk = Object.fromEntries(Object.keys(loaded.payload.viewConfig.positions).map((n, i) => [n, { x: i * 300, y: 0 }]));
    await panel._simulateMessage({ type: 'updatePositions', payload: { positions: elk, unsaved: true } });
    const before = fs.readFileSync(showcasePath(), 'utf-8');
    await panel._simulateMessage({ type: 'updatePositions', payload: { positions: { dim_date: { x: 5, y: 5 } } } });
    await settle();
    const after = fs.readFileSync(showcasePath(), 'utf-8');
    expect(after).not.toBe(before);
    for (const [name, p] of Object.entries({ ...elk, dim_date: { x: 5, y: 5 } })) {
      expect(after).toMatch(storage === 'yaml'
        ? new RegExp(`"${name}": \\{\\s*"x": ${p.x},\\s*"y": ${p.y}\\s*\\}`)
        : new RegExp(`\\n {4}${name} ${p.x} ${p.y}\\n`));
    }
  });

  // ---- The whole picture ----------------------------------------------------

  it('guard: on the clean fixture, activation plus opening showcase changes no file', async () => {
    const before = snapshot(ws);
    await start();
    await settle();
    await openShowcase();
    await settle();
    expect(changed(before, snapshot(ws))).toEqual([]);
  });

  it('opening the window with selectors.yml gone and a table unplaced changes no file', async () => {
    fs.rmSync(selectorsPath());
    forgetDimDatePosition();
    const before = snapshot(ws);
    await start();
    await settle();
    await openShowcase();
    await settle();
    expect(changed(before, snapshot(ws))).toEqual([]);
  });
});
