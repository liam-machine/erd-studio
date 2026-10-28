/**
 * Opening a diagram reads its own tables, not the whole library
 * (`TableLibraryService.readingTables`, `memberAttachment`): each member's
 * relationships must be exactly what an attach over the whole library gives
 * — same entries, same order, same composite keys — whatever the library
 * holds (misplaced Refs, links stored twice, composites, bare one-to-ones,
 * pending Refs, labels, a DBML alias, a dangling end, a file that does not
 * read). And the index is checked once per read, not once per lookup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TableLibraryService } from '../../src/services/logicalModelService';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryIndex } from '../../src/services/tableLibraryIndex';
import { memberAttachment } from '../../src/services/memberAttachment';

let root: string;
let semantic: string;

function write(rel: string, text: string): string {
  const file = path.join(semantic, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-scoped-reads-'));
  semantic = path.join(root, '.erd-studio');
  fs.mkdirSync(semantic, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const service = (): TableLibraryService => new TableLibraryService(root, '.erd-studio');

/** A small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FOLDERS = ['', 'gold', 'silver'];
const HEADER = '// ERD Studio relationships.\n';

interface Built {
  names: string[];
  /** Table name → folder. */
  folderOf: Map<string, string>;
}

/**
 * A random DBML library: tables in three folders (some with a composite key,
 * some declaring a DBML alias when `aliases`), and Refs of every kind spread
 * over the three relationships files — most at home, some misplaced, some
 * stored twice (either way round), composites, bare `-` one-to-ones, labels,
 * pending lines, and (when asked) a dangling end and a broken table file.
 */
function buildLibrary(seed: number, options: { aliases?: boolean; dangling?: boolean; broken?: boolean } = {}): Built {
  const random = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)];
  const names: string[] = [];
  const folderOf = new Map<string, string>();
  const count = 24;
  for (let i = 0; i < count; i++) {
    const name = `t${i}`;
    const folder = pick(FOLDERS);
    names.push(name);
    folderOf.set(name, folder);
    const composite = i % 5 === 0;
    const header = options.aliases && i % 7 === 3 ? `Table ${name} as A${i}` : `Table ${name}`;
    const body = composite
      ? '  id INT\n  id2 INT\n  c0 INT\n  c1 INT\n  c2 INT\n  indexes {\n    (id, id2) [pk]\n  }'
      : '  id INT [pk]\n  c0 INT\n  c1 INT\n  c2 INT';
    write(path.posix.join('tables', folder, `${name}.dbml`), `${header} {\n${body}\n}\n`);
  }
  const files = new Map<string, string[]>(FOLDERS.map((f) => [f, []]));
  const refAt = (folder: string, line: string): void => { files.get(folder)!.push(line); };
  for (let r = 0; r < 70; r++) {
    const owner = pick(names);
    const target = pick(names);
    const home = folderOf.get(owner)!;
    const folder = random() < 0.15 ? pick(FOLDERS) : home;
    const col = pick(['c0', 'c1', 'c2']);
    const kind = random();
    const label = random() < 0.2 ? ` "r${r}"` : '';
    let line: string;
    if (kind < 0.1) {
      line = `Ref${label}: ${owner}.(c0, c1) > ${target}.(id, id2)`;
    } else if (kind < 0.25) {
      // Bare one-to-one: orientation decided by the keys.
      line = random() < 0.5 ? `Ref${label}: ${owner}.${col} - ${target}.id` : `Ref${label}: ${target}.id - ${owner}.${col}`;
    } else if (kind < 0.35) {
      line = `Ref${label}: ${target}.id < ${owner}.${col}`;
    } else if (kind < 0.42) {
      line = `Ref${label}: ${owner}.${col} <> ${target}.${col}`;
    } else {
      line = `Ref${label}: ${owner}.${col} > ${target}.id`;
    }
    if (random() < 0.08) line = `// erd-studio pending: ${line}`;
    refAt(folder, line);
    // Stored twice now and then, sometimes written the other way round.
    if (random() < 0.12) {
      const twice = random() < 0.5 ? line : `Ref: ${target}.id < ${owner}.${col}`;
      refAt(pick(FOLDERS), twice);
    }
  }
  if (options.aliases) {
    // Ends spelled by a DBML alias (t3 declares A3, t10 A10, …).
    refAt('', 'Ref: A3.c0 > t1.id');
    refAt('gold', 'Ref: t2.c1 > A10.id');
  }
  if (options.dangling) refAt('silver', 'Ref: t4.c2 > ghost.id');
  if (options.broken) write(path.posix.join('tables', folderOf.get('t6')!, 't6.dbml'), 'Table t6 {\n  id INT [pk\n');
  for (const [folder, lines] of files) {
    if (lines.length === 0) continue;
    write(path.posix.join('tables', folder, '_relationships.dbml'), `${HEADER}${lines.join('\n')}\n`);
  }
  return { names, folderOf };
}

/** Every member's relationships, read through `readingTables` on a fresh service. */
function scopedRelationships(members: string[]): Record<string, unknown> {
  const library = service();
  return library.readingTables(members, () =>
    Object.fromEntries(members.map((m) => [m, library.getTable(m)?.relationships ?? null])));
}

/** The same, read with the whole library attached (no scope), on another fresh service. */
function wholeLibraryRelationships(members: string[]): Record<string, unknown> {
  const library = service();
  return Object.fromEntries(members.map((m) => [m, library.getTable(m)?.relationships ?? null]));
}

function memberSets(names: string[], seed: number): string[][] {
  const random = rng(seed);
  const sets: string[][] = [names.slice(0, 1), names.slice(0, 5), names, [...names].reverse().slice(0, 9)];
  for (let i = 0; i < 12; i++) sets.push(names.filter(() => random() < 0.3));
  // A member with no table file.
  sets.push(['t0', 'nope', 't3']);
  return sets.filter((s) => s.length > 0);
}

describe('readingTables: a diagram\'s tables get exactly the relationships the whole library gives them', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`random library #${seed}`, () => {
      const { names } = buildLibrary(seed);
      for (const members of memberSets(names, seed)) {
        expect(scopedRelationships(members), members.join(',')).toEqual(wholeLibraryRelationships(members));
      }
    });
  }

  for (const [label, options] of [
    ['DBML aliases on Ref ends', { aliases: true }],
    ['a Ref to a table that does not exist', { dangling: true }],
    ['a table file that does not read', { broken: true }],
    ['all three', { aliases: true, dangling: true, broken: true }],
  ] as const) {
    it(`with ${label}`, () => {
      const { names } = buildLibrary(11, options);
      for (const members of memberSets([...names, 'A3', 'ghost'], 11)) {
        expect(scopedRelationships(members), members.join(',')).toEqual(wholeLibraryRelationships(members));
      }
    });
  }

  it('reads the members and the other ends of their Refs, not every table file', () => {
    const { names } = buildLibrary(7);
    // The table files a service has read: its DBML parse cache.
    const tablesRead = (library: TableLibraryService): string[] => [...(library as unknown as { dbmlCache: Map<string, unknown> }).dbmlCache.keys()];
    const library = service();
    library.readingTables(['t1'], () => library.getTable('t1'));
    const scoped = tablesRead(library);
    expect(scoped.length).toBeLessThan(names.length);
    expect(scoped.some((p) => p.endsWith(`${path.sep}t1.dbml`))).toBe(true);
    // Outside a scope, the whole library is read to attach.
    const whole = service();
    whole.getTable('t1');
    expect(tablesRead(whole)).toHaveLength(names.length);
  });

  it('a library that holds a YAML table attaches over the whole library (a yml may name itself differently)', () => {
    buildLibrary(8);
    write('tables/gold/yml_table.yml', 'name: yml_table\ncolumns:\n  - name: id\n    dataType: INT\n');
    for (const members of [['t1'], ['t1', 't2', 'yml_table']]) {
      expect(scopedRelationships(members)).toEqual(wholeLibraryRelationships(members));
    }
  });

  it('a relationships file changed between two reads is read again', () => {
    write('tables/a.dbml', 'Table a {\n  id INT [pk]\n  b_id INT\n  c INT\n}\n');
    write('tables/b.dbml', 'Table b {\n  id INT [pk]\n}\n');
    write('tables/_relationships.dbml', `${HEADER}Ref: a.b_id > b.id\n`);
    const library = service();
    expect(library.readingTables(['a'], () => library.getTable('a'))?.relationships).toHaveLength(1);
    write('tables/_relationships.dbml', `${HEADER}Ref: a.b_id > b.id\nRef: a.c > b.id\n`);
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(semantic, 'tables/_relationships.dbml'), later, later);
    expect(library.readingTables(['a'], () => library.getTable('a'))?.relationships).toHaveLength(2);
  });

  it('getSubjectArea reads a DBML diagram\'s members with the same relationships as before', () => {
    const { names } = buildLibrary(9);
    const members = names.slice(0, 10);
    write('gold/d.dbml', `Project d {\n  erd_schema_version: '7'\n}\n\n${members.map((m) => `use { table ${m} } from '../tables/${m}.dbml'`).join('\n')}\n`);
    const layers = new LayerService(root, '.erd-studio');
    const domains = new SubjectAreaService(layers);
    const library = service();
    domains.setTableLibraryService(library);
    const area = domains.getSubjectArea(path.join(semantic, 'gold/d.dbml'));
    const drawn = Object.fromEntries(area.logical.models.map((m) => [m.name, m.relationships ?? null]));
    expect(drawn).toEqual(wholeLibraryRelationships(area.logical.models.map((m) => m.name)));
  });
});

describe('memberAttachment', () => {
  const reading = (refs: Array<[string, string]>) => ({
    readable: true,
    problems: [],
    refs: refs.map(([from, to], i) => ({
      line: i + 1,
      relationships: [{ fromModel: from, fromColumn: 'x', toModel: to, toColumn: 'id', cardinality: 'many-to-one' as const }],
    })),
  });
  const table = (name: string) => ({ table: { name, columns: [{ name: 'id', dataType: 'INT', isPrimaryKey: true }, { name: 'x', dataType: 'INT' }] }, folder: '', storage: 'dbml' as const });

  it('resolves only the ends of Refs that name a member', () => {
    const asked: string[] = [];
    const resolve = (key: string) => { asked.push(key); return table(key); };
    const result = memberAttachment([{ path: 'tables/_relationships.dbml', reading: reading([['a', 'b'], ['c', 'd'], ['e', 'a']]) as never }], new Set(['a']), resolve);
    expect(result?.byOwner.get('a')).toHaveLength(1);
    expect(result?.byOwner.get('e')).toHaveLength(1);
    expect(new Set(asked)).toEqual(new Set(['a', 'b', 'e']));
  });

  it('gives up (null) when an end it needs does not resolve by name', () => {
    const resolve = (key: string) => (key === 'ghost' ? undefined : table(key));
    expect(memberAttachment([{ path: 'tables/_relationships.dbml', reading: reading([['a', 'ghost']]) as never }], new Set(['a']), resolve)).toBeNull();
    // A Ref that does not touch the members never asks.
    expect(memberAttachment([{ path: 'tables/_relationships.dbml', reading: reading([['b', 'ghost']]) as never }], new Set(['a']), resolve)).not.toBeNull();
  });
});

describe('TableLibraryIndex.withSnapshot', () => {
  it('trusts the index it checked for the rest of the snapshot, and checks again in the next one', () => {
    write('tables/a.dbml', 'Table a {\n  id INT [pk]\n}\n');
    const index = new TableLibraryIndex(semantic, path.join(semantic, 'logical-models'), path.join(semantic, 'tables'));
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(semantic, 'tables'), past, past);
    index.get();
    const later = new Date(Date.now() + 5_000);
    index.withSnapshot(() => {
      expect(index.find('b')).toBeNull();
      // A file added mid-snapshot: the snapshot keeps answering from the index it checked.
      write('tables/b.dbml', 'Table b {\n  id INT [pk]\n}\n');
      fs.utimesSync(path.join(semantic, 'tables'), later, later);
      expect(index.find('b')).toBeNull();
    });
    // The next lookup checks the directories again and sees it.
    expect(index.find('b')).toBe(path.join(semantic, 'tables', 'b.dbml'));
  });

  it('sees a file added outside ERD Studio on the first lookup after the snapshot', () => {
    write('tables/a.dbml', 'Table a {\n  id INT [pk]\n}\n');
    const library = service();
    expect(library.withIndexSnapshot(() => library.findTableNameIgnoringCase('b'))).toBeNull();
    write('tables/b.dbml', 'Table b {\n  id INT [pk]\n}\n');
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(semantic, 'tables'), later, later);
    expect(library.withIndexSnapshot(() => library.findTableNameIgnoringCase('b'))).toBe('b');
  });

  it('an invalidate inside a snapshot lists the library again', () => {
    write('tables/a.dbml', 'Table a {\n  id INT [pk]\n}\n');
    const index = new TableLibraryIndex(semantic, path.join(semantic, 'logical-models'), path.join(semantic, 'tables'));
    index.withSnapshot(() => {
      index.get();
      const builds = index.builds;
      index.invalidate();
      index.get();
      expect(index.builds).toBe(builds + 1);
    });
  });
});
