/**
 * The parser-free `erd_layout` codec (§1.6 of the 2.0 design): the decoded
 * value read and written in canonical form, the 2-vs-4 note numbers, the
 * case rule for member lines, the placing of unlaid sticky notes, and a
 * seeded property test of read(render(x)) = canonical(x).
 */
import { describe, it, expect } from 'vitest';

import {
  erdLayoutOf,
  isErdLayoutName,
  placeUnlaidStickies,
  readErdLayout,
  renderErdLayoutValue,
  roundLayoutNumber,
  sameErdLayout,
  withMemberSpelling,
  type ErdLayout,
  type ErdLayoutSticky,
} from '../../src/erdLayout';
import type { Annotation, NodePosition } from '../../src/types/semantic';
import { mulberry32 } from '../dbmlWriterSupport';

const note = (id: string, x: number, y: number, size: { width?: number; height?: number } = {}): Annotation => ({ id, text: '', x, y, ...size });
const render = (layout: ErdLayout, eol = '\n', indent = '  '): string | undefined => renderErdLayoutValue(layout, { eol, indent });
const linesOf = (value: string | undefined): string[] => (value ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');

describe('renderErdLayoutValue and readErdLayout', () => {
  it('round trip: tables then notes, each sorted, in the value shape of the key line', () => {
    const layout = erdLayoutOf(
      { fct_order: { x: 400, y: 200 }, dim_customer: { x: 40, y: 60 } },
      [note('9a0d', 1120, 200), note('3f2b', 1120, 40, { width: 220, height: 120 })],
    );
    const value = render(layout, '\n', '  ');
    expect(value).toBe('\n    dim_customer 40 60\n    fct_order 400 200\n    note/3f2b 1120 40 220 120\n    note/9a0d 1120 200\n  ');
    const read = readErdLayout(value!);
    expect(read.problems).toEqual([]);
    expect(read.positions).toEqual(layout.positions);
    expect(read.stickies).toEqual(layout.stickies);
    expect(sameErdLayout(read, layout)).toBe(true);
  });

  it('sorts names in code-unit order, never by locale', () => {
    const value = render(erdLayoutOf({ a: { x: 1, y: 1 }, B: { x: 2, y: 2 }, _c: { x: 3, y: 3 }, '10': { x: 4, y: 4 }, '9': { x: 5, y: 5 } }, []));
    expect(linesOf(value).map((l) => l.split(' ')[0])).toEqual(['10', '9', 'B', '_c', 'a']);
  });

  it('writes numbers with at most two decimals, in the shortest form, with no -0', () => {
    expect(roundLayoutNumber(-0)).toBe(0);
    expect(Object.is(roundLayoutNumber(-0.001), 0)).toBe(true);
    expect(roundLayoutNumber(0.005)).toBe(0.01);
    expect(roundLayoutNumber(12.345)).toBe(12.35);
    expect(roundLayoutNumber(1.5)).toBe(1.5);
    expect(roundLayoutNumber(1e21)).toBe(1e21);
    const value = render(erdLayoutOf({ a: { x: -0, y: 12.345 }, b: { x: 0.005, y: -2 }, c: { x: 1e21, y: 0.25 } }, []));
    expect(linesOf(value)).toEqual(['a 0 12.35', 'b 0.01 -2', 'c 1e+21 0.25']);
    // What is written reads back as itself.
    const read = readErdLayout(value!);
    expect(render(read)).toBe(value);
    expect(read.positions.c).toEqual({ x: 1e21, y: 0.25 });
  });

  it('is idempotent at large magnitudes too (whole numbers from 1e12 up)', () => {
    for (const n of [43168711191050.016, -39725002413204.914, 999999999999.996, 1e300]) {
      const once = roundLayoutNumber(n);
      expect(roundLayoutNumber(Number(String(once)))).toBe(once);
    }
  });

  it("reads and writes names with spaces, tabs, ' and \\ (parsed from the right)", () => {
    const names = ['my table', 'tab\there', "it's", 'back\\slash', '1 2', 'x 1.5'];
    const positions: Record<string, NodePosition> = {};
    names.forEach((name, i) => { positions[name] = { x: i, y: -i }; });
    const layout = erdLayoutOf(positions, []);
    const read = readErdLayout(render(layout)!);
    expect(read.problems).toEqual([]);
    expect(read.positions).toEqual(layout.positions);
    expect(Object.keys(read.positions).sort()).toEqual([...names].sort());
  });

  it('skips names erd_layout cannot hold', () => {
    expect(isErdLayoutName('a')).toBe(true);
    for (const bad of ['', ' a', 'a ', 'a\nb', 'a\r', 3, undefined]) expect(isErdLayoutName(bad)).toBe(false);
    const layout = erdLayoutOf(
      { ok: { x: 1, y: 1 }, ' lead': { x: 1, y: 1 }, 'trail ': { x: 1, y: 1 }, 'two\nlines': { x: 1, y: 1 }, 'note/x': { x: 1, y: 1 } },
      [note('fine', 1, 1), note(' pad', 1, 1), note('a\nb', 1, 1)],
    );
    expect(Object.keys(layout.positions)).toEqual(['ok']);
    expect(layout.stickies.map((s) => s.id)).toEqual(['fine']);
  });

  it('keeps a name such as __proto__ as an entry like any other', () => {
    const read = readErdLayout('\n  __proto__ 1 2\n');
    expect(Object.keys(read.positions)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(read.positions)).toBe(Object.prototype);
  });
});

describe('note lines', () => {
  it('a note with four numbers is sized; with two, unsized; 0 reads back as no size', () => {
    const read = readErdLayout('\n  note/a 1 2 220 120\n  note/b 3 4\n  note/c 5 6 0 0\n  note/d 7 8 200 0\n  note/e 9 9 -5 50\n');
    expect(read.problems).toEqual([]);
    expect(read.stickies).toEqual([
      { id: 'a', x: 1, y: 2, width: 220, height: 120 },
      { id: 'b', x: 3, y: 4 },
      { id: 'c', x: 5, y: 6 },
      { id: 'd', x: 7, y: 8, width: 200 },
      { id: 'e', x: 9, y: 9, height: 50 },
    ]);
  });

  it('a width-only note writes 0 for its height, and reads back the same', () => {
    const layout = erdLayoutOf({}, [note('w', 10, 20, { width: 200 }), note('h', 1, 2, { height: 90 })]);
    expect(linesOf(render(layout))).toEqual(['note/h 1 2 0 90', 'note/w 10 20 200 0']);
    expect(readErdLayout(render(layout)!).stickies).toEqual(layout.stickies);
  });

  it('settles a line that reads both ways by the diagram\'s Note names', () => {
    const line = '\n  note/q 1 2 3 4\n';
    // Only the 2-number id is a Note: `q 1 2` at (3, 4), unsized.
    expect(readErdLayout(line, new Set(['q 1 2'])).stickies).toEqual([{ id: 'q 1 2', x: 3, y: 4 }]);
    // Only the 4-number id is a Note: `q` at (1, 2), sized 3 × 4.
    expect(readErdLayout(line, new Set(['q'])).stickies).toEqual([{ id: 'q', x: 1, y: 2, width: 3, height: 4 }]);
    // Both, neither, or no names given: the sized reading.
    expect(readErdLayout(line, new Set(['q', 'q 1 2'])).stickies[0].id).toBe('q');
    expect(readErdLayout(line, new Set()).stickies[0].id).toBe('q');
    expect(readErdLayout(line).stickies[0].id).toBe('q');
  });

  it('an unsized note whose id ends in two numbers round trips when its id is a Note', () => {
    const layout = erdLayoutOf({}, [note('memo 7 8', 30, 40)]);
    expect(readErdLayout(render(layout)!, new Set(['memo 7 8'])).stickies).toEqual(layout.stickies);
  });
});

describe('problems', () => {
  it('the first line for a name wins; a later one is a duplicate', () => {
    const read = readErdLayout('\n  a 1 2\n  a 3 4\n  note/n 1 1\n  note/n 2 2\n');
    expect(read.positions).toEqual({ a: { x: 1, y: 2 } });
    expect(read.stickies).toEqual([{ id: 'n', x: 1, y: 1 }]);
    expect(read.problems.map((p) => [p.index, p.kind])).toEqual([[2, 'duplicate'], [4, 'duplicate']]);
    expect(read.problems[0].message).toMatch(/a is listed twice in erd_layout; the first is read/);
  });

  it('a bad line is skipped with its index; blank lines are skipped silently', () => {
    const read = readErdLayout('\n  a 1 2\n\n  just_a_name\n  b x 4\n  c 1 2 3\n  d Infinity 2\n  e 1e999 2\n  note/ 1 2\n  f 5 6\n');
    expect(read.positions).toEqual({ a: { x: 1, y: 2 }, 'c 1': { x: 2, y: 3 }, f: { x: 5, y: 6 } });
    expect(read.problems.filter((p) => p.kind === 'badLine').map((p) => p.index)).toEqual([3, 4, 6, 7, 8]);
    expect(read.problems[0].message).toMatch(/line 4 of erd_layout is not <name> <x> <y>; it is skipped and that table is placed automatically/);
  });

  it('conflict markers: skipped, first copy wins, the first marker\'s index is reported', () => {
    const value = '\n  a 1 2\n<<<<<<< HEAD\n  b 3 4\n||||||| base\n  b 0 0\n=======\n  b 5 6\n>>>>>>> theirs\n  ';
    const read = readErdLayout(value);
    expect(read.conflictIndex).toBe(2);
    expect(read.positions).toEqual({ a: { x: 1, y: 2 }, b: { x: 3, y: 4 } });
    expect(read.problems.every((p) => p.kind === 'duplicate')).toBe(true);
    expect(readErdLayout('\n  a 1 2\n').conflictIndex).toBeUndefined();
    // A lone marker-like line is skipped but is no conflict.
    expect(readErdLayout('\n  =======\n  a 1 2\n').conflictIndex).toBeUndefined();
  });
});

describe('erdLayoutOf', () => {
  it('skips NaN and Infinity: positions, note places and note sizes; nothing non-finite is rendered', () => {
    const layout = erdLayoutOf(
      { a: { x: NaN, y: 1 }, b: { x: 1, y: Infinity }, c: { x: 1, y: 2 }, d: null as unknown as NodePosition },
      [note('n1', NaN, 1), note('n2', 1, 2, { width: NaN, height: Infinity }), note('n3', 3, 4, { width: -Infinity, height: 50 })],
    );
    expect(layout.positions).toEqual({ c: { x: 1, y: 2 } });
    expect(layout.stickies).toEqual([{ id: 'n2', x: 1, y: 2 }, { id: 'n3', x: 3, y: 4, height: 50 }]);
    expect(render(layout)).not.toMatch(/NaN|Infinity/);
    expect(render(erdLayoutOf({ a: { x: NaN, y: NaN } }, [note('n', Infinity, 0)]))).toBeUndefined();
  });

  it('a repeated note id keeps its first box; undefined input is empty', () => {
    expect(erdLayoutOf(undefined, [note('n', 1, 1), note('n', 2, 2)]).stickies).toEqual([{ id: 'n', x: 1, y: 1 }]);
    expect(erdLayoutOf(undefined, undefined)).toEqual({ positions: {}, stickies: [] });
    expect(render({ positions: {}, stickies: [] })).toBeUndefined();
  });

  it('sameErdLayout compares canonical lines (rounding and order do not count)', () => {
    const a: ErdLayout = { positions: { x: { x: 1.004, y: 2 }, y: { x: 0, y: 0 } }, stickies: [{ id: 'n', x: 1, y: 1, width: 0 }] };
    const b: ErdLayout = { positions: { y: { x: -0, y: 0 }, x: { x: 1, y: 2 } }, stickies: [{ id: 'n', x: 1, y: 1 }] };
    expect(sameErdLayout(a, b)).toBe(true);
    expect(sameErdLayout(a, { ...b, stickies: [] })).toBe(false);
  });
});

describe('withMemberSpelling (the writer\'s case rule)', () => {
  it('rendering a layout whose positions hold dim_customer drops an existing Dim_Customer line', () => {
    const layout: ErdLayout = { positions: { Dim_Customer: { x: 1, y: 2 }, dim_customer: { x: 10, y: 20 }, stray: { x: 5, y: 5 } }, stickies: [] };
    const written = withMemberSpelling(layout, ['dim_customer', 'fct_order']);
    expect(written.positions).toEqual({ dim_customer: { x: 10, y: 20 }, stray: { x: 5, y: 5 } });
    expect(linesOf(render(written))).toEqual(['dim_customer 10 20', 'stray 5 5']);
  });

  it('a member with only a case variant takes it, spelled as the member', () => {
    const layout: ErdLayout = { positions: { DIM_DATE: { x: 3, y: 4 } }, stickies: [] };
    expect(withMemberSpelling(layout, ['dim_date']).positions).toEqual({ dim_date: { x: 3, y: 4 } });
  });

  it('keeps notes and strays as they are', () => {
    const stickies: ErdLayoutSticky[] = [{ id: 'n', x: 1, y: 1 }];
    const layout: ErdLayout = { positions: { other: { x: 1, y: 1 } }, stickies };
    expect(withMemberSpelling(layout, ['a'])).toEqual({ positions: { other: { x: 1, y: 1 } }, stickies });
  });
});

describe('placeUnlaidStickies', () => {
  const positions = { a: { x: 0, y: 100 }, b: { x: 600, y: 300 } };
  const laid: ErdLayoutSticky[] = [{ id: 'n1', x: 900, y: 50, width: 200 }];

  it('places only notes without a layout, in one column right of everything, 40 px apart, in file order', () => {
    const placed = placeUnlaidStickies(['n1', 'n2', 'n3'], positions, laid);
    expect(Object.keys(placed)).toEqual(['n2', 'n3']);
    // Right edge: max(600 + 280, 900 + 200) = 1100, plus the 40 px gap.
    expect(placed.n2).toEqual({ x: 1140, y: 50 });
    expect(placed.n3).toEqual({ x: 1140, y: 50 + 80 + 40 });
  });

  it('is deterministic', () => {
    expect(placeUnlaidStickies(['x', 'y'], positions, laid)).toEqual(placeUnlaidStickies(['x', 'y'], positions, laid));
  });

  it('never overlaps a laid-out table or note', () => {
    const placed = placeUnlaidStickies(['p', 'q', 'r', 's'], positions, laid);
    const boxes = [
      ...Object.values(positions).map((p) => ({ x: p.x, y: p.y, w: 280, h: 200 })),
      ...laid.map((l) => ({ x: l.x, y: l.y, w: l.width ?? 160, h: 80 })),
    ];
    for (const placedNote of Object.values(placed)) {
      for (const box of boxes) {
        const apart = placedNote.x >= box.x + box.w || placedNote.x + 160 <= box.x || placedNote.y >= box.y + box.h || placedNote.y + 80 <= box.y;
        expect(apart).toBe(true);
      }
    }
  });

  it('starts at the origin on an empty canvas, and places a repeated id once', () => {
    expect(placeUnlaidStickies(['a', 'a', 'b'], {}, [])).toEqual({ a: { x: 0, y: 0 }, b: { x: 0, y: 120 } });
    expect(placeUnlaidStickies([], positions, laid)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The seeded property test
// ---------------------------------------------------------------------------

const SEED = Number(process.env.ERD_LAYOUT_SEED ?? 20261030);
const CASES = 2000;
const NAME_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 \t_'\\-.";

describe(`read(render(x)) is canonical(x), over a seeded generator (ERD_LAYOUT_SEED=${SEED})`, () => {
  it(`holds for ${CASES} random layouts`, () => {
    const rand = mulberry32(SEED);
    const int = (n: number): number => Math.floor(rand() * n);
    const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)];
    const name = (): string => {
      const length = 1 + int(12);
      let out = '';
      for (let i = 0; i < length; i++) out += NAME_CHARS[int(NAME_CHARS.length)];
      // Now and then an id ending in numeric words, the 2-vs-4 case.
      if (rand() < 0.15) out += ` ${int(100)} ${int(100)}`;
      return out.trim();
    };
    const num = (): number => pick([
      () => int(4000) - 2000,
      () => (rand() - 0.5) * 5000,
      () => -0,
      () => rand() * 1e-3,
      () => Math.round(rand() * 1000) / 4,
      () => (rand() - 0.5) * 1e9,
    ])();
    let checked = 0;
    for (let c = 0; c < CASES; c++) {
      const positions: Record<string, NodePosition> = {};
      const tableCount = int(8);
      for (let i = 0; i < tableCount; i++) {
        const n = name();
        if (n !== '') positions[n] = { x: num(), y: num() };
      }
      const annotations: Annotation[] = [];
      const noteCount = int(4);
      for (let i = 0; i < noteCount; i++) {
        const id = name();
        if (id === '') continue;
        const size: { width?: number; height?: number } = {};
        if (rand() < 0.5) size.width = rand() < 0.2 ? 0 : Math.abs(num());
        if (rand() < 0.5) size.height = rand() < 0.2 ? -1 : Math.abs(num());
        annotations.push(note(id, num(), num(), size));
      }
      const canonical = erdLayoutOf(positions, annotations);
      const noteIds = new Set(canonical.stickies.map((s) => s.id));
      // A line two Note names both read (`q` sized, `q 1 2` unsized) is the format's one true
      // ambiguity; the generator leaves such pairs out, as no hand-written diagram can tell them apart.
      const ambiguous = canonical.stickies.some((s) => {
        const trailing = /^(.*?\S)\s+\S+\s+\S+$/.exec(s.id);
        return (trailing && noteIds.has(trailing[1])) || [...noteIds].some((other) => other !== s.id && other.startsWith(`${s.id} `) && /^\S+\s+\S+$/.test(other.slice(s.id.length + 1)));
      });
      if (ambiguous) continue;
      const eol = rand() < 0.5 ? '\n' : '\r\n';
      const indent = pick(['  ', '    ', '\t', '']);
      const value = renderErdLayoutValue(canonical, { eol, indent });
      if (value === undefined) {
        expect(Object.keys(canonical.positions).length + canonical.stickies.length, `case ${c}`).toBe(0);
        continue;
      }
      const read = readErdLayout(value, noteIds);
      expect(read.problems, `case ${c}: ${JSON.stringify(value)}`).toEqual([]);
      expect(read.positions, `case ${c}: ${JSON.stringify(value)}`).toEqual(canonical.positions);
      expect(read.stickies, `case ${c}: ${JSON.stringify(value)}`).toEqual(canonical.stickies);
      expect(renderErdLayoutValue(read, { eol, indent }), `case ${c}`).toBe(value);
      checked++;
    }
    // The generator's skips (empty and ambiguous cases) stay rare.
    expect(checked).toBeGreaterThan(CASES * 0.8);
  });
});
