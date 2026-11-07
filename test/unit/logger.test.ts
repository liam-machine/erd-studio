/**
 * The ERD Studio log (src/services/logger.ts): levels, the pluggable sink,
 * the console mirror for warn/error, the in-memory buffer Send Feedback's
 * opt-in reads, and the phase timer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LOG_BUFFER_CAPACITY,
  clearLogBuffer,
  createLogger,
  formatLogArg,
  hasLogSink,
  log,
  phaseTimer,
  plural,
  recentLogLines,
  setLogSink,
  writeLog,
  type LogSink,
} from '../../src/services/logger';

function fakeSink(): LogSink & { calls: Array<[string, string, unknown[]]> } {
  const calls: Array<[string, string, unknown[]]> = [];
  const at = (level: string) => (message: string | Error, ...args: unknown[]) => {
    calls.push([level, String(message), args]);
  };
  return { calls, trace: at('trace'), debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

beforeEach(() => {
  clearLogBuffer();
  setLogSink(undefined);
});

afterEach(() => {
  setLogSink(undefined);
  vi.restoreAllMocks();
});

describe('without a sink (CLI, MCP server, tests)', () => {
  it('warn and error go to the console exactly as given; info, debug and trace are silent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const err = new Error('boom');

    log.warn('[X] careful:', err);
    log.error('[X] failed');
    log.info('hello');
    log.debug('detail');
    log.trace('very detailed');

    expect(warn).toHaveBeenCalledWith('[X] careful:', err);
    expect(error).toHaveBeenCalledWith('[X] failed');
    // console.log is the MCP server's protocol stream: never written.
    expect(out).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
    expect(hasLogSink()).toBe(false);
  });

  it('looks the console up on every call, so a swapped console (the CLI capture) receives it', () => {
    const saved = console.warn;
    const captured: unknown[][] = [];
    console.warn = (...args: unknown[]) => { captured.push(args); };
    try {
      log.warn('captured');
    } finally {
      console.warn = saved;
    }
    expect(captured).toEqual([['captured']]);
  });
});

describe('with a sink (the ERD Studio output channel)', () => {
  it('sends every level to the sink, and still mirrors warn and error to the console', () => {
    const sink = fakeSink();
    setLogSink(sink);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const scoped = createLogger('Canvas');
    scoped.trace('t');
    scoped.debug('d');
    scoped.info('i', 3);
    scoped.warn('w');
    scoped.error('e');

    expect(sink.calls).toEqual([
      ['trace', '[Canvas] t', []],
      ['debug', '[Canvas] d', []],
      ['info', '[Canvas] i', [3]],
      ['warn', '[Canvas] w', []],
      ['error', '[Canvas] e', []],
    ]);
    expect(warn).toHaveBeenCalledWith('[Canvas] w');
    expect(error).toHaveBeenCalledWith('[Canvas] e');
    expect(hasLogSink()).toBe(true);
  });

  it('a sink that throws (a disposed channel) never breaks the caller', () => {
    setLogSink({
      trace: () => { throw new Error('disposed'); },
      debug: () => { throw new Error('disposed'); },
      info: () => { throw new Error('disposed'); },
      warn: () => { throw new Error('disposed'); },
      error: () => { throw new Error('disposed'); },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => log.info('still fine')).not.toThrow();
    expect(() => log.error('still fine')).not.toThrow();
  });

  it('mirrorToConsole: false keeps a line out of the console but not out of the sink', () => {
    const sink = fakeSink();
    setLogSink(sink);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeLog('error', 'sink only', [], new Date(), false);
    expect(error).not.toHaveBeenCalled();
    expect(sink.calls).toEqual([['error', 'sink only', []]]);
  });

  it('setLogSink returns the previous sink', () => {
    const a = fakeSink();
    expect(setLogSink(a)).toBeUndefined();
    expect(setLogSink(undefined)).toBe(a);
  });
});

describe('the in-memory buffer', () => {
  it('keeps info, warn and error lines with a timestamp and level, not debug or trace', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeLog('info', 'opened', [], new Date('2026-10-29T01:02:03.000Z'));
    writeLog('debug', 'detail', [], new Date('2026-10-29T01:02:04.000Z'));
    writeLog('trace', 'more detail', [], new Date('2026-10-29T01:02:05.000Z'));
    writeLog('warn', 'careful', [new Error('why')], new Date('2026-10-29T01:02:06.000Z'));
    expect(recentLogLines()).toEqual([
      '2026-10-29T01:02:03.000Z [info] opened',
      '2026-10-29T01:02:06.000Z [warn] careful why',
    ]);
  });

  it(`holds the last ${LOG_BUFFER_CAPACITY} lines, oldest dropped first`, () => {
    for (let i = 0; i < LOG_BUFFER_CAPACITY + 15; i++) log.info(`line ${i}`);
    const lines = recentLogLines();
    expect(lines).toHaveLength(LOG_BUFFER_CAPACITY);
    expect(lines[0]).toMatch(/ line 15$/);
    expect(lines.at(-1)).toMatch(new RegExp(` line ${LOG_BUFFER_CAPACITY + 14}$`));
  });

  it('collapses newlines so one call is one line', () => {
    log.info('first\n  second');
    expect(recentLogLines()[0]).toMatch(/\[info\] first second$/);
  });

  it('is filled whether or not a sink is plugged in', () => {
    log.info('no sink yet');
    setLogSink(fakeSink());
    log.info('with a sink');
    expect(recentLogLines().map((l) => l.replace(/^\S+ /, ''))).toEqual(['[info] no sink yet', '[info] with a sink']);
  });

  it('returns a copy', () => {
    log.info('x');
    recentLogLines().push('tampered');
    expect(recentLogLines()).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('formatLogArg renders errors by message and objects as JSON', () => {
    expect(formatLogArg(new Error('bad'))).toBe('bad');
    expect(formatLogArg({ a: 1 })).toBe('{"a":1}');
    expect(formatLogArg(undefined)).toBe('undefined');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatLogArg(circular)).toBe('[object Object]');
  });

  it('plural', () => {
    expect(plural(1, 'table')).toBe('1 table');
    expect(plural(3, 'table')).toBe('3 tables');
    expect(plural(2, 'copy', 'copies')).toBe('2 copies');
  });

  it('phaseTimer logs each phase when the next starts, then the whole job', () => {
    const sink = fakeSink();
    setLogSink(sink);
    let now = 1000;
    const timer = phaseTimer(createLogger('Convert to DBML'), 'Plan', { now: () => now });
    timer.phase('Reading the project…');
    now += 120;
    timer.phase('Checking the DBML…');
    now += 30;
    expect(timer.end('3 creates')).toBe(150);
    expect(sink.calls.map(([level, message]) => `${level} ${message}`)).toEqual([
      'info [Convert to DBML] Plan: Reading the project… took 120 ms',
      'info [Convert to DBML] Plan: Checking the DBML… took 30 ms',
      'info [Convert to DBML] Plan: 3 creates in 150 ms',
    ]);
  });

  it('phaseTimer at debug level stays out of the buffer', () => {
    setLogSink(fakeSink());
    const timer = phaseTimer(createLogger('Canvas'), 'Refresh x.dbml', { level: 'debug' });
    timer.phase('reading');
    timer.end('posted 3 tables');
    expect(recentLogLines()).toEqual([]);
  });
});
