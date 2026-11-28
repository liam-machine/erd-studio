/**
 * #357: commands held while activation carries on in the background
 * (`heldCommands.ts`). Once `activate()` has resolved, VS Code no longer
 * waits for the extension before running a command, so one that is not
 * registered yet would fail with "command not found". A held command waits
 * for activation instead and then runs the real one, and the real
 * registration takes the stand-in's place without registering an id twice.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import { heldCommandIds, holdCommands, registerCommand, releaseHeldCommands, resetHeldCommands } from '../../src/commands/heldCommands';

const registeredIds = (): string[] => vscode._registeredCommands.map((e) => e.command);

function gate(): { until: Promise<void>; open(): void; fail(): void } {
  let open!: () => void;
  let fail!: () => void;
  const until = new Promise<void>((resolve, reject) => { open = resolve; fail = () => reject(new Error('activation failed')); });
  until.catch(() => undefined);
  return { until, open, fail };
}

beforeEach(() => {
  vscode._resetRegisteredCommands();
  resetHeldCommands();
});

describe('#357 commands held until activation is over', () => {
  it('a held command waits, then runs the real one with the same arguments and gives its answer', async () => {
    const g = gate();
    holdCommands(['erdStudio.importDbml'], g.until);
    expect(heldCommandIds()).toEqual(['erdStudio.importDbml']);
    const calls: unknown[][] = [];
    let settled = false;
    const run = vscode.commands.executeCommand('erdStudio.importDbml', 'a', 2).then((v) => { settled = true; return v; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    // Activation registers the real command: it takes the stand-in's place, never beside it.
    registerCommand('erdStudio.importDbml', (...args: unknown[]) => { calls.push(args); return 'imported'; });
    expect(registeredIds().filter((id) => id === 'erdStudio.importDbml')).toHaveLength(1);
    expect(heldCommandIds()).toEqual([]);
    g.open();
    expect(await run).toBe('imported');
    expect(calls).toEqual([['a', 2]]);
  });

  it('a command already registered is never held, and holding twice registers one stand-in', () => {
    const real = registerCommand('erdStudio.toggleGlassSidebar', () => 'real');
    const g = gate();
    holdCommands(['erdStudio.toggleGlassSidebar', 'erdStudio.newTable'], g.until);
    holdCommands(['erdStudio.newTable'], g.until);
    expect(heldCommandIds()).toEqual(['erdStudio.newTable']);
    expect(registeredIds().sort()).toEqual(['erdStudio.newTable', 'erdStudio.toggleGlassSidebar']);
    // Disposed and registered again later (a view torn down and rebuilt): holdable from then on.
    real.dispose();
    expect(registeredIds()).toEqual(['erdStudio.newTable']);
    g.open();
  });

  it('a command registered some other way is left alone', () => {
    vscode.commands.registerCommand('erdStudio.direct', () => 'direct');
    const g = gate();
    expect(() => holdCommands(['erdStudio.direct'], g.until)).not.toThrow();
    expect(heldCommandIds()).toEqual([]);
    g.open();
  });

  it('activation ends without registering it: the stand-in goes and the command runs nothing (never itself again)', async () => {
    const g = gate();
    holdCommands(['erdStudio.never'], g.until);
    const run = vscode.commands.executeCommand('erdStudio.never');
    releaseHeldCommands();
    expect(registeredIds()).toEqual([]);
    g.open();
    await expect(run).resolves.toBeUndefined();
  });

  it('a failed activation lets go of whoever waited, without throwing its error at them', async () => {
    const g = gate();
    holdCommands(['erdStudio.newTable'], g.until);
    const run = vscode.commands.executeCommand('erdStudio.newTable');
    g.fail();
    await expect(run).resolves.toBeUndefined();
  });

  it('a stand-in still registered when its wait ends does not call itself', async () => {
    const g = gate();
    holdCommands(['erdStudio.stuck'], g.until);
    const run = vscode.commands.executeCommand('erdStudio.stuck');
    g.open();
    await expect(run).resolves.toBeUndefined();
    expect(heldCommandIds()).toEqual(['erdStudio.stuck']);
  });
});
