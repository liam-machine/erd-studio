/**
 * applyFileWrites (D23, §5.3 steps 6–7 of docs/plans/native-dbml-storage.md,
 * §9.5): one WorkspaceEdit in a fixed order — the primary replace, then
 * creates (relationships files before table files before layout files), then
 * replaces, then deletes — and, when VS Code applies only part of it (the
 * mock applies a prefix), a reconcile back to the exact prior state; a
 * reconcile that fails too names the files in a modal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { _appliedEdits, _mockWorkspaceState, _resetMockWorkspace, createMockTextDocument } from '../__mocks__/vscode';
import { applyFileWrites } from '../../src/providers/applyFileWrites';
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
  const doc = createMockTextDocument(at('gold/sales.dbml'), fs.readFileSync(at('gold/sales.dbml'), 'utf-8'), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(doc);
  return doc;
}

function plannedWrites(): FileWrite[] {
  return [
    { kind: 'delete', path: at('tables/gold/old.dbml') },
    { kind: 'replace', path: at('tables/gold/fct.dbml'), text: 'Table fct {\n  id INT [pk]\n  x INT\n}\n' },
    { kind: 'create', path: at('gold/sales.dbdiagram'), text: '{}\n' },
    { kind: 'create', path: at('tables/gold/new.dbml'), text: 'Table new {\n  id INT\n}\n' },
    { kind: 'delete', path: at('tables/gold/older.dbml') },
    { kind: 'create', path: at('tables/gold/_relationships.dbml'), text: '// rels\n' },
  ];
}

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-apply-writes-'));
  write('gold/sales.dbml', 'Project sales {\n}\n');
  write('tables/gold/fct.dbml', 'Table fct {\n  id INT [pk]\n}\n');
  write('tables/gold/old.dbml', 'Table old {\n  id INT\n}\n');
  write('tables/gold/older.dbml', 'Table older {\n  id INT\n}\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the order of one WorkspaceEdit', () => {
  it('primary replace, creates (relationships, tables, layouts), replaces, deletes', async () => {
    const doc = primary();
    const result = await applyFileWrites(plannedWrites(), { primary: { document: doc as unknown as vscode.TextDocument, text: 'Project sales {\n  Note: \'x\'\n}\n' } });
    expect(result.ok).toBe(true);
    expect(_appliedEdits).toHaveLength(1);
    const ops = (_appliedEdits[0] as unknown as { _ops: Array<{ kind: string; uri: { fsPath: string } }> })._ops
      .map((op) => `${op.kind} ${path.relative(root, op.uri.fsPath).split(path.sep).join('/')}`);
    expect(ops).toEqual([
      'replace gold/sales.dbml',
      'createFile tables/gold/_relationships.dbml',
      'createFile tables/gold/new.dbml',
      'createFile gold/sales.dbdiagram',
      'replace tables/gold/fct.dbml',
      'deleteFile tables/gold/old.dbml',
      'deleteFile tables/gold/older.dbml',
    ]);
    expect(result.created.map((p) => path.basename(p))).toEqual(['_relationships.dbml', 'new.dbml', 'sales.dbdiagram']);
    expect(result.deleted.map((p) => path.basename(p))).toEqual(['old.dbml', 'older.dbml']);
    expect(result.replaced.map((u) => path.basename(u.fsPath))).toEqual(['fct.dbml']);
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
    const fct = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === at('tables/gold/fct.dbml'));
    if (fct) expect(fct.getText()).toBe(beforeDisk['tables/gold/fct.dbml']);
    expect(disk()).toEqual(beforeDisk);
  });

  it('a reconcile that fails too names every file it could not put back in a modal', async () => {
    const doc = primary();
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockImplementation((async () => undefined) as never);
    _mockWorkspaceState.applyEditPrefixes.push(4, 0);
    const result = await applyFileWrites(plannedWrites(), { primary: { document: doc as unknown as vscode.TextDocument, text: 'Project sales {}\n' } });
    expect(result.ok).toBe(false);
    expect(result.unrestored.map((p) => path.relative(root, p).split(path.sep).join('/')).sort()).toEqual([
      'gold/sales.dbdiagram', 'gold/sales.dbml', 'tables/gold/_relationships.dbml', 'tables/gold/new.dbml',
    ]);
    expect(error).toHaveBeenCalledTimes(1);
    const [message, options] = error.mock.calls[0] as unknown as [string, { modal?: boolean }];
    expect(message).toContain('Restore these from source control');
    expect(message).toContain('_relationships.dbml');
    expect(options).toEqual({ modal: true });
  });

  it('a create that failed because its file was already there leaves that file alone (only what the edit made is undone)', async () => {
    const doc = primary();
    // The planned bytes, already on disk: createFile (overwrite: false) fails on it, after the relationships file landed.
    write('tables/gold/new.dbml', 'Table new {\n  id INT\n}\n');
    const beforeDisk = disk();
    const result = await applyFileWrites(plannedWrites(), { primary: { document: doc as unknown as vscode.TextDocument, text: 'Project sales {}\n' } });
    expect(result.ok).toBe(false);
    expect(result.unrestored).toEqual([]);
    expect(disk()).toEqual(beforeDisk);
    expect(disk()['tables/gold/new.dbml']).toBe('Table new {\n  id INT\n}\n');
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
