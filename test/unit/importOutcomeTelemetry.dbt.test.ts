/**
 * Import from dbt's import outcome (`importOutcomeTelemetry.ts`): the draft's
 * ledger read once the draft is ready (never on a redraw), failed when the
 * project gives nothing to draw or the run throws, never on the automatic
 * draft's quiet early end. Off the onboarding trail (`featureQuiet`).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const state = vi.hoisted(() => ({ models: [] as { name: string }[], pick: undefined as unknown, drawn: undefined as unknown }));

vi.mock('../../src/services/dbtDraft', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/dbtDraft')>();
  return {
    ...actual,
    listDraftModels: () => state.models,
    listDraftScopes: () => [],
    buildDbtDraft: (...args: Parameters<typeof actual.buildDbtDraft>) => (state.drawn ?? actual.buildDbtDraft(...args)) as ReturnType<typeof actual.buildDbtDraft>,
  };
});
vi.mock('../../src/services/draftModel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/draftModel')>();
  return { ...actual, draftFromDbt: () => ({ id: 'draft' }), dbtDraftFingerprint: () => 'plan' };
});
vi.mock('../../src/providers/dbtDraftPicker', () => ({ pickDraftScope: async () => state.pick }));

import { drawFromDbt, type DrawFromDbtDeps } from '../../src/commands/drawFromDbt';
import { createLedger } from '../../src/services/importLedger';
import { telemetry } from '../../src/services/telemetryService';
import { fakeDraftPreview } from './helpers/draftDriver';
import type { Draft } from '../../src/types/draft';

let tmp: string;
let quietKeys: ReturnType<typeof vi.spyOn>;
const outcomes = (): string[] => quietKeys.mock.calls.map((c: unknown[]) => c[0] as string);

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
    subjectAreaService: { listSubjectAreas: () => [], countSubjectAreaFileRelationships: () => 0 } as unknown as DrawFromDbtDeps['subjectAreaService'],
    tableLibraryService: {
      tableExists: () => false,
      saveTable: () => undefined,
      groupsByFolder: () => false,
      deleteTable: () => undefined,
      listTables: () => [],
      hasUnreadableRelationships: () => false,
      tablePath: (name: string) => path.join(tmp, '.erd-studio', 'logical-models', `${name}.yml`),
      getTablesDir: () => path.join(tmp, '.erd-studio', 'logical-models'),
      getTable: () => undefined,
      serializeTable: () => '',
    } as unknown as DrawFromDbtDeps['tableLibraryService'],
    loadDbt: async () => ({}),
    validateDomainName: () => undefined,
    onWritten: () => undefined,
    ...overrides,
  };
}

/** A drawn draft whose ledger met two cause classes. */
function drawnWithLedger() {
  const ledger = createLedger();
  ledger.skipped('relationship', 'notInFiles', 'link to a source', { table: 'fct_order', column: 'customer_id' });
  ledger.changed('relationship', 'savedOptional', 'NOT NULL foreign key', undefined, 'saved as optional (>?)', 3);
  return { modelNames: ['dim_customer'], newModels: [], reusedModels: ['dim_customer'], relationships: [], skipped: [], truncated: false, ledger: ledger.entries };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbt-outcome-'));
  state.models = [{ name: 'dim_customer' }];
  state.pick = { scope: { label: 'All models', suggestedLayer: 'silver', kind: 'all' }, modelNames: ['dim_customer'] };
  state.drawn = undefined;
  quietKeys = vi.spyOn(telemetry, 'featureQuiet');
  vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('sales');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Import from dbt — its outcome', () => {
  it('a draft that is ready: clean, with the draft ledger\'s cause classes, counted once whatever the answer', async () => {
    state.drawn = drawnWithLedger();
    const preview = fakeDraftPreview(['discard']);
    await drawFromDbt(deps({ draft: { preview, trigger: 'palette' } }));
    expect(preview.drafts).toHaveLength(1);
    expect(outcomes()).toEqual(['importOutcomeDbtClean', 'importCauseNotInFiles', 'importCauseSavedOptional']);
  });

  it('a redraw of the draft is not counted again', async () => {
    state.drawn = drawnWithLedger();
    const preview = fakeDraftPreview(['discard']);
    await drawFromDbt(deps({ draft: { preview, trigger: 'palette' } }), {
      pick: state.pick as never, layer: 'silver', name: 'sales',
      redraw: { fingerprint: 'another plan', settle: () => {}, draft: {} as Draft },
    });
    expect(outcomes()).toEqual([]);
  });

  it('a redraw that then finds nothing, or throws, adds no second outcome (the draft was counted)', async () => {
    const resume = () => ({
      pick: state.pick as never, layer: 'silver', name: 'sales',
      redraw: { fingerprint: 'another plan', settle: () => {}, draft: {} as Draft },
    });
    state.models = [];
    await drawFromDbt(deps({ draft: { preview: fakeDraftPreview(['discard']), trigger: 'palette' } }), resume());
    state.models = [{ name: 'dim_customer' }];
    state.drawn = { ...drawnWithLedger(), modelNames: [] };
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    await drawFromDbt(deps({ draft: { preview: fakeDraftPreview(['discard']), trigger: 'palette' } }), resume());
    const boom = new Error('boom');
    await expect(drawFromDbt(deps({ loadDbt: async () => { throw boom; }, draft: { preview: fakeDraftPreview(['discard']), trigger: 'palette' } }), resume())).rejects.toBe(boom);
    expect(outcomes()).toEqual([]);
  });

  it('no models, or none drawable: failed (with the ledger it had)', async () => {
    state.models = [];
    await drawFromDbt(deps());
    state.models = [{ name: 'dim_customer' }];
    state.drawn = { ...drawnWithLedger(), modelNames: [] };
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    await drawFromDbt(deps());
    expect(outcomes()).toEqual([
      'importOutcomeDbtFail',
      'importOutcomeDbtFail', 'importCauseNotInFiles', 'importCauseSavedOptional',
    ]);
  });

  it('a throw before the draft: failed once, and rethrown', async () => {
    const boom = new Error('boom');
    await expect(drawFromDbt(deps({ loadDbt: async () => { throw boom; } }))).rejects.toBe(boom);
    expect(outcomes()).toEqual(['importOutcomeDbtFail']);
  });

  it('the automatic draft\'s quiet early end, and a closed picker, are no outcome', async () => {
    state.models = [];
    await drawFromDbt(deps({ draft: { preview: fakeDraftPreview(), trigger: 'sidebar', quiet: true, quietDrop: () => {} } }));
    state.models = [{ name: 'dim_customer' }];
    state.pick = undefined;
    await drawFromDbt(deps());
    expect(outcomes()).toEqual([]);
  });
});
