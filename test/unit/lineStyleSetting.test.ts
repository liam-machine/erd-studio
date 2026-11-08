/**
 * The `erdStudio.canvas.lineStyle` setting (`src/providers/lineStyleSetting.ts`)
 * and its two canvas messages: the host tells every canvas the style with
 * `lineStyle` (on `ready` and whenever the setting changes), and the toolbar's
 * `setLineStyle` writes it at user scope. A view preference: it writes no
 * project file and works on the physical stage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { SemanticEditorProvider, PHYSICAL_READ_ONLY_MESSAGE } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { readLineStyle, writeLineStyle } from '../../src/providers/lineStyleSetting';
import { validateSetLineStylePayload } from '../../src/providers/payloadValidation';
import {
  CANVAS_LINE_STYLES,
  DEFAULT_CANVAS_LINE_STYLE,
  LINE_STYLE_SETTING,
  isCanvasLineStyle,
} from '../../src/types/lineStyle';
import { LINE_STYLES, DEFAULT_LINE_STYLE } from '../../packages/renderer/src/lib/edgeRouting/lineStyle';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, { type: string; enum?: string[]; enumDescriptions?: string[]; default?: unknown; scope?: string; markdownDescription?: string }> } };
};

type MockPanel = ReturnType<typeof vscode.createMockWebviewPanel>;
type Posted = { type: string; payload?: any };
const posted = (panel: MockPanel) => panel._postedMessages as Posted[];
const lineStyles = (panel: MockPanel) => posted(panel).filter((m) => m.type === 'lineStyle').map((m) => m.payload.lineStyle);
const errors = (panel: MockPanel) => posted(panel).filter((m) => m.type === 'error').map((m) => m.payload.message as string);

let configListeners: Array<(e: vscode.ConfigurationChangeEvent) => void>;
const fireConfigChange = (key: string) => {
  const e = { affectsConfiguration: (section: string) => key === section || key.startsWith(`${section}.`) } as vscode.ConfigurationChangeEvent;
  for (const l of [...configListeners]) l(e);
};
const globalValue = () => vscode.workspace.getConfiguration('erdStudio').inspect(LINE_STYLE_SETTING)?.globalValue;

function makeDoc(fsPath: string) {
  const text = fs.readFileSync(fsPath, 'utf-8');
  return {
    uri: vscode.Uri.file(fsPath),
    isDirty: false,
    isClosed: false,
    getText: () => text,
    positionAt: (offset: number) => ({ offset }),
    save: vi.fn(async () => true),
  };
}

function makeProvider(root: string) {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const context = {
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: vscode.createMockMemento(),
    secrets: vscode.createMockSecretStorage(),
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;
  return new SemanticEditorProvider(
    context,
    subjectAreaService,
    new ManifestService(),
    new YmlParserService(),
    new TemplateService(),
    layerService,
    root,
    new SelectorsService(subjectAreaService, root, '.erd-studio'),
    tableLibraryService,
  );
}

/** Open a diagram on a fresh mock panel and wait for its first `domainLoaded`. */
async function open(provider: SemanticEditorProvider, root: string, rel: string) {
  const panel = vscode.createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    makeDoc(path.join(root, '.erd-studio', rel)) as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  panel._simulateMessage({ type: 'ready' });
  await vi.waitFor(() => expect(posted(panel).map((m) => m.type)).toContain('domainLoaded'), { timeout: 4000, interval: 10 });
  return panel;
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-line-style-'));
  fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  vscode._resetMockWorkspace();
  vscode._resetMockConfiguration();
  configListeners = [];
  vi.spyOn(vscode.workspace, 'onDidChangeConfiguration').mockImplementation(((listener: (e: vscode.ConfigurationChangeEvent) => void) => {
    configListeners.push(listener);
    return { dispose: () => { configListeners = configListeners.filter((l) => l !== listener); } };
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the setting', () => {
  it('is curved by default; anything but a known style reads as curved', () => {
    expect(DEFAULT_CANVAS_LINE_STYLE).toBe('curved');
    expect(readLineStyle()).toBe('curved');
    vscode._setMockConfiguration('erdStudio', LINE_STYLE_SETTING, { globalValue: 'hops' });
    expect(readLineStyle()).toBe('hops');
    vscode._setMockConfiguration('erdStudio', LINE_STYLE_SETTING, { globalValue: 'gaps' });
    expect(readLineStyle()).toBe('curved');
  });

  it('is contributed with both values described, curved by default', () => {
    const setting = pkg.contributes.configuration.properties['erdStudio.canvas.lineStyle'];
    expect(setting.type).toBe('string');
    expect(setting.enum).toEqual(['curved', 'hops']);
    expect(setting.enumDescriptions).toHaveLength(2);
    expect(setting.default).toBe('curved');
    expect(setting.markdownDescription).toContain('**Curved** and **Hops**');
  });

  it('names the same styles as the renderer', () => {
    expect([...CANVAS_LINE_STYLES]).toEqual([...LINE_STYLES]);
    expect(DEFAULT_CANVAS_LINE_STYLE).toBe(DEFAULT_LINE_STYLE);
    for (const style of CANVAS_LINE_STYLES) expect(isCanvasLineStyle(style)).toBe(true);
  });

  it('is written at user (Global) scope, never to the workspace', async () => {
    await writeLineStyle('hops');
    const inspected = vscode.workspace.getConfiguration('erdStudio').inspect(LINE_STYLE_SETTING);
    expect(inspected?.globalValue).toBe('hops');
    expect(inspected?.workspaceValue).toBeUndefined();
  });
});

describe('setLineStyle payload validation', () => {
  it('accepts the two styles', () => {
    expect(validateSetLineStylePayload({ lineStyle: 'curved' })).toBeNull();
    expect(validateSetLineStylePayload({ lineStyle: 'hops' })).toBeNull();
  });

  it.each([
    [undefined, 'must be an object'],
    [null, 'must be an object'],
    [['hops'], 'must be an object'],
    ['hops', 'must be an object'],
    [{}, 'must be "curved" or "hops"'],
    [{ lineStyle: 'gaps' }, 'must be "curved" or "hops"'],
    [{ lineStyle: 3 }, 'must be "curved" or "hops"'],
  ])('refuses %j', (payload, message) => {
    expect(validateSetLineStylePayload(payload)).toContain(message);
  });
});

describe('the canvas messages', () => {
  it('tells a canvas the style when it says ready', async () => {
    vscode._setMockConfiguration('erdStudio', LINE_STYLE_SETTING, { globalValue: 'hops' });
    const panel = await open(makeProvider(root), root, 'silver/showcase.json');
    expect(lineStyles(panel)).toEqual(['hops']);
    // After `loading` (always the first answer to ready) and before the diagram, so the first routing pass uses it.
    const types = posted(panel).map((m) => m.type);
    expect(types[0]).toBe('loading');
    expect(types.indexOf('lineStyle')).toBeLessThan(types.indexOf('domainLoaded'));
  });

  it('setLineStyle writes the user setting, and every open canvas hears the change', async () => {
    const provider = makeProvider(root);
    const a = await open(provider, root, 'silver/showcase.json');
    const b = await open(provider, root, 'gold/finance.json');
    a._simulateMessage({ type: 'setLineStyle', payload: { lineStyle: 'hops' } });
    await vi.waitFor(() => expect(globalValue()).toBe('hops'));
    // VS Code fires the configuration event after the write.
    fireConfigChange('erdStudio.canvas.lineStyle');
    expect(lineStyles(a).at(-1)).toBe('hops');
    expect(lineStyles(b).at(-1)).toBe('hops');
    expect(errors(a)).toEqual([]);
    // Another setting's change is not the line style's.
    const before = lineStyles(b).length;
    fireConfigChange('erdStudio.sidebar.rowDetails');
    expect(lineStyles(b)).toHaveLength(before);
  });

  it('a change made elsewhere (the Settings editor) reaches every canvas', async () => {
    const panel = await open(makeProvider(root), root, 'silver/showcase.json');
    vscode._setMockConfiguration('erdStudio', LINE_STYLE_SETTING, { globalValue: 'hops' });
    fireConfigChange('erdStudio.canvas.lineStyle');
    expect(lineStyles(panel)).toEqual(['curved', 'hops']);
  });

  it('refuses a bad payload with an error and writes nothing', async () => {
    const panel = await open(makeProvider(root), root, 'silver/showcase.json');
    await panel._simulateMessage({ type: 'setLineStyle', payload: { lineStyle: 'wavy' } });
    await vi.waitFor(() => expect(errors(panel).some((m) => m.includes('line style'))).toBe(true));
    expect(globalValue()).toBeUndefined();
  });

  it('a failed write puts the canvas back to the setting and says so', async () => {
    const panel = await open(makeProvider(root), root, 'silver/showcase.json');
    const real = vscode.workspace.getConfiguration;
    vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation(((section?: string) => ({
      ...real(section),
      update: async () => { throw new Error('read-only settings'); },
    })) as never);
    await panel._simulateMessage({ type: 'setLineStyle', payload: { lineStyle: 'hops' } });
    await vi.waitFor(() => expect(errors(panel)).toContain('ERD Studio could not save the line style in your settings.'));
    expect(lineStyles(panel).at(-1)).toBe('curved');
  });

  it('works on the physical stage: a view preference, not a schema mutation', async () => {
    const panel = await open(makeProvider(root), root, 'silver/showcase.json');
    panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    await vi.waitFor(() => expect(posted(panel).map((m) => m.type)).toContain('stageData'), { timeout: 4000, interval: 10 });
    await panel._simulateMessage({ type: 'setLineStyle', payload: { lineStyle: 'hops' } });
    await vi.waitFor(() => expect(globalValue()).toBe('hops'));
    expect(errors(panel)).not.toContain(PHYSICAL_READ_ONLY_MESSAGE);
  });

  it('stops telling a closed canvas', async () => {
    const panel = await open(makeProvider(root), root, 'silver/showcase.json');
    const listeners = configListeners.length;
    panel.dispose();
    expect(configListeners.length).toBe(listeners - 1);
  });
});
