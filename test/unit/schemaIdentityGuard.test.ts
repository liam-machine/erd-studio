/**
 * The guard for schema-scoped table identity: nothing about an existing
 * project changes. A table's identity became its schema folder and name, and
 * a diagram names a table `schema.name` only where two of its members share
 * a bare name. No diagram in the repo has such a pair, so every one must read
 * exactly as it did before identities existed.
 *
 * Two pins, both made by the code as it was before the change and never
 * regenerated (this test has no write mode):
 *
 * - `identity-guard/golden-hashes.json`: the SHA-256 of every file that was
 *   in packages/core/test/fixtures/golden. A golden may change only by an
 *   intended rendering change, which then updates this list in the same commit.
 * - `identity-guard/existing-diagrams.json`: for every DBML diagram that was
 *   in docs/examples, packages/core/test/fixtures/dbml and test/fixtures, what the core reader and loader call its
 *   tables: the reading's members, the drawn tables' names, the positions'
 *   keys, the relationship ends and the sticky notes' links.
 */

import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { loadDisplaySubjectArea } from '../../packages/core/src/loadDisplayDomain';
import { dbmlStorageReader } from '../../packages/core/src/dbml/index';

const REPO_ROOT = path.resolve(__dirname, '../..');
const GUARD_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'identity-guard');
const GOLDEN_DIR = path.join(REPO_ROOT, 'packages', 'core', 'test', 'fixtures', 'golden');

/** What core calls the tables of one diagram: the reading, then the loaded DisplaySubjectArea. */
async function namesOf(diagram: string): Promise<Record<string, unknown>> {
  const full = path.join(REPO_ROOT, diagram);
  const text = fs.readFileSync(full, 'utf-8');
  let members: string[] | string;
  try {
    members = dbmlStorageReader.parseSubjectArea(text, diagram).members;
  } catch (err) {
    members = `throws: ${err instanceof Error ? err.message : String(err)}`;
  }
  // The diagram's semantic dir is three folders up; readFile serves paths from there.
  const semanticDir = path.dirname(path.dirname(path.dirname(full)));
  const domainPath = path.relative(semanticDir, full).split(path.sep).join('/');
  try {
    const display = await loadDisplaySubjectArea({
      domainPath,
      readFile: async (p) => {
        try {
          return fs.readFileSync(path.join(semanticDir, p), 'utf-8');
        } catch {
          return null;
        }
      },
      readOnly: true,
      warn: () => {},
      dbml: dbmlStorageReader,
    });
    return {
      members,
      models: display.models.map((m) => m.name),
      positions: Object.keys(display.viewConfig.positions ?? {}),
      relationships: display.relationships.map((r) => `${r.fromModel}.${r.fromColumn} > ${r.toModel}.${r.toColumn}`),
      linked: (display.viewConfig.annotations ?? []).map((a) => a.linkedModel ?? null),
      stubColumns: display.stubColumns ?? [],
    };
  } catch (err) {
    return { members, loads: `throws: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const sha256 = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('schema-scoped identity changes nothing about an existing project', () => {
  it('every golden that existed before the change is byte-identical', () => {
    const pinned = JSON.parse(fs.readFileSync(path.join(GUARD_DIR, 'golden-hashes.json'), 'utf-8')) as Record<string, string>;
    const actual = Object.fromEntries(Object.keys(pinned).map((file) => [file, fs.existsSync(path.join(GOLDEN_DIR, file)) ? sha256(path.join(GOLDEN_DIR, file)) : 'missing']));
    expect(actual).toEqual(pinned);
  });

  it('every existing DBML diagram names its tables, positions, relationship ends and sticky links exactly as before', async () => {
    const pinned = JSON.parse(fs.readFileSync(path.join(GUARD_DIR, 'existing-diagrams.json'), 'utf-8')) as Record<string, unknown>;
    const actual: Record<string, unknown> = {};
    for (const diagram of Object.keys(pinned)) actual[diagram] = await namesOf(diagram);
    expect(actual).toEqual(pinned);
    // A diagram added since is not pinned here: it is new, not existing.
    expect(Object.keys(pinned).length).toBeGreaterThan(50);
  });
});

