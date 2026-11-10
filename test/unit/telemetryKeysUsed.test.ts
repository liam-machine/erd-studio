/**
 * Telemetry 2.0 (plan item B0 step 4): a key is only appended to the
 * allowlists when something records it. Every FEATURES and ERROR_CODES key
 * from the first 2.0 key onward must appear as a quoted literal somewhere in
 * src/, webview/ or webview-draft/ outside the allowlists themselves (a call
 * site, or a fixed table a call site reads). The rest of telemetryPayload.ts
 * counts: its pure reducers record some keys (versionMixed, heartbeatTrimmed,
 * the ttf* buckets). A key nothing records would sit in the Worker's list
 * forever, always zero, and read as "never happens".
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ERROR_CODES, FEATURES, TRAIL_MARKERS } from '../../src/services/telemetryPayload';

const ROOT = path.resolve(__dirname, '../..');
const DIRS = ['src', 'webview', 'webview-draft'];
const PAYLOAD = path.join(ROOT, 'src/services/telemetryPayload.ts');

/** The first key each list gained in 2.0.0. */
const FIRST_2_0_FEATURE = 'heartbeatProvisional';
const FIRST_2_0_ERROR = 'activationFailed';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** telemetryPayload.ts without the three allowlist literals. */
function withoutAllowlists(text: string): string {
  let out = text;
  for (const name of ['FEATURES', 'ERROR_CODES', 'TRAIL_MARKERS']) {
    const start = out.indexOf(`export const ${name} = [`);
    expect(start, `${name} literal found`).toBeGreaterThan(-1);
    const end = out.indexOf('] as const;', start);
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

const corpus = DIRS.flatMap(d => sourceFiles(path.join(ROOT, d)))
  .map(f => (f === PAYLOAD ? withoutAllowlists(fs.readFileSync(f, 'utf8')) : fs.readFileSync(f, 'utf8')))
  .join('\n')
  .split('\n')
  // A key named only in a comment is not recorded.
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n');

function quoted(key: string): boolean {
  return corpus.includes(`'${key}'`) || corpus.includes(`"${key}"`) || corpus.includes(`\`${key}\``);
}

function from<T extends string>(list: readonly T[], first: T): T[] {
  const at = list.indexOf(first);
  expect(at, `${first} is in the list`).toBeGreaterThan(-1);
  return list.slice(at);
}

describe('telemetry 2.0 keys are recorded somewhere', () => {
  it('every 2.0 feature appears quoted outside the allowlists', () => {
    const unused = from(FEATURES, FIRST_2_0_FEATURE).filter(k => !quoted(k));
    expect(unused).toEqual([]);
  });

  it('every 2.0 error code appears quoted outside the allowlists', () => {
    const unused = from(ERROR_CODES, FIRST_2_0_ERROR).filter(k => !quoted(k));
    expect(unused).toEqual([]);
  });

  it('the 2.0 trail marker is recorded', () => {
    expect(TRAIL_MARKERS).toContain('dayContinued');
    expect(quoted('dayContinued')).toBe(true);
  });

  it('the first 2.0 error code follows the last 1.x one', () => {
    // Guards FIRST_2_0_ERROR: the key before it is the last one 1.x shipped.
    expect(ERROR_CODES[ERROR_CODES.indexOf(FIRST_2_0_ERROR) - 1]).toBe('manifestRetryFailed');
    expect(FEATURES[FEATURES.indexOf(FIRST_2_0_FEATURE) - 1]).toBe('dbtCompileNoStart');
  });
});
