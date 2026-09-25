import { describe, expect, it } from 'vitest';

import { CliUsageError, parseArgs } from '../../src/cli/args';
import { main } from '../../src/cli/index';

function capture(): { io: Parameters<typeof main>[1]; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    io: { stdout: { write: (s: string) => { out += s; } }, stderr: { write: (s: string) => { err += s; } }, cwd: process.cwd(), env: {} },
    out: () => out,
    err: () => err,
  };
}

describe('parseArgs', () => {
  it('parses a command with flags before and after it, in both value forms', () => {
    const opts = parseArgs(['--json', 'diff', '--domain', 'a.json', '--domain=b.json', '--project=p', '--strict']);
    expect(opts).toMatchObject({ command: 'diff', json: true, domains: ['a.json', 'b.json'], project: 'p', strict: true });
  });

  it('defaults', () => {
    expect(parseArgs(['doctor'])).toMatchObject({ command: 'doctor', semanticDir: '.erd-studio', json: false, noDbt: false });
    expect(parseArgs([]).command).toBe('help');
    expect(parseArgs(['--version']).command).toBe('version');
    expect(parseArgs(['diff', '--help']).command).toBe('help');
  });

  it('splits and dedupes --models', () => {
    expect(parseArgs(['inventory', '--models', 'a, b,,a', '--models', 'c']).models).toEqual(['a', 'b', 'c']);
  });

  it('accepts doctor --dbt and --no-dbt', () => {
    expect(parseArgs(['doctor', '--dbt', '/opt/dbt', '--no-dbt'])).toMatchObject({ dbt: '/opt/dbt', noDbt: true });
  });

  it.each([
    [['frobnicate'], /Unknown command/],
    [['doctor', '--nope'], /Unknown option --nope/],
    [['doctor', '--strict'], /not an option of "doctor"/],
    [['inventory', '--all'], /not an option of "inventory"/],
    [['diff'], /--domain <path> or --all/],
    [['diff', '--all', '--domain', 'x'], /either --domain or --all/],
    [['diff', '--domain'], /needs a value/],
    [['diff', '--all=yes'], /does not take a value/],
    [['doctor', 'diff'], /Unexpected argument/],
    [['doctor', '--semantic-dir', '../elsewhere'], /inside the project/],
    [['doctor', '--semantic-dir', '/abs'], /inside the project/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(CliUsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it('normalises --semantic-dir', () => {
    expect(parseArgs(['doctor', '--semantic-dir', './custom\\erd/']).semanticDir).toBe('custom/erd');
  });
});

describe('main — usage and version', () => {
  it('exits 2 on a usage error, with JSON on stdout when --json was asked for', async () => {
    const c = capture();
    expect(await main(['diff', '--json'], c.io)).toBe(2);
    expect(JSON.parse(c.out()).error.code).toBe('usage');
    expect(c.err()).toContain('Usage:');
  });

  it('version prints { cliVersion, runtime }', async () => {
    const c = capture();
    expect(await main(['version', '--json'], c.io)).toBe(0);
    const result = JSON.parse(c.out());
    expect(typeof result.cliVersion).toBe('string');
    expect(result.runtime).toEqual({ kind: 'node', version: process.versions.node });
  });

  it('help exits 0', async () => {
    const c = capture();
    expect(await main(['--help'], c.io)).toBe(0);
    expect(c.out()).toContain('erd-studio doctor');
  });
});
