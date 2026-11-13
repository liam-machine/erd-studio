/**
 * The canvas host's 2.0 telemetry (B13, B14, B17), through the stateful
 * vscode mock: `webviewError` mapped to its codes (and refused with anything
 * else), the new `layoutFinished` fields, a visible canvas that never says
 * ready, why a DBML diagram failed to open versus a refresh failing over a
 * live canvas, and the degraded-render flags of a canvas open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { telemetry } from '../../src/services/telemetryService';
import { log } from '../../src/services/logger';
import { READY_TIMEOUT_MS } from '../../src/services/readyWatch';
import { dbtFixtureRoot, diagramPath, type DbtStorage } from './helpers/dbtFixtures';

const REPO_ROOT = path.resolve(__dirname, '../..');

type MockPanel = ReturnType<typeof vscode.createMockWebviewPanel>;
type Posted = { type: string; payload?: any };

let root: string;

function useFixture(storage: DbtStorage): void {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-canvas-telemetry-'));
    fs.cpSync(dbtFixtureRoot(storage === 'yaml' ? 'dbt-project' : 'dbt-project-dbml'), root, { recursive: true });
  });
}

function makeDoc(fsPath: string) {
  return {
    uri: vscode.Uri.file(fsPath),
    isDirty: false,
    isClosed: false,
    getText: () => fs.readFileSync(fsPath, 'utf-8'),
    positionAt: (offset: number) => ({ offset }),
    save: vi.fn(async () => true),
  };
}

function buildProvider() {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const context = {
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    workspaceState: vscode.createMockMemento(),
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

const types = (panel: MockPanel) => (panel._postedMessages as Posted[]).map((m) => m.type);

async function open(file: string, opts: { ready?: boolean } = {}) {
  const provider = buildProvider();
  const panel = vscode.createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    makeDoc(file) as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  if (opts.ready !== false) await panel._simulateMessage({ type: 'ready' });
  return { provider, panel };
}

let error: ReturnType<typeof vi.spyOn>;
let feature: ReturnType<typeof vi.spyOn>;
let featureOnce: ReturnType<typeof vi.spyOn>;
const errorCodes = () => error.mock.calls.map(([c]) => c);
const featureKeys = () => [...feature.mock.calls, ...featureOnce.mock.calls].map(([k]) => k);

beforeEach(() => {
  vscode._resetMockWorkspace();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(telemetry, 'error');
  feature = vi.spyOn(telemetry, 'feature');
  featureOnce = vi.spyOn(telemetry, 'featureOnce');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('webviewError and layoutFinished (B13, B17)', () => {
  useFixture('yaml');

  it('maps a crash to its codes, and refuses anything else', async () => {
    const { panel } = await open(diagramPath(root, 'yaml', 'silver', 'showcase'));
    error.mockClear();
    await panel._simulateMessage({ type: 'webviewError', payload: { kind: 'render', area: 'detailPanel' } });
    await panel._simulateMessage({ type: 'webviewError', payload: { kind: 'rejection', area: 'other' } });
    expect(errorCodes()).toEqual(['webviewCrash', 'webviewCrashDetailPanel', 'webviewRejection']);

    error.mockClear();
    await panel._simulateMessage({ type: 'webviewError', payload: { kind: 'render', area: 'secret/path.dbml' } });
    await panel._simulateMessage({ type: 'webviewError' });
    expect(errorCodes()).toEqual([]);
    // Telemetry only: no error toast, no write.
    expect(types(panel).filter((t) => t === 'error')).toHaveLength(0);
  });

  it('records the layout failure class, the stack fallback and a slow first-open layout', async () => {
    const { panel } = await open(diagramPath(root, 'yaml', 'silver', 'showcase'));
    error.mockClear();
    feature.mockClear();
    await panel._simulateMessage({ type: 'layoutFinished', payload: { ms: 30000, ok: false, failure: 'timeout' } });
    expect(errorCodes()).toEqual(['layoutFailed', 'layoutFailedTimeout', 'layoutFailedOver5s']);
    await panel._simulateMessage({ type: 'layoutFinished', payload: { ms: 7000, ok: true, firstOpen: true, fallback: true } });
    expect(featureKeys()).toEqual(expect.arrayContaining(['layoutOver5s', 'layoutStackFallback', 'firstLayoutOver5s']));
  });

  it('records what kind of diagram failed, how, and how far the fallbacks got; the counts and message go to the log only', async () => {
    const { panel } = await open(diagramPath(root, 'yaml', 'silver', 'showcase'));
    error.mockClear();
    feature.mockClear();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await panel._simulateMessage({
      type: 'layoutFinished',
      payload: {
        ms: 64000, ok: false, firstOpen: true, failure: 'stack', tableBucket: '500plus', relBucket: '2000plus', exhausted: true, lastFailure: 'timeout',
        log: { tables: 1134, relationships: 2417, message: 'RangeError: Maximum call stack size exceeded' },
      },
    });
    expect(errorCodes()).toEqual([
      'layoutFailed', 'firstLayoutFailed', 'layoutFailedStack', 'layoutFailedTables500Plus', 'layoutFailedRels2000Plus',
      'layoutFailedOver5s', 'layoutFailedAllRungs', 'layoutFailedLastRungTimeout',
    ]);
    expect(featureKeys()).toEqual(['layoutFailed']);
    // Nothing counted holds a count or the text.
    expect(JSON.stringify([error.mock.calls, feature.mock.calls])).not.toMatch(/1134|2417|Maximum call stack/);
    // The ERD Studio log (local) has both.
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => /First-open auto layout failed \(class stack, .*1134 tables, 2417 relationships; after 64000 ms\): RangeError: Maximum call stack size exceeded/.test(l))).toBe(true);

    // A fallback that worked: which rung.
    feature.mockClear();
    await panel._simulateMessage({ type: 'layoutFinished', payload: { ms: 900, ok: true, fallback: true, rung: 3 } });
    expect(featureKeys()).toEqual(['layoutUnder1s', 'layoutStackFallback', 'layoutFallbackRung3']);

    // A layout that worked but not as asked (the reporter, 2026-11-12): what the
    // page says it did, with the counts, goes to the log as an info line;
    // telemetry counts only the rung, never the text or the counts.
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    feature.mockClear();
    error.mockClear();
    await panel._simulateMessage({
      type: 'layoutFinished',
      payload: {
        ms: 1200, ok: true, fallback: true, rung: 3,
        log: { tables: 130, relationships: 80, message: 'used the grid fallback (no ELK), grouping depth; the default layout failed: Maximum call stack size exceeded' },
      },
    });
    expect(info.mock.calls.map((c) => String(c[0]))).toContain(
      '[SemanticEditorProvider] Auto layout used the grid fallback (no ELK), grouping depth; the default layout failed: Maximum call stack size exceeded (130 tables, 80 relationships; after 1200 ms)',
    );
    expect(errorCodes()).toEqual([]);
    expect(JSON.stringify(feature.mock.calls)).not.toMatch(/grid|Maximum call stack|130/);
    // A layout that worked as asked writes no line.
    info.mockClear();
    await panel._simulateMessage({ type: 'layoutFinished', payload: { ms: 300, ok: true } });
    expect(info.mock.calls.filter((c) => String(c[0]).includes('Auto layout'))).toEqual([]);
    info.mockRestore();

    // A field out of range: nothing is counted at all.
    error.mockClear();
    feature.mockClear();
    await panel._simulateMessage({ type: 'layoutFinished', payload: { ms: 10, ok: false, failure: 'stack', tableBucket: 1134 } });
    expect(errorCodes()).toEqual([]);
    expect(featureKeys()).toEqual([]);
    warn.mockRestore();
  });
});

describe('the canvas ready watch (B13)', () => {
  useFixture('yaml');

  it('reports a visible canvas that never says ready', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await open(diagramPath(root, 'yaml', 'silver', 'showcase'), { ready: false });
    vi.advanceTimersByTime(READY_TIMEOUT_MS);
    expect(errorCodes()).toContain('webviewNoReadyCanvas');
  });

  it('reports nothing once ready, or after the tab closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const closed = await open(diagramPath(root, 'yaml', 'silver', 'showcase'), { ready: false });
    closed.panel.dispose();
    const hidden = await open(diagramPath(root, 'yaml', 'silver', 'showcase'), { ready: false });
    hidden.panel._simulateViewStateChange(false);
    vi.advanceTimersByTime(READY_TIMEOUT_MS * 2);
    expect(errorCodes()).not.toContain('webviewNoReadyCanvas');
  });
});

describe('why a DBML diagram did not load (B14)', () => {
  useFixture('dbml');

  it('says why a diagram could not open, from core, and only flags a refresh over a live canvas', async () => {
    const file = diagramPath(root, 'dbml', 'silver', 'showcase');
    const good = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, `${good}\nTable broken {\n  id int [pk\n}\n`);
    await open(file);
    expect(errorCodes()).toEqual(expect.arrayContaining(['domainLoad', 'domainLoadDbml', 'domainLoadDbmlSyntax']));
    expect(featureKeys()).toContain('domainLoadBlocking');
    expect(featureKeys()).not.toContain('domainLoadOverLive');

    // A canvas that opened, then a refresh that fails (an assistant part-way through writing).
    fs.writeFileSync(file, good);
    const { provider } = await open(file);
    error.mockClear();
    feature.mockClear();
    fs.writeFileSync(file, `${good}\nTable broken {\n  id int [pk\n}\n`);
    await provider.refreshSubjectAreaPanel(file);
    expect(errorCodes()).toEqual(expect.arrayContaining(['domainLoad', 'domainLoadDbml']));
    expect(errorCodes()).not.toContain('domainLoadDbmlSyntax');
    expect(featureKeys()).toContain('domainLoadOverLive');
    expect(featureKeys()).not.toContain('domainLoadBlocking');
  });

  it('a stage switch that meets a diagram the user broke is theirs, not a handler failure of ours', async () => {
    const file = diagramPath(root, 'dbml', 'silver', 'showcase');
    const good = fs.readFileSync(file, 'utf-8');
    const { panel } = await open(file);
    error.mockClear();
    feature.mockClear();
    fs.writeFileSync(file, `${good}\nTable broken {\n  id int [pk\n}\n`);
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical' } });
    expect(types(panel)).toContain('error');
    expect(errorCodes()).not.toContain('handlerFailed');
    expect(errorCodes()).not.toContain('handlerFailedStage');
    expect(featureKeys()).toContain('handlerFileProblem');
  });

  it('flags a diagram whose erd_layout has a line it cannot read, and a table not found', async () => {
    const file = diagramPath(root, 'dbml', 'silver', 'showcase');
    const text = fs.readFileSync(file, 'utf-8')
      .replace('    dim_customer 40 60\n', '    dim_customer 40 60\n    this is not a layout line\n')
      .replace("use { table silver.dim_task }", "use { table silver.dim_nowhere } from '../tables/silver/dim_nowhere.dbml'\nuse { table silver.dim_task }");
    fs.writeFileSync(file, text);
    vi.spyOn(telemetry, 'enabled').mockReturnValue(true);
    await open(file);
    expect(featureOnce.mock.calls.map(([k]) => k)).toEqual(expect.arrayContaining(['dbmlLayoutBadLine', 'diagramWarnModelNotFound']));
    expect(featureOnce.mock.calls.map(([k]) => k)).not.toContain('dbmlDiagramReadOnly');
  });

  it('counts an open and each edit against the diagram, and a view-only message against nothing', async () => {
    const used = vi.spyOn(telemetry, 'diagramUsed');
    const file = diagramPath(root, 'dbml', 'silver', 'showcase');
    const { panel } = await open(file);
    const uri = vscode.Uri.file(file).toString();
    expect(used.mock.calls).toEqual([[uri, 'open']]);
    await panel._simulateMessage({ type: 'updatePositions', payload: { positions: { dim_customer: { x: 10, y: 20 } } } });
    expect(used.mock.calls).toEqual([[uri, 'open'], [uri, 'edit']]);
    await panel._simulateMessage({ type: 'setLineStyle', payload: { style: 'curved' } });
    expect(used.mock.calls).toHaveLength(2);
  });

  it('does no telemetry-only reading when usage telemetry is off', async () => {
    const file = diagramPath(root, 'dbml', 'silver', 'showcase');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('    dim_customer 40 60\n', '    dim_customer 40 60\n    this is not a layout line\n'));
    vi.spyOn(telemetry, 'enabled').mockReturnValue(false);
    await open(file);
    expect(featureOnce.mock.calls.map(([k]) => k)).not.toContain('dbmlLayoutBadLine');
  });
});
