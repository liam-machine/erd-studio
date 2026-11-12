/**
 * A mirror of the `erdStudio.*` context keys, for the glass sidebar's `when`
 * evaluation (VS Code has no API to read a context key back).
 *
 * The extension sets its keys from about two dozen places, all through
 * `vscode.commands.executeCommand('setContext', key, value)`. Rather than
 * change each call site, {@link installContextKeyRecorder} wraps that one
 * function once, at the top of activation: every `setContext` still goes to
 * VS Code exactly as before (same arguments, same promise) and is also
 * recorded here. Nothing is set that was not set before.
 */
import * as vscode from 'vscode';

const values = new Map<string, unknown>();
const listeners = new Set<(key: string) => void>();
const WRAPPED = Symbol.for('erdStudio.contextKeyRecorder');

/** Record a key's value (also used directly for keys set before the recorder existed). */
export function recordContextKey(key: string, value: unknown): void {
  if (typeof key !== 'string' || !key.startsWith('erdStudio.')) return;
  if (values.has(key) && Object.is(values.get(key), value)) return;
  values.set(key, value);
  for (const listener of listeners) {
    try { listener(key); } catch { /* a listener never breaks setContext */ }
  }
}

/** The recorded value of `key` (undefined when never set). */
export function contextKeyValue(key: string): unknown {
  return values.get(key);
}

/** A snapshot of every recorded key. */
export function contextKeySnapshot(): ReadonlyMap<string, unknown> {
  return new Map(values);
}

/** Called after a recorded key changes value. */
export function onDidChangeContextKey(listener: (key: string) => void): vscode.Disposable {
  listeners.add(listener);
  return { dispose: () => { listeners.delete(listener); } };
}

/**
 * Wrap `vscode.commands.executeCommand` so `setContext` calls are mirrored
 * here. Idempotent. Returns false when the API object could not be wrapped
 * (then only keys recorded directly are known).
 */
export function installContextKeyRecorder(): boolean {
  const commands = vscode.commands as unknown as Record<string | symbol, unknown> & {
    executeCommand: (command: string, ...rest: unknown[]) => Thenable<unknown>;
  };
  if ((commands.executeCommand as unknown as Record<symbol, unknown>)[WRAPPED]) return true;
  const original = commands.executeCommand;
  const wrapped = function (this: unknown, command: string, ...rest: unknown[]): Thenable<unknown> {
    if (command === 'setContext' && typeof rest[0] === 'string') recordContextKey(rest[0], rest[1]);
    return original.call(this ?? commands, command, ...rest);
  };
  (wrapped as unknown as Record<symbol, unknown>)[WRAPPED] = true;
  try {
    commands.executeCommand = wrapped;
  } catch {
    return false;
  }
  return commands.executeCommand === wrapped;
}

/** Tests: forget every recorded key and listener. */
export function _resetContextKeys(): void {
  values.clear();
  listeners.clear();
}
