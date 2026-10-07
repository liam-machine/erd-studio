/**
 * ERD Studio: Repair Relationships… — the command (issue #133, R10).
 *
 * The dialogs and the writes around the engine: refuse unsaved files before
 * asking anything, one QuickPick per decision (Esc cancels everything), a
 * modal preview naming every file, all-or-nothing disk writes, and a read-back
 * check that puts every file back when the result is not exactly what was
 * planned. An entry the reader could not read is opened at its line.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { createMockTextDocument, _resetMockWorkspace } from '../__mocks__/vscode';
import { repairRelationships, writeFileAtomic } from '../../src/commands/repairRelationships';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { telemetry } from '../../src/services/telemetryService';

const SEMANTIC_DIR = '.erd-studio';

const DIM = [
  'name: dim_customer',
  'columns:',
  '  - name: customer_key',
  '    dataType: string',
  '    isPrimaryKey: true',
  '',
].join('\n');
const DIM_ONE_SIDED = `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n    role: buyer\n`;
const FCT = [
  'name: fct_order   # keep this comment',
  'columns:',
  '  - name: customer_key',
  '    dataType: string',
  '',
].join('\n');

interface Fixture {
  root: string;
  at: (rel: string) => string;
  read: (rel: string) => string;
  onWritten: ReturnType<typeof vi.fn>;
  run: (writeFile?: (filePath: string, text: string) => void) => Promise<void>;
}

let f: Fixture;

function fixture(files: Record<string, string>): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-repair-cmd-'));
  const at = (rel: string): string => path.join(root, SEMANTIC_DIR, rel);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
    fs.writeFileSync(at(rel), text);
  }
  const layerService = new LayerService(root, SEMANTIC_DIR);
  const domainService = new DomainService(layerService);
  const logicalModelService = new LogicalModelService(root, SEMANTIC_DIR);
  domainService.setLogicalModelService(logicalModelService);
  const onWritten = vi.fn(async () => undefined);
  return {
    root,
    at,
    read: (rel) => fs.readFileSync(at(rel), 'utf-8'),
    onWritten,
    run: (writeFile) => repairRelationships({
      workspaceRoot: root, semanticDir: SEMANTIC_DIR, domainService, logicalModelService, onWritten, writeFile,
    }),
  };
}

/** Accept the modal preview; every other information message is dismissed. */
function acceptModal() {
  return vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) => {
    const options = args[1] as { modal?: boolean } | undefined;
    return options && typeof options === 'object' && options.modal ? args[args.length - 1] : undefined;
  }) as never);
}

const texts = (spy: ReturnType<typeof vi.spyOn>): string[] => spy.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  _resetMockWorkspace();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(f.root, { recursive: true, force: true });
});

describe('Repair Relationships… — automatic fixes', () => {
  beforeEach(() => {
    f = fixture({ 'logical-models/dim_customer.yml': DIM_ONE_SIDED, 'logical-models/fct_order.yml': FCT });
  });

  it('previews every file and change, writes on confirm, and has nothing to do on a second run', async () => {
    const info = acceptModal();
    const feature = vi.spyOn(telemetry, 'feature');

    await f.run();

    const modal = info.mock.calls.find((c) => (c[1] as { modal?: boolean } | undefined)?.modal)!;
    expect(modal[0]).toBe('Repair Relationships: change 2 files?');
    const detail = (modal[1] as { detail: string }).detail;
    expect(detail).toContain('• logical-models/dim_customer.yml');
    expect(detail).toContain('• logical-models/fct_order.yml');
    expect(detail).toContain('The repair saves the files directly — use git (or your source control) to undo it.');
    expect(modal.slice(2)).toEqual(['Repair Relationships']);

    expect(f.read('logical-models/dim_customer.yml')).toBe(DIM);
    expect(f.read('logical-models/fct_order.yml')).toBe(
      `${FCT}relationships:\n  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: many-to-one\n    role: buyer\n`,
    );
    expect(f.onWritten).toHaveBeenCalledWith([]);
    expect(feature).toHaveBeenCalledWith('relMoveCompleted');
    expect(texts(info).some((t) => t.startsWith('Repair Relationships: changed 2 files.'))).toBe(true);

    info.mockClear();
    await f.run();
    expect(texts(info)).toEqual(['Repair Relationships: nothing to repair — every relationship is stored once, in its home.']);
  });

  it('writes nothing when the preview is dismissed', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const feature = vi.spyOn(telemetry, 'feature');
    await f.run();
    expect(f.read('logical-models/dim_customer.yml')).toBe(DIM_ONE_SIDED);
    expect(f.read('logical-models/fct_order.yml')).toBe(FCT);
    expect(feature).toHaveBeenCalledWith('relMoveCancelled');
    expect(f.onWritten).not.toHaveBeenCalled();
  });

  it('puts every file back when the read-back check fails', async () => {
    acceptModal();
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    const telemetryError = vi.spyOn(telemetry, 'error');
    // A writer that also touches a byte outside the relationships.
    const writeFile = (filePath: string, text: string): void => {
      writeFileAtomic(filePath, filePath.endsWith('fct_order.yml') && text !== FCT ? text.replace('keep this comment', 'oops') : text);
    };

    await f.run(writeFile);

    expect(f.read('logical-models/dim_customer.yml')).toBe(DIM_ONE_SIDED);
    expect(f.read('logical-models/fct_order.yml')).toBe(FCT);
    expect(texts(error)).toHaveLength(1);
    expect(texts(error)[0]).toContain('Repair Relationships: the result did not check out');
    expect(texts(error)[0]).toContain('logical-models/fct_order.yml: something other than its relationships changed');
    expect(texts(error)[0]).toContain('Every file was put back as it was; nothing was changed.');
    expect(telemetryError).toHaveBeenCalledWith('relMoveWriteFailed');
    expect(f.onWritten).not.toHaveBeenCalled();
  });

  it('refuses when a file changed on disk while the preview was open', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) => {
      const options = args[1] as { modal?: boolean } | undefined;
      if (!options?.modal) return undefined;
      fs.appendFileSync(f.at('logical-models/fct_order.yml'), '# edited meanwhile\n');
      return args[args.length - 1];
    }) as never);
    const error = vi.spyOn(vscode.window, 'showErrorMessage');

    await f.run();

    expect(texts(error)[0]).toContain('logical-models/fct_order.yml changed on disk while the dialog was open');
    expect(f.read('logical-models/dim_customer.yml')).toBe(DIM_ONE_SIDED);
    expect(f.read('logical-models/fct_order.yml')).toBe(`${FCT}# edited meanwhile\n`);
  });

  it('refuses before asking anything when a file it would change has unsaved edits', async () => {
    const info = acceptModal();
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    const doc = createMockTextDocument(f.at('logical-models/fct_order.yml'), FCT, { persist: true });
    doc._setText(`${FCT}# unsaved\n`);
    vscode.workspace.textDocuments.push(doc as never);

    await f.run();

    expect(texts(error)[0]).toContain('logical-models/fct_order.yml');
    expect(texts(error)[0]).toContain('then run the repair again. Nothing was changed.');
    expect(info).not.toHaveBeenCalled();
    expect(f.read('logical-models/dim_customer.yml')).toBe(DIM_ONE_SIDED);
  });

  it('names a file it cannot edit in place, changing nothing', async () => {
    fs.writeFileSync(f.at('logical-models/dim_customer.yml'),
      `${DIM}relationships: [{ fromColumn: customer_key, toModel: fct_order, toColumn: customer_key, cardinality: one-to-many }]\n`);
    acceptModal();
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    await f.run();
    expect(texts(error)[0]).toContain('logical-models/dim_customer.yml');
    expect(texts(error)[0]).toContain('Nothing was changed.');
    expect(f.read('logical-models/fct_order.yml')).toBe(FCT);
  });
});

describe('Repair Relationships… — decisions', () => {
  beforeEach(() => {
    f = fixture({
      'logical-models/dim_customer.yml': DIM_ONE_SIDED,
      'logical-models/fct_order.yml': `${FCT}relationships:\n  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: many-to-one\n`,
    });
  });

  it('asks one QuickPick per conflict, titled with its position and the relationship', async () => {
    acceptModal();
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>) =>
      items.find((i) => i.label.includes('"buyer"'))) as never);

    await f.run();

    expect(pick).toHaveBeenCalledTimes(1);
    const options = pick.mock.calls[0][1] as { title: string; placeHolder: string };
    expect(options.title).toBe('Repair Relationships (1 of 1): fct_order.customer_key → dim_customer.customer_key');
    expect(options.placeHolder).toContain('Esc cancels everything');
    expect(f.read('logical-models/dim_customer.yml')).toBe(DIM);
    expect(f.read('logical-models/fct_order.yml')).toContain('    cardinality: many-to-one\n    role: buyer\n');
  });

  it('Esc cancels everything', async () => {
    const info = acceptModal();
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined as never);
    const before = f.read('logical-models/fct_order.yml');

    await f.run();

    expect(texts(info)).toEqual(['Repair Relationships: cancelled — nothing was changed.']);
    expect(f.read('logical-models/dim_customer.yml')).toBe(DIM_ONE_SIDED);
    expect(f.read('logical-models/fct_order.yml')).toBe(before);
  });
});

describe('Repair Relationships… — entries that could not be read', () => {
  it('leaves the entry alone and opens its file at the line', async () => {
    const fct = `${FCT}relationships:\n  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: one_to_many\n`;
    f = fixture({ 'logical-models/dim_customer.yml': DIM, 'logical-models/fct_order.yml': fct });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
      (args.includes('Open File') ? 'Open File' : undefined)) as never);
    const doc = { uri: vscode.Uri.file(f.at('logical-models/fct_order.yml')) };
    const open = vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue(doc as never);
    const show = vi.spyOn(vscode.window, 'showTextDocument').mockResolvedValue(undefined as never);

    await f.run();

    expect(texts(info)[0]).toContain('nothing to repair');
    expect(texts(info)[0]).toContain('1 relationship entry in the model library could not be read and is left untouched');
    expect(texts(info)[0]).toContain('logical-models/fct_order.yml:6');
    expect((open.mock.calls[0][0] as { fsPath: string }).fsPath).toBe(f.at('logical-models/fct_order.yml'));
    const selection = (show.mock.calls[0][1] as { selection: { start: { line: number } } }).selection;
    expect(selection.start.line).toBe(5);
    expect(f.read('logical-models/fct_order.yml')).toBe(fct);
  });
});
