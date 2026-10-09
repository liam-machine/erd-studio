/**
 * The unsaved-tab check every writer runs: paths compared the way the file
 * system compares them.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'path';
import * as vscode from 'vscode';

import { createMockTextDocument, _resetMockWorkspace } from '../__mocks__/vscode';
import { dirtyFiles } from '../../src/providers/dirtyDocuments';
import { pathKey } from '../../src/services/pathKey';

describe('pathKey', () => {
  it('ignores case on Windows and macOS, whose file systems do', () => {
    expect(pathKey('/Proj/.erd-studio/logical-models/Fct_Order.yml', 'win32'))
      .toBe(pathKey('/proj/.erd-studio/logical-models/fct_order.yml', 'win32'));
    expect(pathKey('/Proj/a.yml', 'darwin')).toBe(pathKey('/proj/A.yml', 'darwin'));
  });

  it('keeps case on Linux, where a.yml and A.yml are two files', () => {
    expect(pathKey('/proj/a.yml', 'linux')).not.toBe(pathKey('/proj/A.yml', 'linux'));
  });

  it('resolves the path first', () => {
    expect(pathKey('/proj/x/../a.yml', 'linux')).toBe(path.resolve('/proj/a.yml'));
  });
});

describe('dirtyFiles', () => {
  afterEach(() => _resetMockWorkspace());

  function open(fsPath: string, dirty: boolean): void {
    const doc = createMockTextDocument(fsPath, 'name: a\n');
    if (dirty) doc._setText('name: a\n# unsaved\n');
    (vscode.workspace.textDocuments as unknown[]).push(doc);
  }

  it('lists the given paths open with unsaved edits, each once, in order', () => {
    open('/proj/b.yml', true);
    open('/proj/a.yml', true);
    open('/proj/c.yml', false);
    expect(dirtyFiles(['/proj/a.yml', '/proj/c.yml', '/proj/b.yml', '/proj/a.yml', '/proj/d.yml']))
      .toEqual(['/proj/a.yml', '/proj/b.yml']);
  });
});
