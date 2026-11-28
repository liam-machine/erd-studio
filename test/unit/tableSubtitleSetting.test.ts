/**
 * The `erdStudio.canvas.tableSubtitle` setting
 * (`src/providers/tableSubtitleSetting.ts`, #367) and its two canvas
 * messages: the host tells every canvas what the line under each table's
 * name shows with `tableSubtitle` (on `ready` and whenever the setting
 * changes), and the toolbar's `setTableSubtitle` writes it. A view
 * preference: it writes no project file and works on the physical stage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEFAULT_TABLE_SUBTITLE, isTableSubtitle } from '@erd-studio/core';

import { SemanticEditorProvider, PHYSICAL_READ_ONLY_MESSAGE } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { TABLE_SUBTITLE_SETTING, TABLE_SUBTITLE_WORKSPACE_NOTE, readTableSubtitle, writeTableSubtitle } from '../../src/providers/tableSubtitleSetting';
import { validateSetTableSubtitlePayload } from '../../src/providers/payloadValidation';
import { USER_SCOPED_SETTINGS } from '../../src/services/configService';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, { type: string; pattern?: string; enum?: string[]; default?: unknown; scope?: string; markdownDescription?: string }> } };
};

type MockPanel = ReturnType<typeof vscode.createMockWebviewPanel>;
type Posted = { type: string; payload?: any };
const posted = (panel: MockPanel) => panel._postedMessages as Posted[];
const subtitles = (panel: MockPanel) => posted(panel).filter((m) => m.type === 'tableSubtitle').map((m) => m.payload.tableSubtitle);
const notices = (panel: MockPanel) => posted(panel).filter((m) => m.type === 'canvasNotice').map((m) => m.payload.message as string);
const errors = (panel: MockPanel) => posted(panel).filter((m) => m.type === 'error').map((m) => m.payload.message as string);

let configListeners: Array<(e: vscode.ConfigurationChangeEvent) => void>;
const fireConfigChange = (key: string) => {
  const e = { affectsConfiguration: (section: string) => key === section || key.startsWith(`${section}.`) } as vscode.ConfigurationChangeEvent;
  for (const l of [...configListeners]) l(e);
};
const inspect = () => vscode.workspace.getConfiguration('erdStudio').inspect(TABLE_SUBTITLE_SETTING);
const globalValue = () => inspect()?.globalValue;

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-table-subtitle-'));
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
  it('is the grain by default; anything that is not a choice reads as the grain', () => {
    expect(readTableSubtitle()).toBe('field:grain');
    vscode._setMockConfiguration('erdStudio', TABLE_SUBTITLE_SETTING, { globalValue: 'field:owner' });
    expect(readTableSubtitle()).toBe('field:owner');
    vscode._setMockConfiguration('erdStudio', TABLE_SUBTITLE_SETTING, { globalValue: 'none' });
    expect(readTableSubtitle()).toBe('none');
    for (const bad of ['owner', 'Description', '', 7, { field: 'owner' }]) {
      vscode._setMockConfiguration('erdStudio', TABLE_SUBTITLE_SETTING, { globalValue: bad });
      expect(readTableSubtitle()).toBe('field:grain');
    }
  });

  it('a workspace value wins over the user\'s: a team can check its choice in', () => {
    vscode._setMockConfiguration('erdStudio', TABLE_SUBTITLE_SETTING, { globalValue: 'none', workspaceValue: 'field:owner' });
    expect(readTableSubtitle()).toBe('field:owner');
    // Nothing secret travels with it, so it is not pinned to user scope.
    expect(USER_SCOPED_SETTINGS.has(TABLE_SUBTITLE_SETTING)).toBe(false);
  });

  it('is contributed as text, the grain by default, with a pattern that takes what the reader takes', () => {
    const setting = pkg.contributes.configuration.properties['erdStudio.canvas.tableSubtitle'];
    expect(setting.type).toBe('string');
    expect(setting.default).toBe(DEFAULT_TABLE_SUBTITLE);
    expect(setting.enum).toBeUndefined();
    expect(setting.scope).toBeUndefined();
    expect(setting.markdownDescription).toContain('**Under name**');
    const pattern = new RegExp(setting.pattern as string);
    for (const value of ['field:grain', 'field:owner', 'field:open_questions', 'field:Data Owner', 'field:x', 'description', 'none']) {
      expect(pattern.test(value)).toBe(true);
      expect(isTableSubtitle(value)).toBe(true);
    }
    for (const value of ['', 'grain', 'owner', 'Description', 'field:', 'field: owner', 'field:owner ', 'meta:owner', `field:${'k'.repeat(129)}`]) {
      expect(pattern.test(value)).toBe(false);
      expect(isTableSubtitle(value)).toBe(false);
    }
  });

  it('is written at user (Global) scope, never to the workspace', async () => {
    await writeTableSubtitle('field:owner');
    expect(inspect()?.globalValue).toBe('field:owner');
    expect(inspect()?.workspaceValue).toBeUndefined();
  });

  it('never edits a value the workspace checked in: the write is the user\'s, and the workspace still wins', async () => {
    vscode._setMockConfiguration('erdStudio', TABLE_SUBTITLE_SETTING, { globalValue: 'none', workspaceValue: 'field:owner' });
    await writeTableSubtitle('description');
    expect(inspect()?.workspaceValue).toBe('field:owner');
    expect(inspect()?.globalValue).toBe('description');
    expect(readTableSubtitle()).toBe('field:owner');
  });
});

describe('setTableSubtitle payload validation', () => {
  it('accepts a field, the description and nothing', () => {
    for (const tableSubtitle of ['field:grain', 'field:owner', 'description', 'none']) {
      expect(validateSetTableSubtitlePayload({ tableSubtitle })).toBeNull();
    }
  });

  it.each([
    [undefined, 'must be an object'],
    [null, 'must be an object'],
    [['none'], 'must be an object'],
    ['none', 'must be an object'],
    [{}, 'must be "field:<key>", "description" or "none"'],
    [{ tableSubtitle: 'owner' }, 'must be "field:<key>", "description" or "none"'],
    [{ tableSubtitle: 'field:' }, 'must be "field:<key>", "description" or "none"'],
    [{ tableSubtitle: `field:${'k'.repeat(4000)}` }, 'must be "field:<key>", "description" or "none"'],
    [{ tableSubtitle: 3 }, 'must be "field:<key>", "description" or "none"'],
  ])('refuses %j', (payload, message) => {
    expect(validateSetTableSubtitlePayload(payload)).toContain(message);
  });
});

describe('the canvas messages', () => {
  it('tells a canvas the choice when it says ready, before the diagram', async () => {
    vscode._setMockConfiguration('erdStudio', TABLE_SUBTITLE_SETTING, { globalValue: 'field:purpose' });
    const panel = await open(makeProvider(root), root, 'silver/showcase.json');
    expect(subtitles(panel)).toEqual(['field:purpose']);
    // Before the diagram: the first layout sizes every table with the line it will draw.
    const types = posted(panel).map((m) => m.type);
    expect(types[0]).toBe('loading');
    expect(types.indexOf('tableSubtitle')).toBeLessThan(types.indexOf('domainLoaded'));
  });

  it('setTableSubtitle writes the setting, and every open canvas hears the change', async () => {
    const provider = makeProvider(root);
    const a = await open(provider, root, 'silver/showcase.json');
    const b = await open(provider, root, 'gold/finance.json');
    a._simulateMessage({ type: 'setTableSubtitle', payload: { tableSubtitle: 'description' } });
    await vi.waitFor(() => expect(globalValue()).toBe('description'));
    // VS Code fires the configuration event after the write.
    fireConfigChange('erdStudio.canvas.tableSubtitle');
    expect(subtitles(a).at(-1)).toBe('description');
    expect(subtitles(b).at(-1)).toBe('description');
    expect(errors(a)).toEqual([]);
    // Another setting's change is not this one's.
    const before = subtitles(b).length;
    fireConfigChange('erdStudio.canvas.lineStyle');
    expect(subtitles(b)).toHaveLength(before);
  });

  it('a pick a workspace value outranks is saved for the user, and the canvas is put back and told why', async () => {
    vscode._setMockConfiguration('erdStudio', TABLE_SUBTITLE_SETTING, { workspaceValue: 'field:purpose' });
    const panel = await open(makeProvider(root), root, 'silver/showcase.json');
    await panel._simulateMessage({ type: 'setTableSubtitle', payload: { tableSubtitle: 'none' } });
    await vi.waitFor(() => expect(globalValue()).toBe('none'));
    await vi.waitFor(() => expect(notices(panel)).toEqual([TABLE_SUBTITLE_WORKSPACE_NOTE]));
    expect(inspect()?.workspaceValue).toBe('field:purpose');
    expect(subtitles(panel).at(-1)).toBe('field:purpose');
    expect(errors(panel)).toEqual([]);
    // A pick the setting takes says nothing.
    vscode._setMockConfiguration('erdStudio', TABLE_SUBTITLE_SETTING, { globalValue: 'none' });
    await panel._simulateMessage({ type: 'setTableSubtitle', payload: { tableSubtitle: 'description' } });
    await vi.waitFor(() => expect(globalValue()).toBe('description'));
    expect(notices(panel)).toHaveLength(1);
  });

  it('writes no project file: the diagram and its tables are byte for byte the same', async () => {
    const snapshot = () => {
      const out: Record<string, string> = {};
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
        }
      };
      walk(path.join(root, '.erd-studio'));
      return out;
    };
    const panel = await open(makeProvider(root), root, 'silver/showcase.json');
    const before = snapshot();
    const edits = vi.spyOn(vscode.workspace, 'applyEdit');
    for (const tableSubtitle of ['field:purpose', 'description', 'none', 'field:grain']) {
      panel._simulateMessage({ type: 'setTableSubtitle', payload: { tableSubtitle } });
      await vi.waitFor(() => expect(globalValue()).toBe(tableSubtitle));
      fireConfigChange('erdStudio.canvas.tableSubtitle');
    }
    expect(edits).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it('a change made elsewhere (the Settings editor) reaches every canvas; a bad value reads as the grain', async () => {
    const panel = await open(makeProvider(root), root, 'silver/showcase.json');
    vscode._setMockConfiguration('erdStudio', TABLE_SUBTITLE_SETTING, { globalValue: 'none' });
    fireConfigChange('erdStudio.canvas.tableSubtitle');
    vscode._setMockConfiguration('erdStudio', TABLE_SUBTITLE_SETTING, { globalValue: 'Owner' });
    fireConfigChange('erdStudio.canvas.tableSubtitle');
    expect(subtitles(panel)).toEqual(['field:grain', 'none', 'field:grain']);
  });

  it('refuses a bad payload with an error and writes nothing', async () => {
    const panel = await open(makeProvider(root), root, 'silver/showcase.json');
    await panel._simulateMessage({ type: 'setTableSubtitle', payload: { tableSubtitle: 'owner' } });
    await vi.waitFor(() => expect(errors(panel).some((m) => m.includes('line under the table names'))).toBe(true));
    expect(globalValue()).toBeUndefined();
  });

  it('a failed write puts the canvas back to the setting and says so', async () => {
    const panel = await open(makeProvider(root), root, 'silver/showcase.json');
    const real = vscode.workspace.getConfiguration;
    vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation(((section?: string) => ({
      ...real(section),
      update: async () => { throw new Error('read-only settings'); },
    })) as never);
    await panel._simulateMessage({ type: 'setTableSubtitle', payload: { tableSubtitle: 'none' } });
    await vi.waitFor(() => expect(errors(panel)).toContain('ERD Studio could not save the line under the table names in your settings.'));
    expect(subtitles(panel).at(-1)).toBe('field:grain');
  });

  it('works on the physical stage: a view preference, not a schema mutation', async () => {
    const panel = await open(makeProvider(root), root, 'silver/showcase.json');
    panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    await vi.waitFor(() => expect(posted(panel).map((m) => m.type)).toContain('stageData'), { timeout: 4000, interval: 10 });
    await panel._simulateMessage({ type: 'setTableSubtitle', payload: { tableSubtitle: 'none' } });
    await vi.waitFor(() => expect(globalValue()).toBe('none'));
    expect(errors(panel)).not.toContain(PHYSICAL_READ_ONLY_MESSAGE);
  });

  it('stops telling a closed canvas', async () => {
    const panel = await open(makeProvider(root), root, 'silver/showcase.json');
    const listeners = configListeners.length;
    panel.dispose();
    expect(configListeners.length).toBe(listeners - 1);
  });
});
