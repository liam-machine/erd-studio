/**
 * Getting-started telemetry for Import from dbt: the funnel start, each place a
 * user can stop (a feature), and a throw (an error, rethrown unchanged).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const draft = vi.hoisted(() => ({ models: [] as { name: string }[], pick: undefined as unknown, drawn: undefined as unknown }));

vi.mock('../../src/services/dbtDraft', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/dbtDraft')>();
  return {
    ...actual,
    listDraftModels: () => draft.models,
    listDraftScopes: () => [],
    // A test's drawn draft, else the real one (which draws nothing from the empty dbt read).
    buildDbtDraft: (...args: Parameters<typeof actual.buildDbtDraft>) => (draft.drawn ?? actual.buildDbtDraft(...args)) as ReturnType<typeof actual.buildDbtDraft>,
  };
});
vi.mock('../../src/providers/dbtDraftPicker', () => ({ pickDraftScope: async () => draft.pick }));

import { drawFromDbt, type DrawFromDbtDeps } from '../../src/commands/drawFromDbt';
import { telemetry } from '../../src/services/telemetryService';
import type { DraftPreview } from '../../src/types/draft';

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
    subjectAreaService: { listSubjectAreas: () => [] },
    tableLibraryService: {
      tableExists: () => false,
      saveTable: () => undefined,
      groupsByFolder: () => false,
      deleteTable: () => undefined,
    } as unknown as DrawFromDbtDeps['tableLibraryService'],
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
  draft.drawn = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Import from dbt telemetry', () => {
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

describe('Import from dbt: why a quiet draft was dropped, and the project stops (telemetry 2.0 B7, B9)', () => {
  const quiet = () => {
    const drops: string[] = [];
    return { drops, draft: { preview: {} as DraftPreview, trigger: 'sidebar' as const, quiet: true, quietDrop: (reason: string) => { drops.push(reason); } } };
  };

  it('no models, no layer, a folder name it cannot take: each reports its reason, and only while quiet', async () => {
    const q = quiet();
    draft.models = [];
    await drawFromDbt(deps({ draft: q.draft }));
    draft.models = [{ name: 'dim_customer' }];
    const noLayers = deps({ draft: q.draft });
    noLayers.layerService.getCreatableLayers = () => [];
    const feature = vi.spyOn(telemetry, 'feature');
    await drawFromDbt(noLayers, { pick: draft.pick as never });
    await drawFromDbt(deps({ draft: q.draft, validateDomainName: () => 'not valid' }), { pick: draft.pick as never, layer: 'silver' });
    expect(q.drops).toEqual(['nothingFound', 'noLayer', 'badName']);
    // No layers is the project's state: counted, quiet or not.
    expect(feature.mock.calls.map((c) => c[0])).toContain('importStopNoLayers');

    const loud = { ...q.draft, quiet: false };
    draft.models = [];
    await drawFromDbt(deps({ draft: loud }));
    expect(q.drops).toHaveLength(3);
  });

  it('a diagram already under the name counts importStopNameTaken', async () => {
    fs.mkdirSync(path.join(tmp, '.erd-studio', 'silver'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.erd-studio', 'silver', 'sales.json'), '{}');
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue({ label: 'Silver', id: 'silver' } as never);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('sales');
    draft.drawn = { modelNames: ['dim_customer'], newModels: [], reusedModels: ['dim_customer'], relationships: [], skipped: [], truncated: false };
    const feature = vi.spyOn(telemetry, 'feature');
    await drawFromDbt(deps());
    expect(feature.mock.calls.map((c) => c[0])).toEqual(['drawStarted', 'importStopNameTaken']);
  });
});
