/**
 * dbtTerminal — runs a dbt command in a VS Code terminal the user can watch
 * and stop, and reads how it ended.
 *
 * The terminal is a `Pseudoterminal` (VS Code 1.85 API: `createTerminal({
 * name, pty, isTransient })`), whose `open()` spawns the plan's absolute dbt
 * executable (`startDbtProcess`). Nothing is typed into the user's shell, so
 * no shell (PowerShell, cmd, zsh) can mangle the command, and the exit code
 * and output are ours to read. `isTransient` keeps a finished terminal from
 * being restored on reload.
 *
 * One dbt run per project at a time, whatever the kind: parse, compile and
 * deps share `target/` and dbt's partial-parse state. The last output tail is
 * kept in memory for **Show output**; it is never logged, stored or sent.
 */

import * as vscode from 'vscode';

import type { DbtCommandKind, DbtRunMode, DbtSpawnPlan } from '../services/dbtLaunch';
import { toTerminalText } from '../services/dbtLaunch';
import { startDbtProcess, type DbtProcessHandle, type DbtProcessResult } from '../services/dbtProcess';
import { pathKey } from '../services/pathKey';

export interface DbtTerminalRun {
  terminal: vscode.Terminal;
  /** Resolves when the process ends (or when the terminal closed before it started), never rejects. */
  result: Promise<DbtProcessResult>;
}
export type DbtRunStart = { kind: 'started'; run: DbtTerminalRun } | { kind: 'busy'; terminal: vscode.Terminal | undefined };

/** A run that finished this long ago still counts for `isDbtRunActiveOrRecent` (the watcher's toast). */
export const DBT_RUN_TOAST_GRACE_MS = 15_000;

interface Entry {
  kind: DbtCommandKind;
  mode: DbtRunMode;
  terminal: vscode.Terminal;
  handle?: DbtProcessHandle;
  finishedAt?: number;
  tail: string;
  /** Settles the run when the terminal closed before `open()` started the process. */
  settleUnstarted: () => void;
}

const runs = new Map<string, Entry>();
/** Read-only "last output" terminals, closed with the run registry. */
const replayTerminals = new Set<vscode.Terminal>();
let closeSubscription: vscode.Disposable | undefined;

const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function header(kind: DbtCommandKind, mode: DbtRunMode, plan: DbtSpawnPlan): string {
  let text = `${DIM}> ${plan.display}${RESET}\r\n`;
  if (mode === 'noCreds' && kind === 'parse') {
    text += `${DIM}  Parsing without your credentials: placeholder connection details from ERD Studio; nothing connects to your warehouse.${RESET}\r\n`;
  }
  if (kind === 'deps') {
    text += `${DIM}  Downloads the packages in packages.yml.${RESET}\r\n`;
  }
  return `${text}\r\n`;
}

function footer(kind: DbtCommandKind, r: DbtProcessResult): string {
  let line: string;
  if (r.outcome === 'notStarted') {
    line = `${RED}Couldn't start dbt (${r.startError ?? 'unknown'}).${RESET}`;
  } else if (r.outcome === 'stopped') {
    line = `dbt ${kind} was stopped.`;
  } else if (r.exitCode === 0) {
    line = `${GREEN}✓ dbt ${kind} finished.${RESET}`;
  } else if (r.exitCode === null) {
    line = `${RED}✗ dbt ${kind} ended without an exit code.${RESET}`;
  } else {
    line = `${RED}✗ dbt ${kind} failed with exit code ${r.exitCode}.${RESET}`;
  }
  return `\r\n${line}\r\n${DIM}Press any key to close this terminal.${RESET}\r\n`;
}

function ensureCloseSubscription(): void {
  if (closeSubscription) return;
  closeSubscription = vscode.window.onDidCloseTerminal((closed) => {
    replayTerminals.delete(closed);
    for (const entry of runs.values()) {
      if (entry.terminal === closed && entry.finishedAt === undefined && !entry.handle) {
        entry.settleUnstarted();
      }
    }
  });
}

/**
 * Start `plan` in a new dbt terminal for `root`, or `busy` (with the running
 * terminal) when a dbt run for that project is still going.
 */
export function runDbtInTerminal(
  root: string,
  kind: DbtCommandKind,
  mode: DbtRunMode,
  plan: DbtSpawnPlan,
  deps: { start?: typeof startDbtProcess } = {},
): DbtRunStart {
  const key = pathKey(root);
  const previous = runs.get(key);
  if (previous && previous.finishedAt === undefined) {
    return { kind: 'busy', terminal: previous.terminal };
  }
  // A finished run's terminal makes way for the new one, so they do not pile up.
  previous?.terminal.dispose();
  ensureCloseSubscription();

  const start = deps.start ?? startDbtProcess;
  const write = new vscode.EventEmitter<string>();
  const close = new vscode.EventEmitter<number | void>();
  let resolveResult!: (r: DbtProcessResult) => void;
  const result = new Promise<DbtProcessResult>((resolve) => { resolveResult = resolve; });
  let finished: DbtProcessResult | undefined;

  const entry = { kind, mode, tail: '' } as Entry;
  const settle = (r: DbtProcessResult): void => {
    if (finished) return;
    finished = r;
    entry.finishedAt = Date.now();
    entry.tail = r.tail;
    resolveResult(r);
  };
  entry.settleUnstarted = () => settle({ outcome: 'stopped', exitCode: null, tail: '', durationMs: 0 });

  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    onDidClose: close.event,
    open: () => {
      if (finished) return;
      write.fire(header(kind, mode, plan));
      const handle = start(plan, (text) => write.fire(toTerminalText(text)));
      entry.handle = handle;
      void handle.done.then((r) => {
        write.fire(footer(kind, r));
        settle(r);
      });
    },
    // The user closed the terminal: stop dbt (a no-op once it has finished).
    close: () => { entry.handle?.stop(); },
    handleInput: (data) => {
      if (!finished) {
        if (data === '\x03') entry.handle?.stop(); // Ctrl+C
        return;
      }
      // Any key closes a finished terminal. No exit code: the footer shows it, and a
      // non-zero code would make VS Code's own exit alert repeat our notification.
      close.fire();
    },
  };

  const terminal = vscode.window.createTerminal({ name: `dbt ${kind}`, pty, isTransient: true });
  entry.terminal = terminal;
  runs.set(key, entry);
  terminal.show(true);
  return { kind: 'started', run: { terminal, result } };
}

/** A dbt run for `root` is still going. */
export function isDbtRunActive(root: string): boolean {
  const entry = runs.get(pathKey(root));
  return !!entry && entry.finishedAt === undefined;
}

/** A dbt run for `root` is going, or finished less than {@link DBT_RUN_TOAST_GRACE_MS} ago. */
export function isDbtRunActiveOrRecent(root: string, now: number = Date.now()): boolean {
  const entry = runs.get(pathKey(root));
  if (!entry) return false;
  return entry.finishedAt === undefined || now - entry.finishedAt < DBT_RUN_TOAST_GRACE_MS;
}

/**
 * Show the last dbt run's output for `root`: its terminal while it is open,
 * else a read-only terminal replaying the in-memory tail.
 */
export function showDbtOutput(root: string): void {
  const entry = runs.get(pathKey(root));
  if (!entry) return;
  if (vscode.window.terminals.includes(entry.terminal)) {
    entry.terminal.show();
    return;
  }
  const write = new vscode.EventEmitter<string>();
  const close = new vscode.EventEmitter<number | void>();
  const tail = entry.tail;
  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    onDidClose: close.event,
    open: () => {
      write.fire(toTerminalText(tail));
      write.fire(`\r\n${DIM}Press any key to close this terminal.${RESET}\r\n`);
    },
    close: () => {},
    handleInput: () => close.fire(),
  };
  const terminal = vscode.window.createTerminal({ name: `dbt ${entry.kind} (last output)`, pty, isTransient: true });
  replayTerminals.add(terminal);
  terminal.show();
}

/** Deactivate: kill every dbt child at once and close the terminals. */
export function disposeDbtRuns(): void {
  for (const entry of runs.values()) {
    entry.handle?.kill();
    entry.terminal.dispose();
  }
  runs.clear();
  for (const t of replayTerminals) t.dispose();
  replayTerminals.clear();
  closeSubscription?.dispose();
  closeSubscription = undefined;
}

/** Test seam: forget every run without touching processes. */
export function _resetDbtRunsForTests(): void {
  runs.clear();
  replayTerminals.clear();
  closeSubscription?.dispose();
  closeSubscription = undefined;
}
