/**
 * relationshipStateSpace's TWINS state (schema-scoped table identity, stage
 * 6): two schema folders, bqs and ccc, each holding `addresse` and `kunde`,
 * so every table name is shared. Each state is a set of three possible
 * links: `bqs.kunde > bqs.addresse`, the same star in ccc, and
 * `ccc.addresse.ref_id > bqs.addresse.ref_id` (the same column on both ends:
 * two tables, never a self-join). From every state, every canvas
 * relationship edit (add each absent link, remove each present one, turn a
 * present one into one-to-one) goes through the one planner,
 * `planRelationshipWrite`, over models named by library references, and is
 * saved by identity ({@link twinRelationshipEdit}).
 *
 * Checked after every edit: the library reads back exactly the links the
 * edit leaves (each stored once, on the tables of its own schema folder), no
 * table file changed, and the other schema folder's Refs are where and as
 * they were.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { materialiseTwins, readBackTwins, twinRelationshipEdit, type TwinLink } from './relationshipStateSpace.dbmlHarness';
import type { RelationshipWriteOp } from '../../src/services/libraryRelationships';

const LINKS: TwinLink[] = [
  { from: 'bqs.kunde', fromColumn: 'addresse_id', to: 'bqs.addresse', toColumn: 'id', cardinality: 'many-to-one' },
  { from: 'ccc.kunde', fromColumn: 'addresse_id', to: 'ccc.addresse', toColumn: 'id', cardinality: 'many-to-one' },
  { from: 'ccc.addresse', fromColumn: 'ref_id', to: 'bqs.addresse', toColumn: 'ref_id', cardinality: 'many-to-one' },
];

const text = (l: TwinLink): string => `${l.from}.${l.fromColumn} > ${l.to}.${l.toColumn} ${l.cardinality}`;
const ends = (l: TwinLink) => ({ fromModel: l.from, fromColumn: l.fromColumn, toModel: l.to, toColumn: l.toColumn });

/** Every file's bytes under `dir`, by relative path. */
function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf-8');
    }
  };
  walk(dir);
  return out;
}

/** The Ref lines of a relationships file naming only `schema`'s tables. */
const refLinesOf = (all: Record<string, string>, schema: string): string[] =>
  Object.values(all).flatMap((t) => t.split('\n')).filter((l) => l.startsWith('Ref:') && !l.includes(schema === 'bqs' ? 'ccc.' : 'bqs.'));

describe('relationshipStateSpace: the TWINS state (two schema folders, every table name shared)', () => {
  it('every relationship edit from every state leaves exactly the links it means, each on its own schema folder\'s tables', () => {
    let edits = 0;
    for (let state = 0; state < 1 << LINKS.length; state++) {
      const present = LINKS.filter((_, i) => state & (1 << i));
      const ops: Array<{ op: RelationshipWriteOp; expect: TwinLink[]; label: string }> = [];
      for (const link of LINKS) {
        if (present.includes(link)) {
          ops.push({ op: { kind: 'remove', keys: [ends(link)] }, expect: present.filter((l) => l !== link), label: `remove ${text(link)}` });
          if (link.from.endsWith('kunde')) {
            ops.push({
              op: { kind: 'update', ends: ends(link), cardinality: 'one-to-one' },
              expect: present.map((l) => (l === link ? { ...l, cardinality: 'one-to-one' as const } : l)),
              label: `one-to-one ${text(link)}`,
            });
          }
        } else {
          ops.push({ op: { kind: 'add', drawn: { ...ends(link), cardinality: link.cardinality } }, expect: [...present, link], label: `add ${text(link)}` });
        }
      }
      for (const { op, expect: wanted, label } of ops) {
        const project = materialiseTwins(present);
        try {
          const before = files(project.semantic);
          const refusal = twinRelationshipEdit(project.library(), op);
          const where = `state [${present.map(text).join('; ')}], ${label}`;
          expect(refusal, where).toBeUndefined();
          const after = files(project.semantic);
          expect(readBackTwins(project.library()), where).toEqual(wanted.map(text).sort());
          // Only relationships files change: never a table file.
          for (const [file, bytes] of Object.entries(before)) if (file.includes('/tables/')) expect(after[file], `${where}: ${file}`).toBe(bytes);
          // A schema folder the edit does not touch keeps its Ref lines byte for byte.
          const touched = [ends(LINKS.find((l) => label.endsWith(text(l)))!)].flatMap((e) => [e.fromModel, e.toModel]).map((r) => r.split('.')[0]);
          for (const schema of ['bqs', 'ccc']) {
            if (touched.includes(schema)) continue;
            expect(refLinesOf(after, schema), `${where}: ${schema}'s Refs`).toEqual(refLinesOf(before, schema));
          }
          edits++;
        } finally {
          fs.rmSync(project.root, { recursive: true, force: true });
        }
      }
    }
    expect(edits).toBe(8 * 3 + 4 * 2);
  });
});
