/**
 * The `canvasContext` message: after a logical diagram goes out, the host
 * posts each table's file and reviewers and its Table Library relationships
 * to tables not on the diagram (the whole library, not just the
 * relationships files a DBML diagram imports). Never inside the
 * DisplaySubjectArea; writes nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  _appliedEdits,
  _resetMockWorkspace,
  createMockTextDocument,
  createMockWebviewPanel,
} from '../__mocks__/vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import { CodeOwnersReader } from '../../src/services/codeOwners';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';
import type { CanvasContext } from '../../src/types/messages';

const NATIVE = path.resolve(__dirname, '../fixtures/dbml-native');
const YAML_PROJECT = path.resolve(__dirname, '../fixtures/dbt-project');

let root: string;

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
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;
  const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
  return new SemanticEditorProvider(
    context,
    subjectAreaService,
    { loadManifest: async () => empty } as unknown as ManifestService,
    { loadYmlData: async () => ({ models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map() }) } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    projectRoot,
    new SelectorsService(subjectAreaService, projectRoot, '.erd-studio'),
    tableLibraryService,
    new OwnWriteTracker(),
  );
}

async function open(provider: SemanticEditorProvider, rel: string) {
  const file = path.join(root, '.erd-studio', rel);
  const doc = createMockTextDocument(file, fs.readFileSync(file, 'utf-8'));
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  return panel;
}

const ofType = (messages: unknown[], type: string) => messages.filter((m) => (m as { type: string }).type === type);

async function contextOf(panel: ReturnType<typeof createMockWebviewPanel>, count = 1): Promise<CanvasContext> {
  await vi.waitFor(() => expect(ofType(panel._postedMessages, 'canvasContext').length).toBeGreaterThanOrEqual(count));
  return (ofType(panel._postedMessages, 'canvasContext').at(-1) as { payload: CanvasContext }).payload;
}

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-canvas-context-'));
  fs.cpSync(NATIVE, root, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('canvasContext', () => {
  it('follows the diagram: files, and the library relationships to tables not on it', async () => {
    const provider = buildProvider(root);
    const panel = await open(provider, 'silver/diagrams/staging.dbml');
    await panel._simulateMessage({ type: 'ready' });
    const context = await contextOf(panel);

    // After the diagram, never inside it.
    const types = panel._postedMessages.map((m) => (m as { type: string }).type);
    expect(types.indexOf('canvasContext')).toBeGreaterThan(types.indexOf('domainLoaded'));
    const loaded = ofType(panel._postedMessages, 'domainLoaded')[0] as { payload: Record<string, unknown> };
    expect(loaded.payload).not.toHaveProperty('tableFiles');
    expect(loaded.payload).not.toHaveProperty('offDiagram');

    expect(context.tableFiles).toEqual({
      fct_order: '.erd-studio/gold/tables/gold/fct_order.dbml',
      dim_date: '.erd-studio/silver/tables/calendar/dim_date.dbml',
    });
    // staging imports only gold.dbml and calendar.dbml, yet fct_order's Refs
    // to the Gold tables not on it are all listed (the whole library).
    expect(context.offDiagram.fct_order).toEqual([
      { otherTable: 'dim_customer', otherLayer: 'Gold', columns: 'customer_key', cardinality: 'many-to-one', direction: 'out' },
      { otherTable: 'dim_region', otherLayer: 'Gold', columns: '(region_code, country_code)', cardinality: 'many-to-one', direction: 'out' },
    ]);
    // dim_date's relationships are with itself and fct_order, both on the diagram.
    expect(context.offDiagram.dim_date).toBeUndefined();
    expect(context.owners).toBeUndefined();
    expect(_appliedEdits).toHaveLength(0);
  });

  it('names the CODEOWNERS reviewers of each table', async () => {
    fs.mkdirSync(path.join(root, '.github'));
    fs.writeFileSync(path.join(root, '.github', 'CODEOWNERS'), '.erd-studio/gold/ @acme/gold-team\n');
    const provider = buildProvider(root);
    provider.useCodeOwners(new CodeOwnersReader(() => [root]));
    const panel = await open(provider, 'silver/diagrams/staging.dbml');
    await panel._simulateMessage({ type: 'ready' });
    const context = await contextOf(panel);
    expect(context.owners).toEqual({ fct_order: '@acme/gold-team' });
  });

  it('a diagram whose tables have no relationships off it gets an empty list', async () => {
    const provider = buildProvider(root);
    const panel = await open(provider, 'gold/diagrams/sales.dbml');
    await panel._simulateMessage({ type: 'ready' });
    const context = await contextOf(panel);
    expect(context.offDiagram).toEqual({});
    expect(Object.keys(context.tableFiles).sort()).toEqual(
      ['bridge_empty', 'customer_profile', 'dim_customer', 'dim_date', 'dim_region', 'fct_order'],
    );
  });

  it('the physical stage gets none, even one still being worked out', async () => {
    const provider = buildProvider(root);
    const panel = await open(provider, 'silver/diagrams/staging.dbml');
    await panel._simulateMessage({ type: 'ready' });
    // No wait: the logical context is still being read when the switch lands.
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    await new Promise((r) => setTimeout(r, 50));
    const types = panel._postedMessages.map((m) => (m as { type: string }).type);
    const physical = panel._postedMessages.findIndex((m) => (m as { type: string; payload?: { stage?: string } }).type === 'stageData'
      && (m as { payload: { stage: string } }).payload.stage === 'physical');
    expect(physical).toBeGreaterThan(-1);
    expect(types.slice(physical)).not.toContain('canvasContext');
  });

  it('is sent again with a logical stage reply', async () => {
    const provider = buildProvider(root);
    const panel = await open(provider, 'silver/diagrams/staging.dbml');
    await panel._simulateMessage({ type: 'ready' });
    await contextOf(panel, 1);
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'logical' } });
    await contextOf(panel, 2);
  });

  it('a YAML library: a table not on the diagram whose file holds a relationship to one on it', async () => {
    fs.rmSync(root, { recursive: true, force: true });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-canvas-context-yaml-'));
    fs.cpSync(YAML_PROJECT, root, { recursive: true });
    fs.appendFileSync(path.join(root, '.erd-studio', 'logical-models', 'fct_large_table.yml'),
      'relationships:\n  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: many-to-one\n');
    const provider = buildProvider(root);
    const panel = await open(provider, 'silver/showcase.json');
    await panel._simulateMessage({ type: 'ready' });
    const context = await contextOf(panel);
    expect(context.offDiagram.dim_customer).toEqual([
      { otherTable: 'fct_large_table', columns: 'customer_key', cardinality: 'many-to-one', direction: 'in' },
    ]);
    expect(context.tableFiles.dim_customer).toBe('.erd-studio/logical-models/dim_customer.yml');
    expect(_appliedEdits).toHaveLength(0);
  });
});
