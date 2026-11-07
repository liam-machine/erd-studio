/**
 * RefreshGate: held refreshes run once each after the last hold is released
 * (Convert Project to DBML holds the sidebar trees and context keys while
 * it writes ~2,300 files).
 */

import { describe, expect, it, vi } from 'vitest';

import { RefreshGate } from '../../src/services/refreshGate';

describe('RefreshGate', () => {
  it('runs a gated refresh straight away, with its arguments, when nothing holds it', () => {
    const gate = new RefreshGate();
    const run = vi.fn();
    gate.gate('tree', run)('element');
    expect(run).toHaveBeenCalledWith('element');
    expect(gate.held).toBe(false);
  });

  it('while held, remembers each refresh once and runs it (as a full refresh) on release, in the order first asked', () => {
    const gate = new RefreshGate();
    const order: string[] = [];
    const tree = vi.fn(() => order.push('tree'));
    const keys = vi.fn(() => order.push('keys'));
    const refreshTree = gate.gate('tree', tree);
    const refreshKeys = gate.gate('keys', keys);
    const release = gate.hold();
    for (let i = 0; i < 2000; i++) {
      refreshKeys();
      refreshTree('one element');
    }
    expect(tree).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();
    release();
    expect(order).toEqual(['keys', 'tree']);
    expect(tree).toHaveBeenCalledWith();
    expect(gate.held).toBe(false);
  });

  it('waits for the last of several holds; a second release does nothing', () => {
    const gate = new RefreshGate();
    const run = vi.fn();
    const refresh = gate.gate('tree', run);
    const first = gate.hold();
    const second = gate.hold();
    refresh();
    first();
    first();
    expect(gate.held).toBe(true);
    expect(run).not.toHaveBeenCalled();
    second();
    expect(run).toHaveBeenCalledTimes(1);
    second();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a release with nothing asked for runs nothing, and a failing refresh does not stop the others', () => {
    const gate = new RefreshGate();
    const after = vi.fn();
    gate.hold()();
    expect(after).not.toHaveBeenCalled();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = gate.gate('a', () => { throw new Error('boom'); });
    const ok = gate.gate('b', after);
    const release = gate.hold();
    failing();
    ok();
    release();
    expect(after).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('RefreshGate.gateMethod', () => {
  class Tree {
    calls: unknown[][] = [];
    refresh(...args: unknown[]): void { this.calls.push(args); }
  }

  it('gates every call of the instance method, and calls the class method when it runs (a spy on it sees the call)', () => {
    const gate = new RefreshGate();
    const tree = new Tree();
    gate.gateMethod(tree, 'refresh', 'tree');
    const spy = vi.spyOn(Tree.prototype, 'refresh');
    tree.refresh('a');
    expect(spy).toHaveBeenCalledWith('a');
    expect(tree.calls).toEqual([['a']]);
    const release = gate.hold();
    tree.refresh('b');
    tree.refresh('c');
    expect(tree.calls).toHaveLength(1);
    release();
    expect(tree.calls).toEqual([['a'], []]);
    spy.mockRestore();
  });

  it('refuses a name that is not a method', () => {
    const gate = new RefreshGate();
    expect(() => gate.gateMethod({ refresh: 1 } as unknown as { refresh: () => void }, 'refresh', 'x')).toThrow(/not a method/);
  });
});
