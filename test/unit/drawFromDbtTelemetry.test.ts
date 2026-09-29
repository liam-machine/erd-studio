/**
 * Getting-started telemetry for Draw from dbt: the funnel start, each place a
 * user can stop (a feature), and a throw (an error, rethrown unchanged).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const draft = vi.hoisted(() => ({ models: [] as { name: string }[], pick: undefined as unknown }));

vi.mock('../../src/services/dbtDraft', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/dbtDraft')>()),
  listDraftModels: () => draft.models,
  listDraftScopes: () => [],
}));
vi.mock('../../src/providers/dbtDraftPicker', () => ({ pickDraftScope: async () => draft.pick }));

import { drawFromDbt, type DrawFromDbtDeps } from '../../src/commands/drawFromDbt';
import { telemetry } from '../../src/services/telemetryService';

let tmp: string;

function deps(overrides: Partial<DrawFromDbtDeps> = {}): DrawFromDbtDeps {
  return {
    workspaceRoot: tmp,
    semanticDir: '.erd-studio',
    modelPaths: ['models'],
    layerService: {
      getValidLayerIds: () => ['silver', 'gold'],
      getCreatableLayers: () => [{ id: 'silver', label: 'Silver' }, { id: 'gold', label: 'Gold' }],
      getAllLayers: () => [],
      saveConfig: async () => undefined,
    } as unknown as DrawFromDbtDeps['layerService'],
    domainService: { listDomains: () => [] },
    logicalModelService: {
      modelExists: () => false,
      saveModel: () => undefined,
      groupsByFolder: () => false,
      deleteModel: () => undefined,
    } as unknown as DrawFromDbtDeps['logicalModelService'],
    loadDbt: async () => ({}),
    validateDomainName: () => undefined,
    onWritten: () => undefined,
    ...overrides,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-draw-tel-'));
  draft.models = [{ name: 'dim_customer' }];
  draft.pick = { scope: { label: 'All models', suggestedLayer: undefined }, modelNames: ['dim_customer'] };
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Draw from dbt telemetry', () => {
  it('counts the start and "no models with columns"', async () => {
    draft.models = [];
    const feature = vi.spyOn(telemetry, 'feature');
    await expect(drawFromDbt(deps())).resolves.toBeUndefined();
    expect(feature.mock.calls.map((c) => c[0])).toEqual(['drawStarted', 'drawNoModels']);
  });

  it('counts a closed model picker', async () => {
    draft.pick = undefined;
    const feature = vi.spyOn(telemetry, 'feature');
    await drawFromDbt(deps());
    expect(feature).toHaveBeenLastCalledWith('drawCancelScope');
  });

  it('counts a closed layer picker', async () => {
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
    const feature = vi.spyOn(telemetry, 'feature');
    await drawFromDbt(deps());
    expect(feature).toHaveBeenLastCalledWith('drawCancelLayer');
  });

  it('counts a closed name box', async () => {
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue({ label: 'Silver', id: 'silver' } as never);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined);
    const feature = vi.spyOn(telemetry, 'feature');
    await drawFromDbt(deps());
    expect(feature).toHaveBeenLastCalledWith('drawCancelName');
  });

  it('counts a project with no layers to draw into', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const d = deps();
    d.layerService.getCreatableLayers = () => [];
    await drawFromDbt(d);
    expect(feature).toHaveBeenLastCalledWith('drawNoLayers');
  });

  it('records an error when it throws, and rethrows', async () => {
    const error = vi.spyOn(telemetry, 'error');
    const boom = new Error('boom');
    await expect(drawFromDbt(deps({ loadDbt: async () => { throw boom; } }))).rejects.toBe(boom);
    expect(error).toHaveBeenCalledWith('drawFromDbtFailed');
  });

  it('none of the cancels is an error', async () => {
    const error = vi.spyOn(telemetry, 'error');
    draft.pick = undefined;
    await drawFromDbt(deps());
    draft.models = [];
    await drawFromDbt(deps());
    expect(error).not.toHaveBeenCalled();
  });
});
