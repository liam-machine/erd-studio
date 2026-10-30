/**
 * What the canvas writes to the ERD Studio log, and its Show Logs message:
 *
 * - opening a diagram logs each phase and "posted N tables M ms after ready";
 * - a position save logs how many tables moved and how long the save took;
 * - `showLogs` (the load-error screen and the "Canvas disconnected" overlay)
 *   runs `erdStudio.showLogs`, on the physical stage too, and writes nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import { clearLogBuffer, recentLogLines, setLogSink, type LogSink } from '../../src/services/logger';
import { redactPaths } from '../../src/types/feedback';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';

const NATIVE = path.resolve(__dirname, '..', 'fixtures', 'dbml-native');

let root: string;
let sinkLines: string[];

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
    workspaceState: { get: () => true, update: async () => {} },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
  const provider = new SemanticEditorProvider(
    context,
    subjectAreaService,
    { loadManifest: async () => empty, getManifestPath: () => path.join(projectRoot, 'target', 'manifest.json') } as unknown as ManifestService,
    { loadYmlData: async () => ({ models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map() }) } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    projectRoot,
    new SelectorsService(subjectAreaService, projectRoot, '.erd-studio'),
    tableLibraryService,
    new OwnWriteTracker(),
  );
  provider.setLogicalOnly(true);
  return provider;
}

const at = (rel: string): string => path.join(root, '.erd-studio', rel);

async function open(provider: SemanticEditorProvider, rel: string) {
  const doc = createMockTextDocument(at(rel), fs.readFileSync(at(rel), 'utf-8'), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(doc);
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(doc as never, panel as never, {} as never);
  return { doc, panel };
}

beforeEach(() => {
  _resetMockWorkspace();
  vscode._resetRegisteredCommands();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-canvas-log-'));
  fs.cpSync(NATIVE, root, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  clearLogBuffer();
  sinkLines = [];
  const at2 = (level: string) => (message: string | Error) => { sinkLines.push(`${level} ${String(message)}`); };
  const sink: LogSink = { trace: at2('trace'), debug: at2('debug'), info: at2('info'), warn: at2('warn'), error: at2('error') };
  setLogSink(sink);
});

afterEach(() => {
  setLogSink(undefined);
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('opening a diagram is logged', () => {
  it('logs the phases and how long after ready the tables were posted, with the member count', async () => {
    const provider = buildProvider(root);
    const { panel } = await open(provider, 'gold/diagrams/sales.dbml');
    await panel._simulateMessage({ type: 'ready' });

    const lines = recentLogLines().map((l) => l.replace(/^\S+ \[info\] /, ''));
    const file = at('gold/diagrams/sales.dbml');
    expect(lines).toContain(`[Canvas] Opening ${file}`);
    expect(lines.some((l) => l.startsWith(`[Canvas] Open ${file}: reading the diagram and its tables took `))).toBe(true);
    expect(lines.some((l) => l.startsWith(`[Canvas] Open ${file}: posted 6 tables in `))).toBe(true);
    // Sent with a report, a line names the diagram by its shape only (S8b names the
    // layer-first shapes, `{layer}/diagrams/{diagram}.dbml`; until then a generic one).
    const redacted = redactPaths(lines.find((l) => l.startsWith(`[Canvas] Opened `))!);
    expect(redacted).toMatch(/^\[Canvas\] Opened \{project\}\/\.erd-studio\/\{[a-z]+\}\/(diagrams\/)?\{[a-z]+\}\.dbml: 6 tables posted/);
    expect(redacted).not.toMatch(/gold|sales/);
    expect(lines.some((l) => new RegExp(`^\\[Canvas\\] Opened ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: 6 tables posted \\d+ ms after ready$`).test(l))).toBe(true);
  });

  it('a refresh logs its phases at debug only (not in the buffer Send Feedback offers)', async () => {
    const provider = buildProvider(root);
    const { panel } = await open(provider, 'gold/diagrams/sales.dbml');
    await panel._simulateMessage({ type: 'ready' });
    clearLogBuffer();
    sinkLines.length = 0;
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'logical', requestId: 1 } });
    expect(recentLogLines().filter((l) => l.includes('Refresh '))).toEqual([]);
  });

  it('a diagram that fails to load says so, with how long it took', async () => {
    fs.writeFileSync(at('gold/diagrams/sales.dbml'), "Project sales {\n  erd_schema_version: '7'\n");
    const provider = buildProvider(root);
    const { panel } = await open(provider, 'gold/diagrams/sales.dbml');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await panel._simulateMessage({ type: 'ready' });
    expect(recentLogLines().some((l) => /\[Canvas\] Opening .*sales\.dbml ended without a diagram after \d+ ms$/.test(l))).toBe(true);
  });
});

describe('position saves are logged', () => {
  it('says how many tables moved and how long the save took', async () => {
    const provider = buildProvider(root);
    const { panel } = await open(provider, 'gold/diagrams/sales.dbml');
    await panel._simulateMessage({ type: 'ready' });
    clearLogBuffer();
    await panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 1234, y: 567 } } } });
    await vi.waitFor(() =>
      expect(recentLogLines().some((l) => /\[Canvas\] Saved the positions of 1 table in .*sales\.dbml in \d+ ms/.test(l))).toBe(true),
    );
  });
});

describe('the showLogs message', () => {
  it('runs erdStudio.showLogs, also while the physical stage is on screen', async () => {
    const shown = vi.fn();
    vscode.commands.registerCommand('erdStudio.showLogs', shown);
    const provider = buildProvider(root);
    provider.setLogicalOnly(false);
    const { panel } = await open(provider, 'gold/diagrams/sales.dbml');
    await panel._simulateMessage({ type: 'showLogs' });
    expect(shown).toHaveBeenCalledTimes(1);
    // No "Physical stage is read-only" refusal for it: it is on the allowlist.
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 2 } });
    await panel._simulateMessage({ type: 'showLogs' });
    expect(shown).toHaveBeenCalledTimes(2);
    const errors = (panel._postedMessages as Array<{ type: string; payload?: { message?: string } }>)
      .filter((m) => m.type === 'error' && /read-only/.test(m.payload?.message ?? ''));
    expect(errors).toEqual([]);
  });
});
