/**
 * What Draw from dbt writes to model files that already exist: it saves them
 * straight to disk, so it must stop over a tab with unsaved edits (as a canvas
 * edit does) and keep each file's own line endings.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { createMockTextDocument, _resetMockWorkspace } from '../__mocks__/vscode';
import type { DbtDraft } from '../../src/services/dbtDraft';

const draft = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock('../../src/services/dbtDraft', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/dbtDraft')>()),
  listDraftModels: () => [{ name: 'dim_customer' }, { name: 'fct_order' }],
  listDraftScopes: () => [],
  buildDbtDraft: () => draft.value,
}));
vi.mock('../../src/providers/dbtDraftPicker', () => ({
  pickDraftScope: async () => ({ scope: { label: 'All models', suggestedLayer: 'silver' }, modelNames: ['dim_customer', 'fct_order'] }),
}));

import { drawFromDbt, type DrawFromDbtDeps } from '../../src/commands/drawFromDbt';
import { TableLibraryService } from '../../src/services/logicalModelService';

// fct_order is already in the library, written on Windows; the draw adds its link to dim_customer.
const FCT_ORDER = ['name: fct_order', 'columns:', '  - name: customer_key', '    dataType: string', ''].join('\r\n');

let tmp: string;
let lms: TableLibraryService;
let fctPath: string;

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
    subjectAreaService: { listSubjectAreas: () => [], countSubjectAreaFileRelationships: () => 0 },
    tableLibraryService: lms,
    loadDbt: async () => ({}),
    validateDomainName: () => undefined,
    onWritten: () => undefined,
  };
}

beforeEach(() => {
  _resetMockWorkspace();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-draw-writes-'));
  // A v5 project: its library folder exists (a project with none writes v6, #182).
  fs.mkdirSync(path.join(tmp, '.erd-studio', 'logical-models'), { recursive: true });
  lms = new TableLibraryService(tmp);
  lms.ensureDir();
  fctPath = lms.tablePath('fct_order');
  fs.writeFileSync(fctPath, FCT_ORDER);
  draft.value = {
    modelNames: ['dim_customer', 'fct_order'],
    newModels: [{ name: 'dim_customer', columns: [{ name: 'customer_key', dataType: 'string', description: '' }] }],
    reusedModels: ['fct_order'],
    relationships: [{ fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' }],
    skipped: [],
    truncated: false,
  } satisfies DbtDraft;
  vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('orders' as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Draw from dbt — model files it rewrites', () => {
  it('refuses, naming the file, when one is open with unsaved edits, and writes nothing', async () => {
    const tab = createMockTextDocument(fctPath, FCT_ORDER);
    tab._setText(`${FCT_ORDER}# my unsaved note\r\n`);
    (vscode.workspace.textDocuments as unknown[]).push(tab);
    const error = vi.spyOn(vscode.window, 'showErrorMessage');

    await expect(drawFromDbt(deps())).resolves.toBeUndefined();

    expect(error.mock.calls.map((c) => String(c[0]))).toEqual([
      'Draw from dbt: logical-models/fct_order.yml has unsaved changes. Save or revert it, then try again. Nothing was changed.',
    ]);
    expect(fs.readFileSync(fctPath, 'utf-8')).toBe(FCT_ORDER);
    expect(lms.tableExists('dim_customer')).toBe(false);
    expect(fs.existsSync(path.join(tmp, '.erd-studio', 'silver', 'orders.json'))).toBe(false);
    expect(tab.getText()).toBe(`${FCT_ORDER}# my unsaved note\r\n`);
  });

  it('adds the relationship to a CRLF file and keeps it CRLF', async () => {
    const error = vi.spyOn(vscode.window, 'showErrorMessage');

    await drawFromDbt(deps());

    expect(error).not.toHaveBeenCalled();
    expect(lms.getTable('fct_order')?.relationships).toEqual([
      { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
    ]);
    const text = fs.readFileSync(fctPath, 'utf-8');
    expect(text.startsWith(FCT_ORDER)).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/\n/);
  });

  it('hands the changed library table on for a refresh, as well as the new one', async () => {
    const written: Array<Parameters<DrawFromDbtDeps['onWritten']>[0]> = [];

    await drawFromDbt({ ...deps(), onWritten: (w) => { written.push(w); } });

    // fct_order's save was an own write, so the watcher skips it: open
    // diagrams holding both ends are refreshed from onWritten instead.
    expect(written).toEqual([{
      domainPath: path.join(tmp, '.erd-studio', 'silver', 'orders.json'),
      modelNames: ['dim_customer'],
      changedModelNames: ['fct_order'],
    }]);
  });

  it('says it is ERD Studio\'s problem when it cannot read the library to plan the diagram, and writes nothing', async () => {
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    const d = deps();
    d.subjectAreaService.countSubjectAreaFileRelationships = () => { throw new Error('EACCES: permission denied, scandir'); };

    await expect(drawFromDbt(d)).resolves.toBeUndefined();

    // The raw error goes to Send Feedback's report, never the toast (#189).
    expect(error.mock.calls.map((c) => String(c[0]))).toEqual([
      "Draw from dbt hit a problem in ERD Studio while reading your Table Library, so nothing was changed. This isn't something you did. Please send us a report.",
    ]);
    expect(fs.readFileSync(fctPath, 'utf-8')).toBe(FCT_ORDER);
    expect(lms.tableExists('dim_customer')).toBe(false);
  });
});
