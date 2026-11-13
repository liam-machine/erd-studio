/**
 * The canvas's information button about converting a project from before 2.0
 * to DBML (#305): the host tells each logical canvas whether to show it
 * (`convertOffer`) after every load and again when the answer changes, by the
 * Convert offer's own checks and never its once-a-session flag; the button's
 * `convertProjectToDbml` runs the same hook as the offer's Convert….
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  DBML_CONVERSION_DECLINED_KEY,
  DBML_CONVERSION_OFFER_TITLE,
  SemanticEditorProvider,
} from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { countDbmlConversionCandidates } from '../../src/services/dbmlConversionFiles';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { telemetry } from '../../src/services/telemetryService';
import type { DbmlConversionCandidates } from '../../src/services/dbmlConversionFiles';

const CORE_FIXTURES = path.resolve(__dirname, '../../packages/core/test/fixtures');

type MockPanel = ReturnType<typeof vscode.createMockWebviewPanel>;
type Posted = { type: string; payload?: any };
const posted = (panel: MockPanel) => panel._postedMessages as Posted[];
/** Every `convertOffer` answer the canvas got, in order. */
const answers = (panel: MockPanel) => posted(panel).filter((m) => m.type === 'convertOffer').map((m) => m.payload.show as boolean);

let root: string;
let erd: string;
let configListeners: Array<(e: vscode.ConfigurationChangeEvent) => void>;
const fireConfigChange = (key: string) => {
  const e = { affectsConfiguration: (section: string) => key === section || key.startsWith(`${section}.`) } as vscode.ConfigurationChangeEvent;
  for (const l of [...configListeners]) l(e);
};

/** Wait until the posted messages have settled (the answer is posted off the paint's path). */
const settle = () => new Promise((r) => setTimeout(r, 60));

function useFixture(name: string): void {
  fs.cpSync(path.join(CORE_FIXTURES, name, '.erd-studio'), erd, { recursive: true });
}

function makeProvider(state: Map<string, unknown>, options: { wire?: boolean; candidates?: () => DbmlConversionCandidates; run?: () => Promise<boolean>; goesNowhere?: () => boolean } = {}) {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const selectorsService = new SelectorsService(subjectAreaService, root, '.erd-studio');
  vi.spyOn(selectorsService, 'scheduleRegenerate').mockImplementation(() => undefined);
  const context = {
    extensionUri: vscode.Uri.file(root),
    globalState: { get: () => true, update: async () => {} },
    workspaceState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v); } },
    secrets: vscode.createMockSecretStorage(),
  } as unknown as vscode.ExtensionContext;
  const provider = new SemanticEditorProvider(
    context, subjectAreaService, new ManifestService(), new YmlParserService(), new TemplateService(),
    layerService, root, selectorsService, tableLibraryService,
  );
  const run = vi.fn(options.run ?? (async () => true));
  const candidates = vi.fn(options.candidates ?? (() => countDbmlConversionCandidates(root, '.erd-studio')));
  if (options.wire !== false) provider.setDbmlConversion(candidates, run, options.goesNowhere);
  const open = async (relative: string): Promise<MockPanel> => {
    const file = path.join(erd, relative);
    const doc = vscode.createMockTextDocument(file, fs.readFileSync(file, 'utf-8'), { persist: true });
    const panel = vscode.createMockWebviewPanel();
    await provider.resolveCustomTextEditor(doc as never, panel as never, {} as vscode.CancellationToken);
    await panel._simulateMessage({ type: 'ready' });
    await settle();
    return panel;
  };
  return { provider, open, run, candidates };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-convert-info-'));
  erd = path.join(root, '.erd-studio');
  vscode._resetMockWorkspace();
  vscode._resetMockWebviewPanels();
  vscode._resetMockConfiguration();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  configListeners = [];
  vi.spyOn(vscode.workspace, 'onDidChangeConfiguration').mockImplementation(((listener: (e: vscode.ConfigurationChangeEvent) => void) => {
    configListeners.push(listener);
    return { dispose: () => { configListeners = configListeners.filter((l) => l !== listener); } };
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vscode._resetMockConfiguration();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the host tells the canvas whether to show the Convert information button', () => {
  it('a YAML project: shown after the diagram, and still shown after the once-a-session offer was answered Not Now', async () => {
    useFixture('composite-and-self');
    // Not Now (VS Code's Cancel, Escape or closing the dialog).
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const { open } = makeProvider(new Map());
    const first = await open('gold/vault.json');
    expect(info.mock.calls.filter((c) => c[0] === DBML_CONVERSION_OFFER_TITLE)).toHaveLength(1);
    const types = posted(first).map((m) => m.type);
    expect(types.indexOf('convertOffer')).toBeGreaterThan(types.indexOf('domainLoaded'));
    expect(answers(first)).toEqual([true]);

    // The next canvas this session: no second offer, but the button is still there.
    info.mockClear();
    const second = await open('gold/vault.json');
    expect(info.mock.calls.filter((c) => c[0] === DBML_CONVERSION_OFFER_TITLE)).toEqual([]);
    expect(answers(second)).toEqual([true]);
  });

  it('a DBML project, a project declined with Don\'t Ask Again, or one with nothing to convert: not shown', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    useFixture('dbml/composite-and-self');
    expect(answers(await makeProvider(new Map()).open('gold/diagrams/vault.dbml'))).toEqual([false]);

    fs.rmSync(erd, { recursive: true, force: true });
    useFixture('composite-and-self');
    expect(answers(await makeProvider(new Map([[DBML_CONVERSION_DECLINED_KEY, true]])).open('gold/vault.json'))).toEqual([false]);
    expect(answers(await makeProvider(new Map(), { candidates: () => ({ files: 0, tablesDirIsLayer: false }) }).open('gold/vault.json'))).toEqual([false]);
    expect(answers(await makeProvider(new Map(), { candidates: () => ({ files: 3, tablesDirIsLayer: true }) }).open('gold/vault.json'))).toEqual([false]);
    // A run that was refused, nothing changed since: its button would only lead to the same refusal.
    expect(answers(await makeProvider(new Map(), { goesNowhere: () => true }).open('gold/vault.json'))).toEqual([false]);
  });

  it('Convert not wired: no answer at all (the canvas shows no button)', async () => {
    useFixture('composite-and-self');
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    expect(answers(await makeProvider(new Map(), { wire: false }).open('gold/vault.json'))).toEqual([]);
  });

  it('erdStudio.dbml.offerConvert turned off, then on: every open canvas follows', async () => {
    useFixture('composite-and-self');
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const { open } = makeProvider(new Map());
    const panel = await open('gold/vault.json');
    expect(answers(panel)).toEqual([true]);

    vscode._setMockConfiguration('erdStudio', 'dbml.offerConvert', { globalValue: false });
    fireConfigChange('erdStudio.dbml.offerConvert');
    await settle();
    expect(answers(panel)).toEqual([true, false]);

    vscode._setMockConfiguration('erdStudio', 'dbml.offerConvert', { globalValue: true });
    fireConfigChange('erdStudio.dbml.offerConvert');
    await settle();
    expect(answers(panel)).toEqual([true, false, true]);

    // Another setting changing posts nothing.
    fireConfigChange('erdStudio.canvas.lineStyle');
    await settle();
    expect(answers(panel)).toEqual([true, false, true]);
  });

  it('Don\'t Ask Again on the offer takes the button away', async () => {
    useFixture('composite-and-self');
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue("Don't Ask Again" as never);
    const state = new Map<string, unknown>();
    const panel = await makeProvider(state).open('gold/vault.json');
    expect(state.get(DBML_CONVERSION_DECLINED_KEY)).toBe(true);
    expect(answers(panel).at(-1)).toBe(false);
  });
});

describe('the button\'s Convert to DBML… (convertProjectToDbml)', () => {
  it('runs the same hook as the offer\'s Convert…, counts it, and every canvas follows the outcome', async () => {
    useFixture('composite-and-self');
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const feature = vi.spyOn(telemetry, 'feature');
    let converted = false;
    const { open, run } = makeProvider(new Map(), {
      candidates: () => ({ files: converted ? 0 : 4, tablesDirIsLayer: false }),
      run: async () => { converted = true; return true; },
    });
    // A second diagram of the project, open in its own canvas.
    const vault = JSON.parse(fs.readFileSync(path.join(erd, 'gold', 'vault.json'), 'utf-8')) as { domain: string };
    fs.writeFileSync(path.join(erd, 'gold', 'vault-copy.json'), JSON.stringify({ ...vault, domain: 'vault-copy' }, null, 2));
    const panel = await open('gold/vault.json');
    const other = await open('gold/vault-copy.json');
    expect(answers(panel)).toEqual([true]);
    expect(answers(other)).toEqual([true]);

    await panel._simulateMessage({ type: 'convertProjectToDbml' });
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(feature).toHaveBeenCalledWith('convertToDbmlFromCanvasInfo');
    expect(answers(panel).at(-1)).toBe(false);
    expect(answers(other).at(-1)).toBe(false);
  });

  it('a payload is refused: nothing runs', async () => {
    useFixture('composite-and-self');
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const { open, run } = makeProvider(new Map());
    const panel = await open('gold/vault.json');
    await panel._simulateMessage({ type: 'convertProjectToDbml', payload: { path: '/etc' } });
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(posted(panel).filter((m) => m.type === 'error').map((m) => m.payload.message)).toContain('Converting the project to DBML takes no payload.');
  });
});
