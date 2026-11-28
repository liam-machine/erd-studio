/**
 * Commands held while activation carries on in the background (#357).
 *
 * VS Code draws no webview view, so no glass sidebar, until `activate()`
 * resolves. A look through the open folders that runs long therefore lets
 * `activate()` resolve while it carries on, so the sidebar can say what it
 * is doing. From then on VS Code takes the extension for active: a command
 * invoked before activation has registered it would fail with "command not
 * found", where it used to wait.
 *
 * So for that stretch every contributed command that is not registered yet
 * is held: a stand-in under its id waits for activation to finish and then
 * runs the real command with the same arguments, exactly the wait there was
 * before. Every registration in the extension goes through
 * {@link registerCommand}, which takes the stand-in away first (an id is
 * never registered twice: VS Code throws).
 */

import * as vscode from 'vscode';

/** The stand-ins now registered, by command id. */
const held = new Map<string, vscode.Disposable>();
/** Ids registered for real through {@link registerCommand} and not disposed since: never held. */
const registered = new Set<string>();

/** `vscode.commands.registerCommand`, taking a held stand-in's place. Use it for every command the extension registers. */
export function registerCommand(id: string, handler: (...args: any[]) => unknown, thisArg?: unknown): vscode.Disposable {
  const standIn = held.get(id);
  if (standIn) {
    held.delete(id);
    standIn.dispose();
  }
  const registration = vscode.commands.registerCommand(id, handler, thisArg);
  registered.add(id);
  return { dispose: () => { registered.delete(id); registration.dispose(); } };
}

/**
 * Hold every one of `ids` that is not registered yet until `until` settles:
 * invoked meanwhile, it waits, then runs whatever is registered under the id
 * by then. One that activation never registers fails then as it would have.
 */
export function holdCommands(ids: readonly string[], until: Promise<unknown>): void {
  for (const id of ids) {
    if (registered.has(id) || held.has(id)) continue;
    try {
      const standIn = vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        await until.then(() => undefined, () => undefined);
        // Never back into a stand-in: by now the real command has its place, or nothing has.
        if (held.has(id)) return undefined;
        return vscode.commands.executeCommand(id, ...args);
      });
      held.set(id, standIn);
    } catch {
      // Registered some other way already: the real one answers.
    }
  }
}

/** Take away every stand-in still registered (activation is over, or the window is closing). */
export function releaseHeldCommands(): void {
  for (const standIn of held.values()) {
    try { standIn.dispose(); } catch { /* best effort */ }
  }
  held.clear();
}

/** The ids held now (tests). */
export function heldCommandIds(): string[] {
  return [...held.keys()];
}

/** A new activation starts with nothing registered and nothing held. */
export function resetHeldCommands(): void {
  releaseHeldCommands();
  registered.clear();
}
