/**
 * Logical-only mode: the open root has no dbt_project.yml, so there is no
 * Physical stage. The host marks every logical payload `logicalOnly: true`,
 * answers a physical switch with the logical stage (echoing requestId),
 * answers Diff with no report (and no staleness check), and explains Add
 * Tables from dbt instead of listing a plain folder's decoy models/.
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
import { ADD_FROM_DBT_NEEDS_DBT_MESSAGE } from '../../src/services/projectDiscovery';
import * as staleness from '../../src/services/stalenessService';
import { telemetry } from '../../src/services/telemetryService';

const REPO_ROOT = path.resolve(__dirname, '../..');
const LOGICAL_ONLY_FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'logical-only');
const DBT_FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');

type Posted = { type: string; payload?: unknown; requestId?: number; logicalOnly?: true; manifestMissing?: boolean };

function buildProvider(rootDir: string, logicalOnly: boolean) {
  const layerService = new LayerService(rootDir, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(rootDir, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const context = {
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(rootDir, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    workspaceState: { get: () => undefined, update: async () => {} },
    secrets: vscode.createMockSecretStorage(),
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;
  const provider = new SemanticEditorProvider(
    context, subjectAreaService,
    new ManifestService({ enabled: !logicalOnly }), new YmlParserService({ enabled: !logicalOnly }),
    new TemplateService(), layerService, rootDir,
    new SelectorsService(subjectAreaService, rootDir, '.erd-studio'), tableLibraryService,
  );
  provider.setLogicalOnly(logicalOnly);
  return provider;
}

async function openIn(provider: SemanticEditorProvider, file: string) {
  const doc = {
    uri: vscode.Uri.file(file), isDirty: false, isClosed: false, lineCount: 1,
    getText: () => fs.readFileSync(file, 'utf-8'), positionAt: (o: number) => ({ o }), save: async () => true,
  };
  const panel = vscode.createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  await panel._simulateMessage({ type: 'ready' });
  return panel;
}

const posted = (panel: { _postedMessages: unknown[] }) => panel._postedMessages as Posted[];
const ofType = (panel: { _postedMessages: unknown[] }, type: string) => posted(panel).filter((m) => m.type === type);
const modelNames = (m: Posted) => (m.payload as { models: Array<{ name: string }> }).models.map((x) => x.name);
const stageOf = (m: Posted) => (m.payload as { stage: string }).stage;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-logical-only-'));
  vscode._resetMockWorkspace();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('SemanticEditorProvider in logical-only mode', () => {
  let file: string;
  beforeEach(() => {
    fs.cpSync(LOGICAL_ONLY_FIXTURE, root, { recursive: true });
    file = path.join(root, '.erd-studio', 'gold', 'sales.json');
  });

  // That the dbt readers are disabled (the decoy models/ is never walked) is
  // covered against activate()'s real wiring in extension.activate.test.ts.
  it('marks the first logical payload logicalOnly, with no manifest hint', async () => {
    const panel = await openIn(buildProvider(root, true), file);
    const loaded = ofType(panel, 'domainLoaded');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].logicalOnly).toBe(true);
    expect(loaded[0].manifestMissing).toBeUndefined();
    expect(stageOf(loaded[0])).toBe('logical');
    expect(modelNames(loaded[0])).toEqual(['customer']);
  });

  it('records no manifest telemetry: the day stays unknown rather than a fresh manifest', async () => {
    const manifest = vi.spyOn(telemetry, 'manifest');
    const featureOnce = vi.spyOn(telemetry, 'featureOnce');
    const canvasOpened = vi.spyOn(telemetry, 'canvasOpened');
    await openIn(buildProvider(root, true), file);
    expect(canvasOpened).toHaveBeenCalledWith('logical', expect.anything(), 1);
    expect(manifest).not.toHaveBeenCalled();
    expect(featureOnce).not.toHaveBeenCalledWith('manifestMissingCanvas');
  });

  it('answers a physical switch with the logical stage, echoing requestId', async () => {
    const panel = await openIn(buildProvider(root, true), file);
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 7 } });
    const replies = ofType(panel, 'stageData');
    expect(replies).toHaveLength(1);
    expect(replies[0].requestId).toBe(7);
    expect(replies[0].logicalOnly).toBe(true);
    expect(stageOf(replies[0])).toBe('logical');
    expect(modelNames(replies[0])).toEqual(['customer']);
  });

  it('a host-initiated physical switch (tree "open in physical") is coerced too', async () => {
    vi.useFakeTimers();
    try {
      const provider = buildProvider(root, true);
      const panel = await openIn(provider, file);
      provider.switchStageForUri(vscode.Uri.file(file), 'physical');
      await vi.waitFor(() => expect(ofType(panel, 'stageData')).toHaveLength(1));
      const [reply] = ofType(panel, 'stageData');
      expect(stageOf(reply)).toBe('logical');
      expect(reply.logicalOnly).toBe(true);
      expect(reply.requestId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers Diff with no report and never checks manifest staleness', async () => {
    const check = vi.spyOn(staleness, 'checkManifestStaleness');
    const panel = await openIn(buildProvider(root, true), file);
    await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
    expect(ofType(panel, 'discrepancyReport')).toEqual([{ type: 'discrepancyReport', payload: null }]);
    expect(ofType(panel, 'manifestStaleness')).toEqual([]);
    expect(check).not.toHaveBeenCalled();
  });

  it('Add Tables from dbt explains itself instead of listing models', async () => {
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const pick = vi.spyOn(vscode.window, 'showQuickPick');
    const panel = await openIn(buildProvider(root, true), file);
    await panel._simulateMessage({ type: 'addModelsFromDbt', payload: {} });
    expect(info).toHaveBeenCalledWith(ADD_FROM_DBT_NEEDS_DBT_MESSAGE);
    expect(pick).not.toHaveBeenCalled();
    expect(ofType(panel, 'error')).toEqual([]);
  });
});

describe('SemanticEditorProvider with a dbt project (flag absent)', () => {
  it('sends no logicalOnly key, and a physical switch still answers the physical stage', async () => {
    fs.cpSync(DBT_FIXTURE, root, { recursive: true });
    const panel = await openIn(buildProvider(root, false), path.join(root, '.erd-studio', 'silver', 'showcase.json'));
    const [loaded] = ofType(panel, 'domainLoaded');
    expect('logicalOnly' in loaded).toBe(false);
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 3 } });
    const [reply] = ofType(panel, 'stageData');
    expect(stageOf(reply)).toBe('physical');
    expect(reply.requestId).toBe(3);
    expect('logicalOnly' in reply).toBe(false);
  });

  it('still records the manifest state on a canvas open', async () => {
    fs.cpSync(DBT_FIXTURE, root, { recursive: true });
    const manifest = vi.spyOn(telemetry, 'manifest');
    await openIn(buildProvider(root, false), path.join(root, '.erd-studio', 'silver', 'showcase.json'));
    expect(manifest).toHaveBeenCalledTimes(1);
  });
});
