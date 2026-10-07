/**
 * Draw from dbt in a project that keeps relationships in the model library
 * (#126 / #133 review): a model file it would read that cannot be read, or
 * would save while it is open with unsaved changes, stops the command by name
 * before anything is written — as the canvas's Add models from dbt does —
 * instead of putting the relationship in the diagram file without a word.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { _resetMockWorkspace, type MockTextDocument } from '../__mocks__/vscode';
import type { DbtDraft } from '../../src/services/dbtDraft';

const state = vi.hoisted(() => ({ draft: undefined as unknown }));

vi.mock('../../src/services/dbtDraft', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/dbtDraft')>()),
  listDraftModels: () => [{ name: 'x' }],
  listDraftScopes: () => [],
  buildDbtDraft: () => state.draft,
}));
vi.mock('../../src/providers/dbtDraftPicker', () => ({
  pickDraftScope: async () => ({ scope: { label: 'All models', suggestedLayer: 'silver' }, modelNames: ['x'] }),
}));

import { drawFromDbt, type DrawFromDbtDeps } from '../../src/commands/drawFromDbt';
import { LogicalModelService } from '../../src/services/logicalModelService';

let tmp: string;
let models: LogicalModelService;

const col = (name: string, extra: Record<string, unknown> = {}) => ({ name, dataType: 'string', description: '', ...extra });

function deps(): DrawFromDbtDeps {
  return {
    workspaceRoot: tmp,
    semanticDir: '.erd-studio',
    modelPaths: ['models'],
    layerService: {
      getValidLayerIds: () => ['silver'],
      getCreatableLayers: () => [{ id: 'silver', label: 'Silver' }],
      getAllLayers: () => [],
      saveConfig: async () => undefined,
    } as unknown as DrawFromDbtDeps['layerService'],
    // No domain file holds a relationship: the project keeps them in the library.
    domainService: { listDomains: () => [], countDomainFileRelationships: () => 0 },
    logicalModelService: models,
    loadDbt: async () => ({}),
    validateDomainName: () => undefined,
    onWritten: () => undefined,
  } as unknown as DrawFromDbtDeps;
}

const domainFile = (): string => path.join(tmp, '.erd-studio', 'silver', 'orders.json');

beforeEach(() => {
  _resetMockWorkspace();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-draw-lib-'));
  models = new LogicalModelService(tmp, '.erd-studio');
  vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('orders');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Draw from dbt — library relationships', () => {
  it('refuses, naming the file, when a model it would read cannot be read — and writes nothing', async () => {
    models.saveModel({ name: 'dim_customer', columns: [col('customer_key', { isPrimaryKey: true })] });
    fs.writeFileSync(models.modelPath('dim_customer'), 'name: dim_customer\ndescription: Orders: one: row\ncolumns: []\n');
    const fct = { name: 'fct_order', columns: [col('customer_key')] };
    state.draft = {
      modelNames: ['fct_order', 'dim_customer'], newModels: [fct], reusedModels: ['dim_customer'],
      relationships: [{ fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' }],
      skipped: [], truncated: false,
    } satisfies DbtDraft;
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);

    await expect(drawFromDbt(deps())).resolves.toBeUndefined();

    expect(String(error.mock.calls[0][0])).toMatch(/logical-models\/dim_customer\.yml has a YAML error on line \d+\. Fix the file first, then try again\. Nothing was written\./);
    expect(fs.existsSync(domainFile())).toBe(false);
    expect(fs.existsSync(models.modelPath('fct_order'))).toBe(false);
  });

  it('refuses, naming the file, when it would save a relationship into a model open with unsaved changes', async () => {
    models.saveModel({ name: 'dim_customer', columns: [col('customer_key', { isPrimaryKey: true }), col('region_key')] });
    const before = fs.readFileSync(models.modelPath('dim_customer'), 'utf-8');
    const open = await vscode.workspace.openTextDocument(models.modelPath('dim_customer')) as unknown as MockTextDocument;
    open._setText(`${before}# typing…\n`);
    state.draft = {
      modelNames: ['dim_customer', 'dim_region'], newModels: [{ name: 'dim_region', columns: [col('region_key', { isPrimaryKey: true })] }],
      reusedModels: ['dim_customer'],
      relationships: [{ fromModel: 'dim_customer', fromColumn: 'region_key', toModel: 'dim_region', toColumn: 'region_key', cardinality: 'many-to-one' }],
      skipped: [], truncated: false,
    } satisfies DbtDraft;
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);

    await drawFromDbt(deps());

    expect(String(error.mock.calls[0][0])).toContain('logical-models/dim_customer.yml has unsaved changes. Save or revert it first, then try again.');
    expect(fs.existsSync(domainFile())).toBe(false);
    expect(fs.readFileSync(models.modelPath('dim_customer'), 'utf-8')).toBe(before);
  });
});

describe('Draw from dbt — a model file the save would refuse (#133 review)', () => {
  const regionDraft = (): DbtDraft => ({
    modelNames: ['dim_customer', 'dim_region'], newModels: [{ name: 'dim_region', columns: [col('region_key', { isPrimaryKey: true })] }],
    reusedModels: ['dim_customer'],
    relationships: [{ fromModel: 'dim_customer', fromColumn: 'region_key', toModel: 'dim_region', toColumn: 'region_key', cardinality: 'many-to-one' }],
    skipped: [], truncated: false,
  });

  it.each([
    ['a mapping', 'relationships:\n  foo: bar\n'],
    ['an alias of another list', 'other: &shared []\nrelationships: *shared\n'],
  ])('stops before writing anything when "relationships:" is %s', async (_label, tail) => {
    models.saveModel({ name: 'dim_customer', columns: [col('customer_key', { isPrimaryKey: true }), col('region_key')] });
    const file = models.modelPath('dim_customer');
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf-8')}${tail}`);
    const before = fs.readFileSync(file, 'utf-8');
    expect(models.getModel('dim_customer')).not.toBeNull();
    expect(models.getModelFileError('dim_customer')).toBeNull();
    state.draft = regionDraft();
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    const written = vi.fn();

    await expect(drawFromDbt({ ...deps(), onWritten: written })).resolves.toBeUndefined();

    expect(String(error.mock.calls[0][0])).toMatch(/Cannot save the new relationship into logical-models\/dim_customer\.yml\. .*Nothing was written\./);
    expect(fs.existsSync(domainFile())).toBe(false);
    expect(fs.existsSync(path.join(tmp, '.erd-studio', 'logical-models', 'dim_region.yml'))).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    expect(written).not.toHaveBeenCalled();
  });

  it('puts back everything it wrote when a write fails after the diagram file landed', async () => {
    models.saveModel({ name: 'dim_customer', columns: [col('customer_key', { isPrimaryKey: true }), col('region_key')] });
    const file = models.modelPath('dim_customer');
    const before = fs.readFileSync(file, 'utf-8');
    state.draft = regionDraft();
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    vi.spyOn(models, 'writeModelText').mockImplementationOnce(() => { throw new Error('disk full'); });

    await drawFromDbt(deps());

    expect(String(error.mock.calls[0][0])).toBe('Draw from dbt could not write the diagram: disk full Nothing was written.');
    expect(fs.existsSync(domainFile())).toBe(false);
    expect(fs.existsSync(path.join(tmp, '.erd-studio', 'logical-models', 'dim_region.yml'))).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });
});
