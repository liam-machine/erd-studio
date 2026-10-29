/**
 * The ERD Studio view's provider registered before the real one exists:
 * no rows (so its "Loading diagrams…" welcome shows) until the real provider
 * is attached and one turn has passed since an empty answer, then one change
 * event, and every request reaches the real provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { DeferredTreeDataProvider } from '../../src/providers/deferredTreeDataProvider';

function realProvider() {
  const changed = new vscode.EventEmitter<string | undefined>();
  return {
    changed,
    onDidChangeTreeData: changed.event,
    getChildren: vi.fn((element?: string) => (element ? [] : ['a', 'b'])),
    getTreeItem: vi.fn((element: string) => new vscode.TreeItem(element)),
    handleDrag: vi.fn(),
    handleDrop: vi.fn(),
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('DeferredTreeDataProvider', () => {
  it('attached during activation, before VS Code asks: the first answer is still empty, then one change and the real rows', async () => {
    const deferred = new DeferredTreeDataProvider<string>(['m'], ['m']);
    let changes = 0;
    deferred.onDidChangeTreeData(() => { changes++; });
    const real = realProvider();
    deferred.attach(real);
    expect(changes).toBe(0);

    expect(deferred.getChildren()).toEqual([]);
    expect(real.getChildren).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toBe(1);
    expect(deferred.getChildren()).toEqual(['a', 'b']);
    expect(deferred.isReleased).toBe(true);
  });

  it('asked before the real provider exists: empty until it is attached, then one change', async () => {
    const deferred = new DeferredTreeDataProvider<string>();
    let changes = 0;
    deferred.onDidChangeTreeData(() => { changes++; });
    expect(deferred.getChildren()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(deferred.getChildren()).toEqual([]);
    expect(changes).toBe(0);
    const real = realProvider();
    deferred.attach(real);
    expect(changes).toBe(1);
    expect(deferred.getChildren()).toEqual(['a', 'b']);
  });

  it('passes on the real provider\'s changes and its drag and drop, and keeps the mime types VS Code reads at creation', async () => {
    const deferred = new DeferredTreeDataProvider<string>(['drop/x'], ['drag/x']);
    expect(deferred.dropMimeTypes).toEqual(['drop/x']);
    expect(deferred.dragMimeTypes).toEqual(['drag/x']);
    const real = realProvider();
    deferred.attach(real);
    const seen: Array<string | undefined> = [];
    deferred.onDidChangeTreeData((e) => { seen.push(e as string | undefined); });
    real.changed.fire('a');
    expect(seen).toEqual(['a']);
    const transfer = {} as vscode.DataTransfer;
    const token = {} as vscode.CancellationToken;
    void deferred.handleDrag(['a'], transfer, token);
    void deferred.handleDrop('b', transfer, token);
    expect(real.handleDrag).toHaveBeenCalledWith(['a'], transfer, token);
    expect(real.handleDrop).toHaveBeenCalledWith('b', transfer, token);
    expect(() => deferred.attach(realProvider())).toThrow(/already attached/);
  });
});
