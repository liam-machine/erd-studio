/**
 * Add Existing Model on an older-format (v4, inline-model) diagram stores a
 * dbt relationship test the way the v5 path does (#133 review, D1): one record
 * per link, read from its many side whichever end dbt declares the test on,
 * with cardinality from the unique tests, names matched without case.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { createMockTextDocument, createMockWebviewPanel, _resetMockWorkspace } from '../__mocks__/vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { ManifestData } from '../../src/types/manifest';
import type { YmlData } from '../../src/types/ymlData';

let root: string;

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-v4-add-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const col = (name: string) => ({ name, dataType: 'INT', description: '' });

describe('Add Existing Model — v4 diagram', () => {
  it('a test declared on the dimension is stored on the fact, many-to-one', async () => {
    const domainFile = path.join(root, '.erd-studio', 'silver', 'legacy.json');
    fs.mkdirSync(path.dirname(domainFile), { recursive: true });
    fs.writeFileSync(domainFile, JSON.stringify({
      schemaVersion: 4, domain: 'legacy', layer: 'silver', description: '',
      logical: { models: [{ name: 'fct_order', columns: [col('order_id'), col('customer_id')] }], relationships: [] },
      viewConfig: { positions: { fct_order: { x: 0, y: 0 } } },
    }, null, 2));

    const yml: YmlData = {
      models: new Map([['dim_customer', { name: 'dim_customer', description: '', columns: [{ name: 'customer_id', description: '' }] }]]),
      // dbt's test is declared on the dimension, naming the fact (the model name in another case).
      relationshipTests: [{ fromModel: 'dim_customer', fromColumn: 'customer_id', toModel: 'FCT_ORDER', toColumn: 'customer_id' }],
      uniqueColumns: new Map([['dim_customer', new Set(['customer_id'])]]),
      compositeUniqueGroups: new Map(),
    } as unknown as YmlData;
    const manifest = {
      models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set(),
    } as unknown as ManifestData;
    vi.spyOn(YmlParserService.prototype, 'loadYmlData').mockResolvedValue(yml);
    vi.spyOn(ManifestService.prototype, 'loadManifest').mockResolvedValue(manifest);

    const layerService = new LayerService(root, '.erd-studio');
    const domainService = new DomainService(layerService);
    const models = new LogicalModelService(root, '.erd-studio');
    domainService.setLogicalModelService(models);
    const selectorsService = new SelectorsService(domainService, root, '.erd-studio');
    vi.spyOn(selectorsService, 'scheduleRegenerate').mockImplementation(() => undefined);
    const context = {
      extensionUri: vscode.Uri.file(root),
      globalState: { get: () => undefined, update: async () => undefined },
      secrets: vscode.createMockSecretStorage(),
    } as unknown as vscode.ExtensionContext;
    const provider = new SemanticEditorProvider(
      context, domainService, new ManifestService(), new YmlParserService(), new TemplateService(),
      layerService, root, selectorsService, models, new OwnWriteTracker(),
    );
    const document = createMockTextDocument(domainFile, fs.readFileSync(domainFile, 'utf-8'), { persist: true });
    const panel = createMockWebviewPanel();
    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      panel as unknown as vscode.WebviewPanel,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as vscode.CancellationToken,
    );

    await panel._simulateMessage({ type: 'addExistingModel', payload: { modelName: 'dim_customer' } });

    const saved = JSON.parse(fs.readFileSync(domainFile, 'utf-8'));
    expect(saved.logical.models.map((m: { name: string }) => m.name)).toEqual(['fct_order', 'dim_customer']);
    expect(saved.logical.relationships).toEqual([
      { fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id', cardinality: 'many-to-one' },
    ]);
  });
});
