/**
 * Relationship health telemetry, wired (#133): the provider's relationship
 * handlers and the Move command record the right keys on the right branches,
 * through the vscode mock — and record a `relInv*` error only when the
 * self-check fails, without ever blocking the edit.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { createMockWebviewPanel, createMockTextDocument, _resetMockWorkspace, _mockWorkspaceState } from '../__mocks__/vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { moveRelationshipsToLibrary, writeFileAtomic } from '../../src/commands/moveRelationshipsToLibrary';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import { telemetry } from '../../src/services/telemetryService';
import type { Relationship, SemanticModel } from '../../src/types/semantic';

// Switches for the two failure paths no real input reaches: a self-check that
// fails, and a planner that throws something other than a refusal.
const fault = vi.hoisted(() => ({ corruptAudit: false, plannerThrows: false }));

vi.mock('../../src/services/relationshipHealth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/relationshipHealth')>();
  return {
    ...actual,
    auditRelationshipWrite: (...args: Parameters<typeof actual.auditRelationshipWrite>) => {
      const audit = actual.auditRelationshipWrite(...args);
      return fault.corruptAudit ? { ...audit, broken: ['otherLost'] } : audit;
    },
  };
});
vi.mock('../../src/services/libraryRelationships', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/libraryRelationships')>();
  return {
    ...actual,
    planRelationshipWrite: (...args: Parameters<typeof actual.planRelationshipWrite>) => {
      if (fault.plannerThrows) throw new TypeError('cannot read properties of undefined');
      return actual.planRelationshipWrite(...args);
    },
  };
});

const col = (name: string, pk = false) => ({ name, dataType: 'string', description: '', ...(pk ? { isPrimaryKey: true } : {}) });
const MODELS: SemanticModel[] = [
  { name: 'fct_order', columns: [col('order_key', true), col('customer_key'), col('store_id'), col('region'), col('region_code')] },
  { name: 'dim_customer', columns: [col('customer_key', true)] },
  { name: 'dim_store', columns: [col('store_id', true), col('region', true)] },
  { name: 'dim_region', columns: [col('region_code'), col('name')] },
  { name: 'emp', columns: [col('id', true), col('mgr')] },
];
const EDGE = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' } as const;

interface Harness {
  root: string;
  logicalModelService: LogicalModelService;
  domainPath: (name: string) => string;
  modelFile: (name: string) => string;
  open: (name: string) => Promise<{ send: (message: unknown) => Promise<void>; errors: () => string[] }>;
}

async function createHarness(options: {
  library?: Record<string, SemanticModel['relationships']>;
  domains?: Record<string, { models: string[]; relationships?: Relationship[] }>;
} = {}): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-rel-telemetry-'));
  const semanticDir = '.erd-studio';
  const layerService = new LayerService(root, semanticDir);
  const domainService = new DomainService(layerService);
  const logicalModelService = new LogicalModelService(root, semanticDir);
  domainService.setLogicalModelService(logicalModelService);
  const selectorsService = new SelectorsService(domainService, root, semanticDir);
  vi.spyOn(selectorsService, 'scheduleRegenerate').mockImplementation(() => undefined);
  for (const model of MODELS) {
    const relationships = options.library?.[model.name];
    logicalModelService.saveModel({ ...model, ...(relationships ? { relationships } : {}) });
  }
  const domainDir = path.join(root, semanticDir, 'silver');
  fs.mkdirSync(domainDir, { recursive: true });
  const domainPath = (name: string) => path.join(domainDir, `${name}.json`);
  const domains = options.domains ?? { orders: { models: MODELS.map((m) => m.name) } };
  for (const [name, d] of Object.entries(domains)) {
    fs.writeFileSync(domainPath(name), JSON.stringify({
      schemaVersion: 5, domain: name, layer: 'silver', description: '',
      logical: { models: d.models, relationships: d.relationships ?? [] },
      viewConfig: { positions: Object.fromEntries(d.models.map((m, i) => [m, { x: i * 300, y: 0 }])) },
    }, null, 2) + '\n');
  }
  const context = {
    extensionUri: vscode.Uri.file(root),
    globalState: { get: () => undefined, update: async () => undefined },
    workspaceState: { get: () => true, update: async () => undefined },
    secrets: vscode.createMockSecretStorage(),
  } as unknown as vscode.ExtensionContext;
  const provider = new SemanticEditorProvider(
    context, domainService, new ManifestService(), new YmlParserService(), new TemplateService(),
    layerService, root, selectorsService, logicalModelService, new OwnWriteTracker(),
  );
  return {
    root,
    logicalModelService,
    domainPath,
    modelFile: (name) => fs.readFileSync(logicalModelService.modelPath(name), 'utf-8'),
    open: async (name) => {
      const document = createMockTextDocument(domainPath(name), fs.readFileSync(domainPath(name), 'utf-8'), { persist: true });
      const panel = createMockWebviewPanel();
      await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as vscode.CancellationToken,
      );
      await panel._simulateMessage({ type: 'ready' });
      return {
        send: async (message) => {
          panel._postedMessages.length = 0;
          await panel._simulateMessage(message);
        },
        errors: () => panel._postedMessages
          .filter((m): m is { type: 'error'; payload: { message: string } } => (m as { type: string }).type === 'error')
          .map((m) => m.payload.message),
      };
    },
  };
}

describe('relationship telemetry — the provider', () => {
  let h: Harness;
  let usage: ReturnType<typeof vi.spyOn>;
  let broken: ReturnType<typeof vi.spyOn>;
  let feature: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetMockWorkspace();
    fault.corruptAudit = false;
    fault.plannerThrows = false;
    usage = vi.spyOn(telemetry, 'relationshipUsage');
    broken = vi.spyOn(telemetry, 'relationshipInvariants');
    feature = vi.spyOn(telemetry, 'feature');
    error = vi.spyOn(telemetry, 'error');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (h) fs.rmSync(h.root, { recursive: true, force: true });
  });

  const used = () => usage.mock.calls.flatMap((c) => c[0] as string[]);
  const errorsRecorded = () => error.mock.calls.map((c) => c[0]);

  it('a line drawn from the dimension is stored on the fact: relDragTurned, and the self-check stays silent', async () => {
    h = await createHarness();
    const canvas = await h.open('orders');
    await canvas.send({ type: 'addRelationship', payload: { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' } });
    expect(canvas.errors()).toEqual([]);
    expect(h.modelFile('fct_order')).toContain('toModel: dim_customer');
    expect(used()).toEqual(['relDragTurned']);
    expect(broken).not.toHaveBeenCalled();
  });

  it('records a role, a self-reference, a composite key and "Mark as primary key"', async () => {
    h = await createHarness();
    const canvas = await h.open('orders');
    await canvas.send({ type: 'addRelationship', payload: { fromModel: 'emp', fromColumn: 'mgr', toModel: 'emp', toColumn: 'id', cardinality: 'many-to-one', role: 'manager' } });
    await canvas.send({ type: 'addRelationship', payload: { fromModel: 'fct_order', fromColumn: 'store_id', toModel: 'dim_store', toColumn: 'store_id', cardinality: 'many-to-one', extraPairs: [{ fromColumn: 'region', toColumn: 'region' }] } });
    await canvas.send({ type: 'addRelationship', payload: { fromModel: 'fct_order', fromColumn: 'region_code', toModel: 'dim_region', toColumn: 'region_code', cardinality: 'many-to-one', markKey: { model: 'dim_region', columns: ['region_code'] } } });
    expect(canvas.errors()).toEqual([]);
    expect(used()).toEqual(expect.arrayContaining(['relRoleSet', 'relSelfReference', 'relComposite', 'relMarkKey']));
    expect(broken).not.toHaveBeenCalled();
  });

  it('⇄ refused because a key cannot be the many side: relSwapRefusedKey, not a failure', async () => {
    h = await createHarness({ library: { fct_order: [{ fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' }] } });
    const canvas = await h.open('orders');
    await canvas.send({ type: 'updateRelationship', payload: { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'many-to-one' } });
    expect(canvas.errors()[0]).toContain('can\'t be the "many" side');
    expect(feature).toHaveBeenCalledWith('relSwapRefusedKey');
    expect(errorsRecorded()).not.toContain('relHandlerFailed');
    expect(usage).not.toHaveBeenCalled();
  });

  it('a delete another diagram still draws its own copy of: relDeleteStillDrawn', async () => {
    h = await createHarness({
      library: { fct_order: [{ fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' }] },
      domains: {
        orders: { models: ['fct_order', 'dim_customer'] },
        reporting: { models: ['fct_order', 'dim_customer'], relationships: [{ ...EDGE, cardinality: 'many-to-one' }] },
      },
    });
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const canvas = await h.open('orders');
    await canvas.send({ type: 'removeRelationship', payload: EDGE });
    expect(canvas.errors()).toEqual([]);
    expect(feature).toHaveBeenCalledWith('relDeleteStillDrawn');
    expect(broken).not.toHaveBeenCalled();
  });

  it('records relInv* only when the self-check fails — and the edit still lands', async () => {
    h = await createHarness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fault.corruptAudit = true;
    const canvas = await h.open('orders');
    await canvas.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });
    expect(broken).toHaveBeenCalledWith(['otherLost']);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('relationship self-check (add): otherLost'))).toBe(true);
    // Never names a model, column or file.
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).not.toMatch(/fct_order|customer_key/);
    expect(canvas.errors()).toEqual([]);
    expect(h.modelFile('fct_order')).toContain('toModel: dim_customer');
  });

  it('an edit VS Code rejects: relWriteFailed', async () => {
    h = await createHarness();
    const canvas = await h.open('orders');
    _mockWorkspaceState.applyEditResult = false;
    await canvas.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });
    expect(errorsRecorded()).toEqual(expect.arrayContaining(['editRejected', 'relWriteFailed']));
    expect(usage).not.toHaveBeenCalled();
  });

  it('an unexpected throw: relHandlerFailed; a refusal the user is told about is not one', async () => {
    h = await createHarness();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const canvas = await h.open('orders');
    await canvas.send({ type: 'removeRelationship', payload: EDGE }); // nothing to remove: a refusal
    expect(canvas.errors()[0]).toContain('Relationship not found.');
    expect(errorsRecorded()).not.toContain('relHandlerFailed');
    fault.plannerThrows = true;
    await canvas.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });
    expect(errorsRecorded()).toContain('relHandlerFailed');
  });

  it('a relationships: list that cannot be rewritten: the service is told once, and it is not a handler failure', async () => {
    h = await createHarness();
    const file = h.logicalModelService.modelPath('fct_order');
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf-8')}relationships: not a list\n`);
    h.logicalModelService.invalidateCache();
    const refused = vi.fn();
    h.logicalModelService.onSyncRefused = refused;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const canvas = await h.open('orders');
    await canvas.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });
    expect(canvas.errors()[0]).toContain('cannot change it');
    expect(refused).toHaveBeenCalledTimes(1);
    expect(errorsRecorded()).not.toContain('relHandlerFailed');
  });

  it('on canvas open, counts the states the relationships are in', async () => {
    const state = vi.spyOn(telemetry, 'relationshipState');
    h = await createHarness({
      library: {
        fct_order: [{ fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' }],
        dim_customer: [{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' }],
      },
    });
    await h.open('orders');
    expect(state).toHaveBeenCalledTimes(1);
    expect(state.mock.calls[0][0]).toMatchObject({ storedTwice: 1, oneToManyInModelFile: 1, danglingModel: 0 });
  });
});

describe('relationship telemetry — Move Relationships', () => {
  let h: Harness;
  beforeEach(() => { _resetMockWorkspace(); });
  afterEach(() => {
    vi.restoreAllMocks();
    if (h) fs.rmSync(h.root, { recursive: true, force: true });
  });

  const acceptModal = () => vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) => {
    const options = args[1] as { modal?: boolean } | undefined;
    return options && typeof options === 'object' && options.modal ? args[args.length - 1] : undefined;
  }) as never);
  const run = (writeFile?: (filePath: string, text: string) => void) => moveRelationshipsToLibrary({
    workspaceRoot: h.root, semanticDir: '.erd-studio', domainService: new DomainService(new LayerService(h.root, '.erd-studio')),
    logicalModelService: h.logicalModelService, onWritten: async () => undefined, writeFile,
  });

  it('a one-to-many re-homed to the fact: relMoveRehomed, and the self-check stays silent', async () => {
    h = await createHarness({ library: { dim_customer: [{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' }] } });
    acceptModal();
    const usage = vi.spyOn(telemetry, 'relationshipUsage');
    const broken = vi.spyOn(telemetry, 'relationshipInvariants');
    await run();
    expect(h.modelFile('fct_order')).toContain('toModel: dim_customer');
    expect(usage).toHaveBeenCalledWith(['relMoveRehomed']);
    expect(broken).not.toHaveBeenCalled();
  });

  it('a conflict picker shown: relMoveConflictShown', async () => {
    h = await createHarness({
      domains: {
        a: { models: ['fct_order', 'dim_customer'], relationships: [{ ...EDGE, cardinality: 'many-to-one' }] },
        b: { models: ['fct_order', 'dim_customer'], relationships: [{ ...EDGE, cardinality: 'one-to-one' }] },
      },
    });
    acceptModal();
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined as never);
    const feature = vi.spyOn(telemetry, 'feature');
    await run();
    expect(feature).toHaveBeenCalledWith('relMoveConflictShown');
  });

  it('files that could not be put back after a failed write: relMoveRestoreFailed', async () => {
    h = await createHarness({
      library: { dim_customer: [{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' }] },
      domains: { orders: { models: ['fct_order', 'dim_store', 'dim_customer'], relationships: [{ fromModel: 'fct_order', fromColumn: 'store_id', toModel: 'dim_store', toColumn: 'store_id', cardinality: 'many-to-one' }] } },
    });
    acceptModal();
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    const error = vi.spyOn(telemetry, 'error');
    const domain = h.domainPath('orders');
    const original = new Map<string, string>();
    await run((filePath, text) => {
      if (!original.has(filePath)) original.set(filePath, fs.readFileSync(filePath, 'utf-8'));
      if (filePath === domain || text === original.get(filePath)) throw new Error('EACCES');
      writeFileAtomic(filePath, text);
    });
    expect(error.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['relMoveWriteFailed', 'relMoveRestoreFailed']));
  });
});
