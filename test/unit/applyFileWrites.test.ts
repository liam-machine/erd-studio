/**
 * applyFileWrites (D23, §5.3 steps 6–7 of docs/plans/native-dbml-storage.md,
 * §9.5): one WorkspaceEdit in a fixed order — the primary replace, then
 * creates (with the semantic dir: table files, relationships files,
 * diagrams, README, anything else, §2.8), then replaces, then deletes — and, when VS Code applies only part of it
 * (the mock applies a prefix), a reconcile back to the exact prior state; a
 * reconcile that fails too names the files in a modal. The primary is a
 * full-range replace, except with `minimalPrimary` (a DBML drag only).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { _appliedEdits, _mockWorkspaceState, _resetMockWorkspace, createMockTextDocument } from '../__mocks__/vscode';
import { applyFileWrites } from '../../src/providers/applyFileWrites';
import { SEND_FEEDBACK_BUTTON, SHOW_FILES_BUTTON } from '../../src/services/commandErrors';
import type { FileWrite } from '../../src/services/fileWrites';

let root: string;
const at = (rel: string): string => path.join(root, rel);
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text);
};

/** Every file on disk, relative path → text. */
function disk(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out[path.relative(root, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf-8');
    }
  };
  walk(root);
  return out;
}

/** The primary diagram as an open, saved document. */
function primary() {
  const doc = createMockTextDocument(at('gold/diagrams/sales.dbml'), fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8'), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(doc);
  return doc;
}

function plannedWrites(): FileWrite[] {
  return [
    { kind: 'delete', path: at('gold/tables/gold/old.dbml') },
    { kind: 'replace', path: at('gold/tables/gold/fct.dbml'), text: 'Table fct {\n  id INT [pk]\n  x INT\n}\n' },
    { kind: 'create', path: at('gold/notes.md'), text: 'notes\n' },
    { kind: 'create', path: at('gold/tables/gold/new.dbml'), text: 'Table new {\n  id INT\n}\n' },
    { kind: 'delete', path: at('gold/tables/gold/older.dbml') },
    { kind: 'create', path: at('gold/relationships/gold.dbml'), text: '// rels\n' },
  ];
}

/** A semantic-relative path's op line. */
const opsOf = (edit: unknown): string[] => (edit as { _ops: Array<{ kind: string; uri: { fsPath: string } }> })._ops
  .map((op) => `${op.kind} ${path.relative(root, op.uri.fsPath).split(path.sep).join('/')}`);

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-apply-writes-'));
  write('gold/diagrams/sales.dbml', 'Project sales {\n}\n');
  write('gold/tables/gold/fct.dbml', 'Table fct {\n  id INT [pk]\n}\n');
  write('gold/tables/gold/old.dbml', 'Table old {\n  id INT\n}\n');
  write('gold/tables/gold/older.dbml', 'Table older {\n  id INT\n}\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the order of one WorkspaceEdit', () => {
  it('primary replace, creates (tables, relationships files, anything else), replaces, deletes', async () => {
    const doc = primary();
    const result = await applyFileWrites(plannedWrites(), { primary: { document: doc as unknown as vscode.TextDocument, text: 'Project sales {\n  Note: \'x\'\n}\n' }, semanticRoot: root });
    expect(result.ok).toBe(true);
    expect(_appliedEdits).toHaveLength(1);
    expect(opsOf(_appliedEdits[0])).toEqual([
      'replace gold/diagrams/sales.dbml',
      'createFile gold/tables/gold/new.dbml',
      'createFile gold/relationships/gold.dbml',
      'createFile gold/notes.md',
      'replace gold/tables/gold/fct.dbml',
      'deleteFile gold/tables/gold/old.dbml',
      'deleteFile gold/tables/gold/older.dbml',
    ]);
    expect(result.created.map((p) => path.basename(p))).toEqual(['new.dbml', 'gold.dbml', 'notes.md']);
    expect(result.deleted.map((p) => path.basename(p))).toEqual(['old.dbml', 'older.dbml']);
    expect(result.replaced.map((u) => path.basename(u.fsPath))).toEqual(['fct.dbml']);
  });

  it('a create is ranked by what the tree says the file is: a schema folder named relationships still holds tables; diagrams, then README, come after', async () => {
    const result = await applyFileWrites([
      { kind: 'create', path: at('README.md'), text: '# .erd-studio\n' },
      { kind: 'create', path: at('gold/diagrams/new.dbml'), text: 'Project new {\n}\n' },
      { kind: 'create', path: at('gold/relationships/gold.dbml'), text: '// rels\n' },
      { kind: 'create', path: at('gold/tables/relationships/x.dbml'), text: 'Table relationships.x {\n  id INT\n}\n' },
    ], { semanticRoot: root });
    expect(result.ok).toBe(true);
    expect(opsOf(_appliedEdits[0])).toEqual([
      'createFile gold/tables/relationships/x.dbml',
      'createFile gold/relationships/gold.dbml',
      'createFile gold/diagrams/new.dbml',
      'createFile README.md',
    ]);
  });
});

describe('the primary\'s range', () => {
  const primaryOp = () => (_appliedEdits[0] as unknown as { _ops: Array<{ range: { start: unknown; end: unknown }; newText: string }> })._ops[0];

  it('is the full range by default (every caller but a DBML drag, a JSON primary included)', async () => {
    write('gold/plain.json', '{\n  "a": 1\n}\n');
    const doc = createMockTextDocument(at('gold/plain.json'), fs.readFileSync(at('gold/plain.json'), 'utf-8'), { persist: true });
    const result = await applyFileWrites([], { primary: { document: doc as unknown as vscode.TextDocument, text: '{\n  "a": 2\n}\n' } });
    expect(result.ok).toBe(true);
    expect(doc.offsetAt(primaryOp().range.start as never)).toBe(0);
    expect(doc.offsetAt(primaryOp().range.end as never)).toBe('{\n  "a": 1\n}\n'.length);
    expect(primaryOp().newText).toBe('{\n  "a": 2\n}\n');
  });

  it('with minimalPrimary, only the changed range (common prefix and suffix kept), and the result is the new text', async () => {
    const doc = primary();
    const next = 'Project sales {\n  Note: \'x\'\n}\n';
    const result = await applyFileWrites(plannedWrites(), { primary: { document: doc as unknown as vscode.TextDocument, text: next }, minimalPrimary: true });
    expect(result.ok).toBe(true);
    expect(primaryOp().newText).toBe("  Note: 'x'\n");
    expect(doc.getText()).toBe(next);
  });

  it('with minimalPrimary and an unchanged primary, still the one-character undo anchor', async () => {
    const doc = primary();
    await applyFileWrites([], { primary: { document: doc as unknown as vscode.TextDocument, text: doc.getText() }, minimalPrimary: true });
    expect(primaryOp().newText).toBe('P');
  });
});

describe('a partial apply (D23)', () => {
  it.each([1, 2, 3, 4, 5, 6])('VS Code stops after %i step(s): every file is put back exactly', async (prefix) => {
    const doc = primary();
    const beforeDisk = disk();
    const beforePrimary = doc.getText();
    _mockWorkspaceState.applyEditPrefixes.push(prefix);
    const result = await applyFileWrites(plannedWrites(), { primary: { document: doc as unknown as vscode.TextDocument, text: 'Project sales {\n  Note: \'x\'\n}\n' } });
    expect(result.ok).toBe(false);
    expect(result.unrestored).toEqual([]);
    expect(doc.getText()).toBe(beforePrimary);
    // Replaced documents hold their old text again (and were saved, as they were saved before).
    const fct = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === at('gold/tables/gold/fct.dbml'));
    if (fct) expect(fct.getText()).toBe(beforeDisk['gold/tables/gold/fct.dbml']);
    expect(disk()).toEqual(beforeDisk);
  });

  it('a reconcile that fails too names every file it could not put back in a modal: still modal, neutral words, how to restore, Show Files and Send Feedback (#355)', async () => {
    const doc = primary();
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockImplementation((async () => undefined) as never);
    _mockWorkspaceState.applyEditPrefixes.push(4, 0);
    const result = await applyFileWrites(plannedWrites(), { primary: { document: doc as unknown as vscode.TextDocument, text: 'Project sales {}\n' } });
    expect(result.ok).toBe(false);
    expect(result.unrestored.map((p) => path.relative(root, p).split(path.sep).join('/')).sort()).toEqual([
      'gold/diagrams/sales.dbml', 'gold/notes.md', 'gold/relationships/gold.dbml', 'gold/tables/gold/new.dbml',
    ]);
    expect(error).toHaveBeenCalledTimes(1);
    const [message, options, ...items] = error.mock.calls[0] as unknown as [string, { modal?: boolean }, ...string[]];
    expect(options).toEqual({ modal: true });
    expect(items).toEqual([SHOW_FILES_BUTTON, SEND_FEEDBACK_BUTTON]);
    expect(message).toMatch(/^ERD Studio couldn't finish this change, and VS Code didn't accept putting back the part already made\. /);
    // The usual cause is the environment (a file another program has open), so it never blames ERD Studio.
    expect(message).not.toMatch(/problem in ERD Studio/);
    expect(message).toContain("This is usually a file another program has open or a folder you can't write to.");
    expect(message).toContain('These files are left part-changed: ');
    expect(message).toContain('gold/relationships/gold.dbml');
    expect(message).toContain('Restore them from source control (for example, Discard Changes in the Source Control view), then try again.');
    expect(message).not.toContain('applyEdit');
  });

  it('when the files could not be told apart (every planned file listed), says they may be left part-changed', async () => {
    const doc = primary();
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockImplementation((async () => undefined) as never);
    // The edit lands part way; the put-back lands in full but VS Code still says it failed.
    const real = vscode.workspace.applyEdit.bind(vscode.workspace);
    let call = 0;
    vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async (edit) => {
      call++;
      if (call === 1) {
        _mockWorkspaceState.applyEditPrefixes.push(4);
        return real(edit);
      }
      await real(edit);
      return false;
    });
    const result = await applyFileWrites(plannedWrites(), { primary: { document: doc as unknown as vscode.TextDocument, text: 'Project sales {}\n' } });
    expect(result.ok).toBe(false);
    const [message] = error.mock.calls[0] as unknown as [string];
    expect(message).toContain('These files may be left part-changed: ');
  });

  it('Show Files opens a renamed file where it is now (and the modal says so); Send Feedback\'s report holds counts only, no file name', async () => {
    fs.mkdirSync(at('logical-models'), { recursive: true });
    fs.writeFileSync(at('logical-models/dim.yml'), 'name: dim\n');
    const renames = [{ from: at('logical-models/dim.yml'), to: at('logical-models/gold/dim.yml') }];
    const error = vi.spyOn(vscode.window, 'showErrorMessage')
      .mockResolvedValueOnce(SHOW_FILES_BUTTON as never)
      .mockResolvedValueOnce(SEND_FEEDBACK_BUTTON as never);
    const shown = vi.spyOn(vscode.window, 'showTextDocument');
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    // The rename lands, the delete after it fails; the move back fails too.
    _mockWorkspaceState.applyEditPrefixes.push(1, 0);
    const first = await applyFileWrites([{ kind: 'delete', path: at('gold/tables/gold/older.dbml') }], { renames });
    expect(first.unrestored).toEqual([at('logical-models/dim.yml')]);
    const [message] = error.mock.calls[0] as unknown as [string];
    expect(message).toContain('logical-models/dim.yml (now at ');
    expect(message).toContain('logical-models/gold/dim.yml)');
    await vi.waitFor(() => expect(shown).toHaveBeenCalled());
    const opened = shown.mock.calls[0][0] as unknown as { uri: { fsPath: string } };
    expect(opened.uri.fsPath).toBe(at('logical-models/gold/dim.yml'));

    // Send Feedback (the same modal, a second time): the report never carries a name or a path.
    _mockWorkspaceState.applyEditPrefixes.push(1, 0);
    fs.renameSync(at('logical-models/gold/dim.yml'), at('logical-models/dim.yml'));
    await applyFileWrites([{ kind: 'delete', path: at('gold/tables/gold/older.dbml') }], { renames });
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('erdStudio.reportBug', expect.anything()));
    const prefill = exec.mock.calls.find((c) => c[0] === 'erdStudio.reportBug')![1] as { kind: string; title: string; description: string };
    expect(prefill.kind).toBe('bug');
    expect(prefill.description).toContain('1 file not put back');
    for (const leak of ['dim.yml', 'dim', 'logical-models', 'older', root]) expect(prefill.description).not.toContain(leak);
  });

  it('Show Files on a file that is gone (a delete not put back) shows its folder', async () => {
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValueOnce(SHOW_FILES_BUTTON as never);
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    _mockWorkspaceState.applyEditPrefixes.push(1, 0);
    // The first delete lands, the second does not; putting the first back fails.
    const result = await applyFileWrites([
      { kind: 'delete', path: at('gold/tables/gold/old.dbml') },
      { kind: 'delete', path: at('gold/tables/gold/older.dbml') },
    ]);
    expect(result.unrestored).toEqual([at('gold/tables/gold/old.dbml')]);
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('revealFileInOS', expect.anything()));
    const revealed = exec.mock.calls.find((c) => c[0] === 'revealFileInOS')![1] as { fsPath: string };
    expect(revealed.fsPath).toBe(at('gold/tables/gold'));
  });

  it('a create that failed because its file was already there leaves that file alone (only what the edit made is undone)', async () => {
    const doc = primary();
    // The planned bytes, already on disk: createFile (overwrite: false) fails on it.
    write('gold/tables/gold/new.dbml', 'Table new {\n  id INT\n}\n');
    const beforeDisk = disk();
    const result = await applyFileWrites(plannedWrites(), { primary: { document: doc as unknown as vscode.TextDocument, text: 'Project sales {}\n' } });
    expect(result.ok).toBe(false);
    expect(result.unrestored).toEqual([]);
    expect(disk()).toEqual(beforeDisk);
    expect(disk()['gold/tables/gold/new.dbml']).toBe('Table new {\n  id INT\n}\n');
  });

  it('nothing applied (the whole edit refused) needs no reconcile', async () => {
    const doc = primary();
    const beforeDisk = disk();
    _mockWorkspaceState.applyEditResult = false;
    const result = await applyFileWrites(plannedWrites(), { primary: { document: doc as unknown as vscode.TextDocument, text: 'x' } });
    expect(result.ok).toBe(false);
    expect(_appliedEdits).toHaveLength(1);
    expect(disk()).toEqual(beforeDisk);
  });
});

describe('file renames in the same edit (Organise in a mixed library)', () => {
  const renames = (): Array<{ from: string; to: string }> => [{ from: at('logical-models/dim.yml'), to: at('logical-models/gold/dim.yml') }];
  // Not UTF-8 (a Latin-1 byte): only a rename keeps it exactly.
  const yamlBytes = Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x3a, 0x20, 0xe9, 0x0a]);

  it('goes after the creates and replaces and before the deletes, and keeps every byte', async () => {
    fs.mkdirSync(at('logical-models'), { recursive: true });
    fs.writeFileSync(at('logical-models/dim.yml'), yamlBytes);
    const result = await applyFileWrites(plannedWrites(), { renames: renames() });
    expect(result.ok).toBe(true);
    const ops = (_appliedEdits[0] as unknown as { _ops: Array<{ kind: string }> })._ops.map((op) => op.kind);
    expect(ops.indexOf('renameFile')).toBeGreaterThan(ops.lastIndexOf('replace'));
    expect(ops.indexOf('renameFile')).toBeLessThan(ops.indexOf('deleteFile'));
    expect(result.renamed).toEqual(renames());
    expect(fs.readFileSync(at('logical-models/gold/dim.yml')).equals(yamlBytes)).toBe(true);
  });

  it('a partial apply moves a landed rename back', async () => {
    fs.mkdirSync(at('logical-models'), { recursive: true });
    fs.writeFileSync(at('logical-models/dim.yml'), yamlBytes);
    // creates (3) + replace (1) + the rename: stop right after the rename.
    _mockWorkspaceState.applyEditPrefixes.push(5);
    const result = await applyFileWrites(plannedWrites(), { renames: renames() });
    expect(result.ok).toBe(false);
    expect(result.unrestored).toEqual([]);
    expect(fs.existsSync(at('logical-models/gold/dim.yml'))).toBe(false);
    expect(fs.readFileSync(at('logical-models/dim.yml')).equals(yamlBytes)).toBe(true);
  });
});
