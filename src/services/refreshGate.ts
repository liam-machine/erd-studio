/**
 * Hold refreshes while a command writes many files, and run each once after.
 *
 * Convert Project to DBML writes ~2,300 files at 1,100 tables. The file
 * watcher reports each one (own writes are recorded only after the edit
 * lands), and every report refreshes the sidebar trees and the context keys,
 * each refresh re-reading the project. While a gate is held, a gated refresh
 * is only remembered; when the last hold is released, each remembered one
 * runs once, in the order first asked for.
 *
 * No `vscode`: the logic is plain, and tested on its own.
 */
import { log } from './logger';

export class RefreshGate {
  private holds = 0;
  private readonly pending = new Map<string, () => void>();

  /** Whether a hold is open. */
  get held(): boolean {
    return this.holds > 0;
  }

  /**
   * Open a hold; the returned function releases it (a second call does
   * nothing). Releasing the last hold runs what was asked for meanwhile.
   */
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      if (this.holds === 0) this.flush();
    };
  }

  /**
   * `run`, gated under `key`: called straight away when no hold is open;
   * otherwise remembered, and called once (with no arguments, so a
   * refresh of one element becomes a full refresh) when the last hold is released.
   */
  gate<A extends unknown[]>(key: string, run: (...args: A) => void): (...args: A) => void {
    return (...args: A) => {
      if (this.holds > 0) {
        if (!this.pending.has(key)) this.pending.set(key, () => (run as (...a: unknown[]) => void)());
        return;
      }
      run(...args);
    };
  }

  /**
   * Gate an object's method in place, under `key`: the object gets its own
   * `name` that the gate guards, calling the class's method (looked up when
   * it runs) to refresh. Every caller of `target[name]()` is gated, with no
   * change to the class.
   */
  gateMethod<T extends object>(target: T, name: keyof T & string, key: string): void {
    const proto = Object.getPrototypeOf(target) as Record<string, unknown>;
    if (typeof proto[name] !== 'function') throw new Error(`RefreshGate: ${name} is not a method`);
    (target as Record<string, unknown>)[name] = this.gate(key, (...args: unknown[]) => {
      (proto[name] as (...a: unknown[]) => void).apply(target, args);
    });
  }

  private flush(): void {
    const runs = [...this.pending.values()];
    this.pending.clear();
    for (const run of runs) {
      try {
        run();
      } catch (err) {
        log.error('[RefreshGate] A held refresh failed:', err);
      }
    }
  }
}
