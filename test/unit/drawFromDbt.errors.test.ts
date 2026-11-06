/**
 * What Import from dbt says when it cannot draw (#189): plain words, whose
 * problem it is, and a button for the next step — never a raw exception or
 * an absolute path. A failure that is ERD Studio's offers Send Feedback with
 * the exception, redacted; Try Again and Choose Another Name keep the
 * models and layer the user already chose.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { createMockTextDocument, _resetMockWorkspace } from '../__mocks__/vscode';
import type { DbtDraft } from '../../src/services/dbtDraft';

const draft = vi.hoisted(() => ({ value: undefined as unknown }));
const picker = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../../src/services/dbtDraft', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/dbtDraft')>()),
  listDraftModels: () => [{ name: 'dim_customer' }, { name: 'fct_order' }],
  listDraftScopes: () => [],
  buildDbtDraft: () => draft.value,
}));
vi.mock('../../src/providers/dbtDraftPicker', () => ({
  pickDraftScope: async () => {
    picker.calls++;
    return { scope: { label: 'All models', suggestedLayer: 'silver' }, modelNames: ['dim_customer', 'fct_order'] };
  },
}));

import {
  ADD_LAYER_BUTTON,
  CHOOSE_ANOTHER_NAME_BUTTON,
  NO_LAYERS_MESSAGE,
  OPEN_FILE_BUTTON,
  OPEN_IT_BUTTON,
  SHOW_FILE_BUTTON,
  TRY_AGAIN_BUTTON,
  drawFromDbt,
  type DrawFromDbtDeps,
} from '../../src/commands/drawFromDbt';
import { DuplicateKeyWriteRefused, TableLibraryService, TableNamingWriteRefused } from '../../src/services/logicalModelService';
import { telemetry } from '../../src/services/telemetryService';

const FCT_ORDER = ['name: fct_order', 'columns:', '  - name: customer_key', '    dataType: string', ''].join('\n');
const OURS_READING =
  "Import from dbt hit a problem in ERD Studio while reading your Table Library, so nothing was changed. This isn't something you did. Please send us a report.";
const OURS_SAVING =
  "Import from dbt hit a problem in ERD Studio while saving the diagram, so nothing was changed. This isn't something you did. Please send us a report.";

let tmp: string;
let lms: TableLibraryService;
let fctPath: string;
let domainPath: string;
let shown: ReturnType<typeof vi.spyOn>;
let command: ReturnType<typeof vi.spyOn>;
let inputBox: ReturnType<typeof vi.spyOn>;

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

/** Every error message shown, with the buttons it offered. */
const toasts = () => shown.mock.calls.map((c: unknown[]) => ({ message: String(c[0]), buttons: c.slice(1) }));

/** An `fs` error as Node throws it. */
const fsError = (code: string, file: string) =>
  Object.assign(new Error(`${code}: failed, open '${file}'`), { code, path: file });

beforeEach(() => {
  _resetMockWorkspace();
  picker.calls = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-draw-errors-'));
  fs.mkdirSync(path.join(tmp, '.erd-studio', 'logical-models'), { recursive: true });
  lms = new TableLibraryService(tmp);
  lms.ensureDir();
  fctPath = lms.tablePath('fct_order');
  fs.writeFileSync(fctPath, FCT_ORDER);
  domainPath = path.join(tmp, '.erd-studio', 'silver', 'orders.json');
  draft.value = {
    modelNames: ['dim_customer', 'fct_order'],
    newModels: [{ name: 'dim_customer', columns: [{ name: 'customer_key', dataType: 'string', description: '' }] }],
    reusedModels: ['fct_order'],
    relationships: [{ fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' }],
    skipped: [],
    truncated: false,
  } satisfies DbtDraft;
  inputBox = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('orders' as never);
  shown = vi.spyOn(vscode.window, 'showErrorMessage');
  command = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Import from dbt — a failure that is ERD Studio\'s', () => {
  it('reading the library: says so without the raw error, offers Send Feedback (redacted) and Try Again', async () => {
    shown.mockResolvedValueOnce('Send Feedback' as never);
    const d = deps();
    d.subjectAreaService.countSubjectAreaFileRelationships = () => { throw new Error(`Cannot read ${tmp}/.erd-studio/x`); };

    await expect(drawFromDbt(d)).resolves.toBeUndefined();

    expect(toasts()).toEqual([{ message: OURS_READING, buttons: ['Send Feedback', TRY_AGAIN_BUTTON] }]);
    await vi.waitFor(() => expect(command).toHaveBeenCalledWith('erdStudio.reportBug', expect.objectContaining({ kind: 'bug' })));
    const prefill = command.mock.calls.find((c: unknown[]) => c[0] === 'erdStudio.reportBug')![1] as { description: string };
    expect(prefill.description).toContain('Cannot read');
    expect(prefill.description).not.toContain(tmp);
    expect(fs.readFileSync(fctPath, 'utf-8')).toBe(FCT_ORDER);
  });

  it('Try Again resumes at the name, with the models and layer already chosen', async () => {
    shown.mockResolvedValueOnce(TRY_AGAIN_BUTTON as never);
    const d = deps();
    let failures = 1;
    const count = d.subjectAreaService.countSubjectAreaFileRelationships;
    d.subjectAreaService.countSubjectAreaFileRelationships = (...args) => {
      if (failures-- > 0) throw new Error('transient');
      return count(...args);
    };

    await drawFromDbt(d);

    await vi.waitFor(() => expect(fs.existsSync(domainPath)).toBe(true));
    expect(picker.calls).toBe(1);
    expect(inputBox).toHaveBeenCalledTimes(2);
    expect((inputBox.mock.calls[1][0] as vscode.InputBoxOptions).value).toBe('orders');
  });

  it('a Try Again that fails again says so, rather than seeming to do nothing', async () => {
    shown.mockResolvedValueOnce(TRY_AGAIN_BUTTON as never);
    const d = deps();
    d.subjectAreaService.countSubjectAreaFileRelationships = () => { throw new Error('first'); };
    let loads = 0;
    d.loadDbt = async () => { if (loads++ > 0) throw new Error('manifest went away'); return {}; };

    await drawFromDbt(d);

    await vi.waitFor(() => expect(toasts()).toHaveLength(2));
    expect(toasts()[1]).toEqual({
      message: "Import from dbt hit a problem in ERD Studio while running Try Again, so nothing was changed. This isn't something you did. Please send us a report.",
      buttons: ['Send Feedback'],
    });
  });

  it('a new project: a failed draw also removes the .erd-studio folder it created', async () => {
    fs.rmSync(path.join(tmp, '.erd-studio'), { recursive: true, force: true });
    vi.spyOn(lms, 'saveTable').mockImplementation(() => { throw fsError('ENOSPC', path.join(tmp, 'x')); });
    const d = deps();
    d.layerService.saveConfig = async () => {
      fs.mkdirSync(path.join(tmp, '.erd-studio'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.erd-studio', 'layers.json'), '{}');
    };

    await drawFromDbt(d);

    expect(fs.existsSync(path.join(tmp, '.erd-studio'))).toBe(false);
    expect(toasts()[0].message).toMatch(/Nothing was changed\.$/);
  });

  it('saving the diagram: an unknown error is ours, and nothing is left behind', async () => {
    const save = lms.saveTable.bind(lms);
    vi.spyOn(lms, 'saveTable').mockImplementation((model, folder) => {
      save(model, folder);
      if (model.name === 'fct_order') throw new Error('something odd');
    });

    await drawFromDbt(deps());

    expect(toasts()).toEqual([{ message: OURS_SAVING, buttons: ['Send Feedback', TRY_AGAIN_BUTTON] }]);
    expect(lms.tableExists('dim_customer')).toBe(false);
    expect(fs.existsSync(domainPath)).toBe(false);
  });

  // EEXIST from anything but the diagram file is not "that name is taken".
  it('a layer folder that is a file is not mistaken for a diagram name in use', async () => {
    fs.mkdirSync(path.join(tmp, '.erd-studio'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.erd-studio', 'silver'), '');

    await drawFromDbt(deps());

    expect(toasts()).toEqual([{ message: OURS_SAVING, buttons: ['Send Feedback', TRY_AGAIN_BUTTON] }]);
    expect(lms.tableExists('dim_customer')).toBe(false);
  });
});

describe('Import from dbt — a write the environment refused', () => {
  it('EACCES: names the folder project-relative, offers Try Again, and counts drawWriteFailed', async () => {
    const error = vi.spyOn(telemetry, 'error');
    vi.spyOn(lms, 'saveTable').mockImplementation(() => {
      throw fsError('EACCES', path.join(tmp, '.erd-studio', 'logical-models', 'dim_customer.yml.123.tmp'));
    });

    await drawFromDbt(deps());

    expect(toasts()).toEqual([{
      message: "Import from dbt couldn't save the diagram: ERD Studio isn't allowed to write to .erd-studio/logical-models/. " +
        "Check the folder's permissions, then try again. Nothing was changed.",
      buttons: [TRY_AGAIN_BUTTON],
    }]);
    expect(toasts()[0].message).not.toContain(tmp);
    expect(error.mock.calls.map((c) => c[0])).toEqual(['drawWriteFailed']);
  });

  it('ENOSPC: says the disk is full', async () => {
    vi.spyOn(lms, 'saveTable').mockImplementation(() => { throw fsError('ENOSPC', path.join(tmp, 'x')); });

    await drawFromDbt(deps());

    expect(toasts()).toEqual([{
      message: "Import from dbt couldn't save the diagram: the disk is full. Free up some space, then try again. Nothing was changed.",
      buttons: [TRY_AGAIN_BUTTON],
    }]);
  });

  it('a library file that fails after the diagram is written: the diagram is removed and the file put back', async () => {
    const save = lms.saveTable.bind(lms);
    vi.spyOn(lms, 'saveTable').mockImplementation((model, folder) => {
      if (model.name === 'fct_order') {
        save(model, folder); // the change lands, then something after it fails
        throw fsError('EACCES', fctPath);
      }
      save(model, folder);
    });

    await drawFromDbt(deps());

    expect(fs.existsSync(domainPath)).toBe(false);
    expect(lms.tableExists('dim_customer')).toBe(false);
    expect(fs.readFileSync(fctPath, 'utf-8')).toBe(FCT_ORDER);
    expect(toasts()[0].message).toMatch(/Nothing was changed\.$/);
  });
});

describe('Import from dbt — a refusal over the user\'s file', () => {
  it('keeps the refusal\'s words and opens the file at its line', async () => {
    shown.mockResolvedValueOnce(OPEN_FILE_BUTTON as never);
    const show = vi.spyOn(vscode.window, 'showTextDocument');
    vi.spyOn(lms, 'serializeTable').mockImplementation(() => {
      throw new DuplicateKeyWriteRefused('fct_order.yml, line 2: "columns" is written twice in one block.', { filePath: fctPath, line: 2 });
    });

    await drawFromDbt(deps());

    expect(toasts()).toEqual([{
      message: 'Import from dbt: fct_order.yml, line 2: "columns" is written twice in one block. Nothing was changed.',
      buttons: [OPEN_FILE_BUTTON],
    }]);
    await vi.waitFor(() => expect(show).toHaveBeenCalled());
    expect(show.mock.calls[0][1]).toMatchObject({ selection: { start: { line: 1, character: 0 } } });
  });

  it('a table file with both namings is the user\'s to fix, not a report to send', async () => {
    vi.spyOn(lms, 'serializeTable').mockImplementation(() => {
      throw new TableNamingWriteRefused('logical-models/fct_order.yml holds both "modelRole" and "tableRole".', { filePath: fctPath });
    });

    await drawFromDbt(deps());

    expect(toasts()).toEqual([{
      message: 'Import from dbt: logical-models/fct_order.yml holds both "modelRole" and "tableRole". Nothing was changed.',
      buttons: [OPEN_FILE_BUTTON],
    }]);
  });
});

describe('Import from dbt — the next step as a button', () => {
  it('no layers: Add Layer runs erdStudio.addLayer', async () => {
    shown.mockResolvedValueOnce(ADD_LAYER_BUTTON as never);
    const d = deps();
    d.layerService.getCreatableLayers = () => [];

    await drawFromDbt(d);

    expect(toasts()).toEqual([{ message: NO_LAYERS_MESSAGE, buttons: [ADD_LAYER_BUTTON] }]);
    await vi.waitFor(() => expect(command).toHaveBeenCalledWith('erdStudio.addLayer'));
  });

  it('a model file with unsaved changes: Show File opens it', async () => {
    shown.mockResolvedValueOnce(SHOW_FILE_BUTTON as never);
    const show = vi.spyOn(vscode.window, 'showTextDocument');
    const tab = createMockTextDocument(fctPath, FCT_ORDER);
    tab._setText(`${FCT_ORDER}# unsaved\n`);
    (vscode.workspace.textDocuments as unknown[]).push(tab);

    await drawFromDbt(deps());

    expect(toasts()).toEqual([{
      message: 'Import from dbt: logical-models/fct_order.yml has unsaved changes. Save or revert it, then try again. Nothing was changed.',
      buttons: [SHOW_FILE_BUTTON],
    }]);
    await vi.waitFor(() => expect(show).toHaveBeenCalled());
    expect((show.mock.calls[0][0] as vscode.Uri).fsPath).toBe(fctPath);
  });

  it('a diagram that appeared under the chosen name: Open It, or Choose Another Name keeps the selection', async () => {
    fs.mkdirSync(path.dirname(domainPath), { recursive: true });
    fs.writeFileSync(domainPath, '{}');
    shown.mockResolvedValueOnce(CHOOSE_ANOTHER_NAME_BUTTON as never);
    inputBox.mockResolvedValueOnce('orders' as never).mockResolvedValueOnce('orders-2' as never);

    await drawFromDbt(deps());

    expect(toasts()[0]).toEqual({
      message: 'A diagram named "orders" already exists in the Silver layer.',
      buttons: [OPEN_IT_BUTTON, CHOOSE_ANOTHER_NAME_BUTTON],
    });
    await vi.waitFor(() => expect(fs.existsSync(path.join(path.dirname(domainPath), 'orders-2.json'))).toBe(true));
    expect(picker.calls).toBe(1);
    expect(fs.readFileSync(domainPath, 'utf-8')).toBe('{}');
  });
});
