/**
 * ERD Studio: Repair Relationships… — the command (issue #133, R10).
 *
 * The dialogs and the writes around the engine: no questions — refuse unsaved
 * files before the preview, one modal preview naming every file and every
 * relationship left for the user (one confirm button; Cancel writes
 * nothing), all-or-nothing disk writes, and a read-back check that puts every
 * file back when the result is not exactly what was planned. What is left is
 * listed with Open File, which lands on the entry's line.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { createMockTextDocument, _resetMockWorkspace } from '../__mocks__/vscode';
import { repairRelationships, runMoveRelationships, unwritableFiles, writeFileAtomic } from '../../src/commands/repairRelationships';
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

  it('refuses, naming what happened, when a relationship in a file it does not change was edited while the preview was open (#133 review 8)', async () => {
    fs.writeFileSync(f.at('logical-models/dim_date.yml'), 'name: dim_date\ncolumns:\n  - name: date_key\n    dataType: date\n    isPrimaryKey: true\n');
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) => {
      const options = args[1] as { modal?: boolean } | undefined;
      if (!options?.modal) return undefined;
      // Another diagram adds a relationship to a model the repair does not touch.
      fs.appendFileSync(f.at('logical-models/dim_date.yml'),
        'relationships:\n  - fromColumn: date_key\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: many-to-one\n');
      return args[args.length - 1];
    }) as never);
    const error = vi.spyOn(vscode.window, 'showErrorMessage');

    await f.run();

    expect(texts(error)).toEqual([
      'Repair Relationships: relationships in the project changed while the dialog was open. Run the repair again. Nothing was changed.',
    ]);
    expect(f.read('logical-models/dim_customer.yml')).toBe(DIM_ONE_SIDED);
    expect(f.read('logical-models/fct_order.yml')).toBe(FCT);
  });

  it('a second run while the first is still asking is refused, not started (#133 review 8)', async () => {
    let release: (value: unknown) => void = () => undefined;
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) => {
      const options = args[1] as { modal?: boolean } | undefined;
      if (!options?.modal) return undefined;
      return new Promise((resolve) => { release = () => resolve(args[args.length - 1]); });
    }) as never);
    const first = f.run();
    await new Promise((r) => setTimeout(r, 0));
    await f.run();
    expect(texts(info)).toContain('Repair Relationships is already running — confirm or cancel its preview first.');
    release(undefined);
    await first;
    expect(f.read('logical-models/dim_customer.yml')).toBe(DIM);
    // Once it has finished, the command runs again as usual.
    info.mockClear();
    await f.run();
    expect(texts(info).some((t) => t.startsWith('Repair Relationships: nothing to repair'))).toBe(true);
  });

  it('Show Full Diff… opens the diff and asks without a modal, so the diff can be read; the preview tab is closed after (#133 review 8)', async () => {
    const registration = { dispose: vi.fn() };
    (vscode.workspace as unknown as { registerTextDocumentContentProvider: unknown }).registerTextDocumentContentProvider = vi.fn(() => registration);
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
    const picks: Array<{ labels: string[]; ignoreFocusOut?: boolean }> = [];
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string; index?: number }>, options?: { ignoreFocusOut?: boolean }) => {
      picks.push({ labels: items.map((i) => i.label), ignoreFocusOut: options?.ignoreFocusOut });
      // The file picker (items carry an index), then the question asked while the diff is open.
      return items[0].index !== undefined ? items[0] : items.find((i) => i.label === 'Repair Relationships');
    }) as never);
    const close = vi.fn(async () => true);
    const previewTab = { input: { modified: { scheme: 'erd-studio-repair-preview', path: '/0/fct_order.yml' } } };
    (vscode.window as unknown as { tabGroups: unknown }).tabGroups = { all: [{ tabs: [previewTab, { input: {} }] }], close, activeTabGroup: { activeTab: undefined } };
    const calls: Array<{ modal: boolean; buttons: unknown[] }> = [];
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) => {
      const options = args[1] as { modal?: boolean } | undefined;
      const modal = !!(options && typeof options === 'object' && options.modal);
      const buttons = args.slice(modal ? 2 : 1);
      calls.push({ modal, buttons });
      if (modal) return 'Show Full Diff…';
      return buttons.includes('Repair Relationships') ? 'Repair Relationships' : undefined;
    }) as never);

    try {
      await f.run();
    } finally {
      delete (vscode.workspace as unknown as { registerTextDocumentContentProvider?: unknown }).registerTextDocumentContentProvider;
      (vscode.window as unknown as { tabGroups: unknown }).tabGroups = { all: [], activeTabGroup: { activeTab: undefined } };
    }

    expect(exec).toHaveBeenCalledWith('vscode.diff', expect.anything(), expect.anything(), expect.stringContaining('now ↔ after the change'), { preview: true });
    // One modal (the preview), then the question while the diff is open is
    // not modal — and not a notification either, which hides itself after a
    // few seconds while the diff is read: a QuickPick that stays on screen.
    expect(calls[0]).toEqual({ modal: true, buttons: ['Show Full Diff…', 'Repair Relationships'] });
    expect(calls.slice(1).filter((c) => c.buttons.includes('Repair Relationships'))).toEqual([]);
    expect(picks.at(-1)).toEqual({ labels: ['Repair Relationships', 'Show Another File…', 'Cancel'], ignoreFocusOut: true });
    expect(f.read('logical-models/dim_customer.yml')).toBe(DIM);
    expect(close).toHaveBeenCalledWith([previewTab]);
    expect(registration.dispose).toHaveBeenCalled();
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

  it('refuses before the preview when the file a relationship turned round is written to has unsaved edits', async () => {
    const fctWithKey = FCT.replace('    dataType: string', '    dataType: string\n    isForeignKey: true');
    fs.writeFileSync(f.at('logical-models/fct_order.yml'), fctWithKey);
    // The 1.6.7 shape: stored in the dimension's file, turned round into fct_order.yml, which holds no copy today.
    fs.writeFileSync(f.at('logical-models/dim_customer.yml'),
      `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: many-to-one\n`);
    const info = acceptModal();
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    const doc = createMockTextDocument(f.at('logical-models/fct_order.yml'), fctWithKey, { persist: true });
    doc._setText(`${fctWithKey}# unsaved\n`);
    vscode.workspace.textDocuments.push(doc as never);

    await f.run();

    expect(texts(error)).toHaveLength(1);
    expect(texts(error)[0]).toContain('logical-models/fct_order.yml');
    expect(texts(error)[0]).toContain('Nothing was changed.');
    expect(info.mock.calls.some((c) => (c[1] as { modal?: boolean } | undefined)?.modal)).toBe(false);
    expect(f.read('logical-models/fct_order.yml')).toBe(fctWithKey);
  });

  it('names a file it cannot edit in place, changing nothing — listed, not an error', async () => {
    fs.writeFileSync(f.at('logical-models/dim_customer.yml'),
      `${DIM}relationships: [{ fromColumn: customer_key, toModel: fct_order, toColumn: customer_key, cardinality: one-to-many }]\n`);
    acceptModal();
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    const warn = vi.spyOn(vscode.window, 'showWarningMessage');
    await f.run();
    // Reported as left, by name — never an error that throws away every
    // other fix of the run (#133 review).
    expect(texts(error)).toEqual([]);
    expect(texts(warn)).toEqual([]);
    expect(texts(info)).toEqual([
      'Repair Relationships: nothing it can fix on its own. 1 relationship needs your attention and was left as it was: ' +
      'fct_order.customer_key → dim_customer.customer_key: ' +
      'logical-models/dim_customer.yml: "relationships:" is not a list with one "- " entry per line — left as it is; change it by hand.',
    ]);
    expect(info.mock.calls[0].slice(1)).toEqual(['Open File']);
    expect(f.read('logical-models/fct_order.yml')).toBe(FCT);
  });
});

describe('Repair Relationships… — what needs a decision is listed, never asked', () => {
  const FCT_WITH_COPY = `${FCT}relationships:\n  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: many-to-one\n`;
  beforeEach(() => {
    // The dimension's one-sided copy says "buyer"; the fact's does not: they disagree.
    f = fixture({ 'logical-models/dim_customer.yml': DIM_ONE_SIDED, 'logical-models/fct_order.yml': FCT_WITH_COPY });
  });

  it('asks no question, writes nothing, and says what needs attention with Open File at the entry', async () => {
    const pick = vi.spyOn(vscode.window, 'showQuickPick');
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
      (args.includes('Open File') ? 'Open File' : undefined)) as never);
    const open = vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue({} as never);
    const show = vi.spyOn(vscode.window, 'showTextDocument').mockResolvedValue(undefined as never);

    await f.run();

    expect(pick).not.toHaveBeenCalled();
    expect(info.mock.calls.some((c) => (c[1] as { modal?: boolean } | undefined)?.modal)).toBe(false);
    expect(texts(info)).toEqual([expect.stringMatching(
      /^Repair Relationships: nothing it can fix on its own\. 1 relationship needs your attention and was left as it was: fct_order\.customer_key → dim_customer\.customer_key: its copies disagree/,
    )]);
    expect(f.read('logical-models/dim_customer.yml')).toBe(DIM_ONE_SIDED);
    expect(f.read('logical-models/fct_order.yml')).toBe(FCT_WITH_COPY);
    expect((open.mock.calls[0][0] as { fsPath: string }).fsPath).toBe(f.at('logical-models/dim_customer.yml'));
    const selection = (show.mock.calls[0][1] as { selection: { start: { line: number } } }).selection;
    expect(selection.start.line).toBe(6);
  });

  it('lists it in the preview beside the automatic fixes; Open File… there writes nothing and opens the file', async () => {
    fs.writeFileSync(f.at('logical-models/dim_date.yml'), 'name: dim_date\ncolumns:\n  - name: date_key\n    dataType: date\n    isPrimaryKey: true\n');
    fs.appendFileSync(f.at('logical-models/fct_order.yml'),
      '  - fromColumn: customer_key\n    toModel: DIM_DATE\n    toColumn: date_key\n    cardinality: many-to-one\n');
    const withRespell = f.read('logical-models/fct_order.yml');
    const calls: Array<{ message: string; detail?: string; buttons: unknown[] }> = [];
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) => {
      const options = args[1] as { modal?: boolean; detail?: string } | undefined;
      const modal = !!(options && typeof options === 'object' && options.modal);
      calls.push({ message: String(args[0]), detail: modal ? options!.detail : undefined, buttons: args.slice(modal ? 2 : 1) });
      return modal ? 'Open File…' : undefined;
    }) as never);
    vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue({} as never);
    const show = vi.spyOn(vscode.window, 'showTextDocument').mockResolvedValue(undefined as never);

    await f.run();

    expect(calls[0].message).toBe('Repair Relationships: change 1 file?');
    expect(calls[0].buttons).toEqual(['Open File…', 'Repair Relationships']);
    expect(calls[0].detail).toContain('changes fct_order.customer_key → DIM_DATE.date_key to fct_order.customer_key → dim_date.date_key');
    expect(calls[0].detail).toContain('Needs your attention — not changed by this repair:\n• fct_order.customer_key → dim_customer.customer_key: its copies disagree');
    // Open File… instead of confirming: nothing is written, and the one listed item's file opens.
    expect(f.read('logical-models/fct_order.yml')).toBe(withRespell);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('Cancel writes nothing', async () => {
    fs.appendFileSync(f.at('logical-models/fct_order.yml'),
      '  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: Customer_Key\n    cardinality: many-to-many\n');
    const before = f.read('logical-models/fct_order.yml');
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    await f.run();
    expect(info.mock.calls.some((c) => (c[1] as { modal?: boolean } | undefined)?.modal)).toBe(true);
    expect(f.read('logical-models/fct_order.yml')).toBe(before);
    expect(f.read('logical-models/dim_customer.yml')).toBe(DIM_ONE_SIDED);
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

    expect(texts(info)[0]).toContain('nothing it can fix on its own');
    expect(texts(info)[0]).toContain('1 relationship entry could not be read and is left untouched');
    expect(texts(info)[0]).toContain('logical-models/fct_order.yml:6');
    expect((open.mock.calls[0][0] as { fsPath: string }).fsPath).toBe(f.at('logical-models/fct_order.yml'));
    const selection = (show.mock.calls[0][1] as { selection: { start: { line: number } } }).selection;
    expect(selection.start.line).toBe(5);
    expect(f.read('logical-models/fct_order.yml')).toBe(fct);
  });
});

describe('Repair Relationships… — the closing message (#133 review 8)', () => {
  it('a closing message left unanswered does not hold the run lock', async () => {
    const fct = `${FCT}relationships:\n  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: one_to_many\n`;
    f = fixture({ 'logical-models/dim_customer.yml': DIM, 'logical-models/fct_order.yml': fct });
    // The Open File notification is never answered (it sits in the notification centre).
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(((...args: unknown[]) =>
      (args.includes('Open File') ? new Promise(() => undefined) : Promise.resolve(undefined))) as never);
    void f.run();
    await new Promise((r) => setTimeout(r, 0));
    info.mockClear();
    void f.run();
    await new Promise((r) => setTimeout(r, 0));
    expect(texts(info).some((t) => t.includes('already running'))).toBe(false);
    expect(texts(info).some((t) => t.includes('nothing it can fix on its own'))).toBe(true);
  });

  it('names an unreadable entry at its line after the repair moved the entries above it', async () => {
    const dim = `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n` +
      '  - fromColumn: customer_key\n    toModel: fct_order\n    cardinality: many-to-one\n';
    f = fixture({ 'logical-models/dim_customer.yml': dim, 'logical-models/fct_order.yml': FCT });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) => {
      const options = args[1] as { modal?: boolean } | undefined;
      if (options && typeof options === 'object' && options.modal) return args[args.length - 1];
      return args.includes('Open File') ? 'Open File' : undefined;
    }) as never);
    const open = vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue({} as never);
    const show = vi.spyOn(vscode.window, 'showTextDocument').mockResolvedValue(undefined as never);

    await f.run();

    const after = f.read('logical-models/dim_customer.yml');
    const lines = after.split('\n');
    const entryLine = lines.findIndex((l) => l.startsWith('  - fromColumn: customer_key')) + 1;
    expect(entryLine).toBeGreaterThan(0);
    const closing = texts(info).find((t) => t.startsWith('Repair Relationships: changed'))!;
    expect(closing).toContain(`logical-models/dim_customer.yml:${entryLine}`);
    expect(open).toHaveBeenCalled();
    const selection = (show.mock.calls[0][1] as { selection: { start: { line: number } } }).selection;
    expect(selection.start.line).toBe(entryLine - 1);
  });
});

describe('Repair Relationships… — problems it cannot reach are never an all-clear', () => {
  it('a v4 diagram with a missing column: says it cannot change it and points at the migration', async () => {
    f = fixture({
      'logical-models/dim_customer.yml': DIM,
      'gold/legacy.json': JSON.stringify({
        schemaVersion: 4, domain: 'legacy', layer: 'gold',
        logical: {
          models: [{ name: 'a', columns: [{ name: 'id', dataType: 'INT' }] }, { name: 'b', columns: [{ name: 'a_id', dataType: 'INT' }] }],
          relationships: [{ fromModel: 'b', fromColumn: 'nope', toModel: 'a', toColumn: 'id', cardinality: 'many-to-one' }],
        },
      }),
    });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    await f.run();
    expect(texts(info)).toHaveLength(1);
    expect(texts(info)[0]).not.toContain('every relationship is stored once');
    expect(texts(info)[0]).toMatch(/^Repair Relationships: nothing it can fix on its own\. Not changed: gold\/legacy\.json has 1 relationship problem but is still in the older format/);
    expect(texts(info)[0]).toContain('Migrate Domains to Central Model Store');
  });

  it('a diagram file that cannot be read is named', async () => {
    f = fixture({ 'logical-models/dim_customer.yml': DIM, 'gold/broken.json': '{ "nope' });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    await f.run();
    expect(texts(info)[0]).toMatch(/nothing it can fix on its own\. Not changed: gold\/broken\.json was not checked: it could not be read/);
  });
});

describe('Repair Relationships… — a model file it could not read is never an all-clear (#133 review)', () => {
  it('names the file and its line instead of "nothing to repair"', async () => {
    f = fixture({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': 'name: fct_order\ndescription: Orders: one: row\ncolumns: []\n',
    });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    await f.run();
    expect(texts(info)).toHaveLength(1);
    expect(texts(info)[0]).not.toContain('every relationship is stored once');
    expect(texts(info)[0]).toMatch(/^Repair Relationships: nothing it can fix on its own\. Not changed: logical-models\/fct_order\.yml was not checked: it has a YAML error on line \d+/);
  });
});

describe('Repair Relationships… — relationships it must leave for the user are all named', () => {
  it('never an all-clear while relationships are left as they are, and none goes unmentioned', async () => {
    const cols = ['c1', 'c2', 'c3', 'c4'];
    const fct = [
      'name: fct_order',
      'columns:',
      ...cols.flatMap((c) => [`  - name: ${c}`, '    dataType: string']),
      'relationships:',
      ...cols.flatMap((c) => [`  - fromColumn: ${c}`, '    toModel: dim_customer', '    toColumn: customer_key', '    cardinality: one_to_many']),
      '',
    ].join('\n');
    const dim = `${DIM}relationships:\n${cols.map((c) => `  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: ${c}\n    cardinality: one-to-many\n`).join('')}`;
    f = fixture({ 'logical-models/dim_customer.yml': dim, 'logical-models/fct_order.yml': fct });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    await f.run();
    const text = texts(info)[0];
    expect(text).toMatch(/^Repair Relationships: nothing it can fix on its own\. 4 relationships need your attention/);
    expect(text).not.toContain('every relationship is stored once');
    expect(text).toContain('fct_order.c1 → dim_customer.customer_key');
    expect(text).toContain('fct_order.c3 → dim_customer.customer_key');
    expect(text).toContain('…and 1 more.');
    // Every one of them is in the list Show Items… opens.
    expect(info.mock.calls[0].slice(1)).toEqual(['Show Items…']);
    expect(f.read('logical-models/fct_order.yml')).toBe(fct);
  });
});

describe('Repair Relationships… — a link newly defined in the model library (#133 review 6)', () => {
  it('says why, and names the diagram that will start drawing it', async () => {
    const link = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const domain = (name: string, relationships: unknown[]) => JSON.stringify({
      schemaVersion: 5, domain: name, layer: 'gold', description: '', logical: { models: ['fct_order', 'dim_customer'], relationships }, viewConfig: {},
    }, null, 2) + '\n';
    f = fixture({
      'logical-models/dim_customer.yml': DIM,
      // Library mode: a model file already holds a relationship.
      'logical-models/fct_order.yml': `${FCT}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: many-to-many\n`,
      'gold/a.json': domain('a', [link]),
      'gold/b.json': domain('b', [link]),
      'gold/c.json': domain('c', []),
    });
    const info = acceptModal();
    await f.run();
    const modal = info.mock.calls.find((c) => (c[1] as { modal?: boolean } | undefined)?.modal);
    expect(modal).toBeDefined();
    const detail = (modal![1] as { detail: string }).detail;
    expect(detail).toMatch(/^Why: a relationship stored in more than one diagram file is defined once/);
    expect(detail).toContain('• gold/c.json will also draw fct_order.customer_key → dim_customer.customer_key');
  });
});

describe('Repair Relationships… — symlinked and read-only files (#133 review)', () => {
  beforeEach(() => {
    f = fixture({ 'logical-models/dim_customer.yml': DIM_ONE_SIDED, 'shared/fct_order.yml': FCT });
    fs.symlinkSync(f.at('shared/fct_order.yml'), f.at('logical-models/fct_order.yml'));
  });

  it('writes a symlinked model file through its link: the link stays a link and its target gets the new text', async () => {
    acceptModal();
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    await f.run();
    expect(texts(error)).toEqual([]);
    expect(fs.lstatSync(f.at('logical-models/fct_order.yml')).isSymbolicLink()).toBe(true);
    expect(f.read('shared/fct_order.yml')).toContain('toModel: dim_customer');
    expect(f.read('logical-models/dim_customer.yml')).toBe(DIM);
  });

  it('refuses a read-only file before the preview, changing nothing', async () => {
    fs.chmodSync(f.at('shared/fct_order.yml'), 0o444);
    const info = acceptModal();
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    await f.run();
    expect(info.mock.calls.some((c) => (c[1] as { modal?: boolean } | undefined)?.modal)).toBe(false);
    expect(texts(error)).toHaveLength(1);
    expect(texts(error)[0]).toContain('logical-models/fct_order.yml is read-only');
    expect(texts(error)[0]).toContain('Nothing was changed.');
    expect(f.read('logical-models/dim_customer.yml')).toBe(DIM_ONE_SIDED);
    expect(f.read('shared/fct_order.yml')).toBe(FCT);
    expect(fs.statSync(f.at('shared/fct_order.yml')).mode & 0o777).toBe(0o444);
    fs.chmodSync(f.at('shared/fct_order.yml'), 0o644);
  });
});

describe('unwritableFiles (#133 review 8)', () => {
  it('refuses a writable file in a folder that is not writable (the atomic write needs a temp file there)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-repair-ro-dir-'));
    f = { root: dir } as Fixture;
    const file = path.join(dir, 'shared', 'a.yml');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, 'old');
    fs.chmodSync(path.dirname(file), 0o555);
    try {
      expect(unwritableFiles([file])).toEqual([file]);
    } finally {
      fs.chmodSync(path.dirname(file), 0o755);
    }
    expect(unwritableFiles([file])).toEqual([]);
  });
});

describe('writeFileAtomic (repair) — keeps what a rename would lose', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-repair-write-'));
    f = { root: dir } as Fixture;
  });

  it("keeps the file's permission bits", () => {
    const file = path.join(dir, 'a.json');
    fs.writeFileSync(file, 'old');
    fs.chmodSync(file, 0o640);
    writeFileAtomic(file, 'new');
    expect(fs.readFileSync(file, 'utf-8')).toBe('new');
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });

  it('refuses a read-only file instead of replacing it', () => {
    const file = path.join(dir, 'a.json');
    fs.writeFileSync(file, 'old');
    fs.chmodSync(file, 0o444);
    expect(() => writeFileAtomic(file, 'new')).toThrow('a.json is read-only');
    expect(fs.readFileSync(file, 'utf-8')).toBe('old');
    expect(fs.readdirSync(dir)).toEqual(['a.json']);
    fs.chmodSync(file, 0o644);
  });

  it('writes through a symlink, leaving the link in place', () => {
    const real = path.join(dir, 'real.json');
    const link = path.join(dir, 'link.json');
    fs.writeFileSync(real, 'old');
    fs.symlinkSync(real, link);
    writeFileAtomic(link, 'new');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf-8')).toBe('new');
  });
});

describe('Move Relationships to Model Library — the closing message names only what happened (#133 review)', () => {
  const FCT_WITH_LINK = `${FCT}relationships:\n  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: many-to-one\n`;
  const domainWithCopy = JSON.stringify({
    schemaVersion: 5, domain: 'x', layer: 'silver',
    logical: {
      models: ['dim_customer', 'fct_order'],
      relationships: [{ fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' }],
    },
    viewConfig: {},
  }, null, 2) + '\n';

  it('a run that only removed a diagram-file copy does not say it moved anything', async () => {
    f = fixture({ 'logical-models/dim_customer.yml': DIM, 'logical-models/fct_order.yml': FCT_WITH_LINK, 'silver/x.json': domainWithCopy });
    const info = acceptModal();
    const layerService = new LayerService(f.root, SEMANTIC_DIR);
    const domainService = new DomainService(layerService);
    const logicalModelService = new LogicalModelService(f.root, SEMANTIC_DIR);
    domainService.setLogicalModelService(logicalModelService);
    await runMoveRelationships({ workspaceRoot: f.root, semanticDir: SEMANTIC_DIR, domainService, logicalModelService, onWritten: f.onWritten });

    expect(JSON.parse(f.read('silver/x.json')).logical.relationships).toEqual([]);
    const closing = texts(info).filter((t) => !t.includes('?'));
    expect(closing).toHaveLength(1);
    expect(closing[0]).not.toMatch(/Moved \d+ relationship/);
    expect(closing[0]).toContain('1 diagram-file copy of library relationships removed.');
  });
});

