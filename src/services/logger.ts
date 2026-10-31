/**
 * The ERD Studio log: five levels and one pluggable sink.
 *
 * No `vscode` import, on purpose: the CLI (`dist/cli.js`), the manifest worker
 * and the MCP server bundle the services that log through this module.
 * `activate()` plugs in the **ERD Studio** output channel
 * (`vscode.window.createOutputChannel('ERD Studio', { log: true })`, a
 * `LogOutputChannel` — its own level picker filters what shows); nothing else
 * sets a sink.
 *
 * - `warn` and `error` always go to `console.warn` / `console.error` as well,
 *   exactly as the `console.*` calls this module replaced did: the extension
 *   host's own log, the CLI's `--verbose` capture (which swaps `console.*` at
 *   run time, so the console is looked up on every call) and the tests' spies
 *   keep seeing them.
 * - `info`, `debug` and `trace` reach the sink only. Without one (the CLI, the
 *   MCP server, tests) they are silent — never `console.log`, which is the MCP
 *   server's protocol stream.
 *
 * The last {@link LOG_BUFFER_CAPACITY} `info`, `warn` and `error` lines are
 * also kept in memory for Send Feedback's opt-in "Include recent ERD Studio
 * log" (see `docs/dev/feedback.md`); the feedback path runs them through
 * `redactPaths()`. Telemetry must never read the buffer or import this module
 * (`test/unit/loggerBoundary.test.ts`).
 */

/** Severity, lowest first. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** Where log lines go. A `vscode.LogOutputChannel` is one, as it is. */
export interface LogSink {
  trace(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string | Error, ...args: unknown[]): void;
}

/** A scoped logger: every message is prefixed with `[scope] `. */
export interface Logger {
  trace(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** How many lines the in-memory buffer keeps. */
export const LOG_BUFFER_CAPACITY = 200;

/** Levels the buffer keeps (trace and debug would push the useful lines out). */
const BUFFERED: ReadonlySet<LogLevel> = new Set<LogLevel>(['info', 'warn', 'error']);

let sink: LogSink | undefined;
const buffer: string[] = [];

/** Plug in (or, with `undefined`, remove) the sink. Returns the previous one. */
export function setLogSink(next: LogSink | undefined): LogSink | undefined {
  const previous = sink;
  sink = next;
  return previous;
}

/** Whether a sink is plugged in (callers may skip building costly detail without one). */
export function hasLogSink(): boolean {
  return sink !== undefined;
}

/** One argument as text: an Error by its message, objects as JSON where they can be. */
export function formatLogArg(arg: unknown): string {
  if (arg instanceof Error) return arg.message;
  if (typeof arg === 'string') return arg;
  if (arg === undefined) return 'undefined';
  try {
    const json = JSON.stringify(arg);
    return json === undefined ? String(arg) : json;
  } catch {
    return String(arg);
  }
}

/** The message and its arguments as one line (whitespace collapsed). */
export function formatLogLine(message: string, args: readonly unknown[]): string {
  return [message, ...args.map(formatLogArg)].join(' ').replace(/\s+/g, ' ').trim();
}

function remember(level: LogLevel, message: string, args: readonly unknown[], now: Date): void {
  if (!BUFFERED.has(level)) return;
  buffer.push(`${now.toISOString()} [${level}] ${formatLogLine(message, args)}`);
  while (buffer.length > LOG_BUFFER_CAPACITY) buffer.shift();
}

/**
 * Log one message at `level`. Never throws. `mirrorToConsole: false` keeps a
 * `warn` / `error` line out of the console (for a line some other code
 * already printed there).
 */
export function writeLog(
  level: LogLevel,
  message: string,
  args: readonly unknown[] = [],
  now: Date = new Date(),
  mirrorToConsole = true,
): void {
  try {
    remember(level, message, args, now);
  } catch {
    // A line that cannot be formatted is not worth a crash.
  }
  if (sink) {
    try {
      sink[level](message, ...args);
    } catch {
      // A disposed channel (window closing) must never break the caller.
    }
  }
  if (!mirrorToConsole) return;
  // Looked up on every call: the CLI swaps console.* while it runs.
  if (level === 'error') console.error(message, ...args);
  else if (level === 'warn') console.warn(message, ...args);
}

/**
 * A logger whose messages read `[scope] message`. An empty scope adds no
 * prefix.
 */
export function createLogger(scope: string): Logger {
  const prefix = scope ? `[${scope}] ` : '';
  const at = (level: LogLevel) => (message: string, ...args: unknown[]): void => writeLog(level, prefix + message, args);
  return { trace: at('trace'), debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** The extension-wide logger (no scope prefix). */
export const log: Logger = createLogger('');

/** The buffered lines, oldest first (raw: the feedback path redacts them). */
export function recentLogLines(): string[] {
  return [...buffer];
}

/** Empty the buffer (tests). */
export function clearLogBuffer(): void {
  buffer.length = 0;
}

/** Milliseconds since `start` (a `Date.now()` value), rounded. */
export function elapsedMs(start: number): number {
  return Math.round(Date.now() - start);
}

/** `1 table` / `3 tables`. */
export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

/**
 * Time the phases of a long job: each phase is logged at `info` with how long
 * it took when the next one starts (or the job ends), then the whole job.
 */
export interface PhaseTimer {
  /** Start a phase, ending the one before. */
  phase(name: string): void;
  /** End the last phase and log the whole job: `<label>: <outcome> in N ms`. Returns that total. */
  end(outcome: string): number;
}

export function phaseTimer(
  logger: Logger,
  label: string,
  options: { level?: 'info' | 'debug'; now?: () => number } = {},
): PhaseTimer {
  const now = options.now ?? Date.now;
  const level = options.level ?? 'info';
  const start = now();
  let current: { name: string; at: number } | undefined;
  const close = (): void => {
    if (!current) return;
    logger[level](`${label}: ${current.name} took ${Math.round(now() - current.at)} ms`);
    current = undefined;
  };
  return {
    phase(name: string): void {
      close();
      current = { name, at: now() };
    },
    end(outcome: string): number {
      close();
      const total = Math.round(now() - start);
      logger[level](`${label}: ${outcome} in ${total} ms`);
      return total;
    },
  };
}
