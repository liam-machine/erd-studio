/**
 * `erd_layout` in a DBML diagram (§1.6 and §2.1 of the 2.0 design), under
 * every pinned parser: the value read from the AST (the FIRST entry, decoded
 * by the parser), the problems, the entry's span, and the layout-only edit,
 * which splices one span and never formats. Every text the edit writes must
 * compile in 9.1.1, 10.3.1 and 11.0.0.
 */
import { describe, it, expect } from 'vitest';

import { editDiagramLayoutDbml, erdLayoutEntrySpan, readErdLayoutDbml } from '../../src/dbml/erdLayoutDbml';
import { DbmlEditRefused } from '../../src/dbml/errors';
import { compileOne, parseSyntax } from '../../src/dbml/parser';
import type { DbmlParserModule } from '../../src/dbml/parserModule';
import type { Annotation, NodePosition } from '../../src/types/semantic';
import { STORAGE_PARSERS } from '../dbmlParsers';

const FILE = 'gold/diagrams/sales.dbml';

const SALES = `// Sales, by Liam

Note "3f2b" [color: #f59e0b] {
  'Check the grain'
}

Project sales {
  Note: 'Sales'
  erd_schema_version: '7'
  erd_layout: '''
    dim_customer 40 60
    fct_order 400 200
    note/3f2b 720 40 220 120
  '''
}
`;

const notes: Annotation[] = [{ id: '3f2b', text: 'Check the grain', x: 720, y: 40, width: 220, height: 120 }];

/** Every text written must compile, with no error, in each parser. */
function expectCompiles(text: string): void {
  for (const [label, parser] of STORAGE_PARSERS) {
    const compiled = compileOne(text.replace(/^﻿/, ''), parser);
    expect(compiled.errors.map((e) => `${label} [${e.code}] ${e.message}`)).toEqual([]);
  }
}

describe.each(STORAGE_PARSERS)('erd_layout under %s', (_label, parser: DbmlParserModule) => {
  const edit = (text: string, positions: Record<string, NodePosition>, annotations: readonly Annotation[] = notes, members?: string[]): string => {
    const out = editDiagramLayoutDbml(text, { filePath: FILE, positions, annotations, parser, ...(members ? { members } : {}) });
    expectCompiles(out);
    return out;
  };

  describe('readErdLayoutDbml', () => {
    it('reads the decoded value from the AST, with \\\' and \\\\ decoded by the parser', () => {
      const text = "Project p {\n  erd_layout: '''\n    it\\'s \\\\ here 1 2\n    plain 3.5 -4\n  '''\n}\n";
      const reading = readErdLayoutDbml(text, parser)!;
      expect(reading.positions).toEqual({ "it's \\ here": { x: 1, y: 2 }, plain: { x: 3.5, y: -4 } });
      expect(reading.keyCount).toBe(1);
      expect(reading.valueLine).toBe(2);
      expect(reading.problemsAt).toEqual([]);
    });

    it('reads the notes, settled by the diagram\'s Note names', () => {
      const reading = readErdLayoutDbml(SALES, parser)!;
      expect(reading.positions).toEqual({ dim_customer: { x: 40, y: 60 }, fct_order: { x: 400, y: 200 } });
      expect(reading.stickies).toEqual([{ id: '3f2b', x: 720, y: 40, width: 220, height: 120 }]);
      const ambiguous = "Note \"q 1 2\" {\n  'n'\n}\n\nProject p {\n  erd_layout: '''\n    note/q 1 2 3 4\n  '''\n}\n";
      expect(readErdLayoutDbml(ambiguous, parser)!.stickies).toEqual([{ id: 'q 1 2', x: 3, y: 4 }]);
    });

    it('the first entry wins over a later one in another case, with a duplicate-key warning', () => {
      const text = "Project p {\n  erd_layout: '''\n    a 1 2\n  '''\n  ERD_LAYOUT: '''\n    a 9 9\n  '''\n}\n";
      const reading = readErdLayoutDbml(text, parser)!;
      expect(reading.positions).toEqual({ a: { x: 1, y: 2 } });
      expect(reading.keyCount).toBe(2);
      expect(reading.problemsAt).toEqual([
        { code: 'layoutDuplicateKey', line: 5, message: 'erd_layout appears 2 times; ERD Studio reads and rewrites only the first' },
      ]);
    });

    it('a value that is not a string is layoutBadValue, and nothing is read from it', () => {
      for (const value of ['42', 'true', '"quoted"', '#fff']) {
        const reading = readErdLayoutDbml(`Project p {\n  erd_schema_version: '7'\n  erd_layout: ${value}\n}\n`, parser)!;
        expect(reading.positions).toEqual({});
        expect(reading.problemsAt.map((p) => [p.code, p.line])).toEqual([['layoutBadValue', 3]]);
        expect(reading.problemsAt[0].message).toMatch(/other DBML tools reject the file; write positions as a '''…''' string/);
      }
    });

    it('bad lines and conflict markers carry their file lines', () => {
      const text = "Project p {\n  erd_layout: '''\n    a 1 2\n    oops\n<<<<<<< HEAD\n    b 1 1\n=======\n    b 2 2\n>>>>>>> theirs\n  '''\n}\n";
      const reading = readErdLayoutDbml(text, parser)!;
      expect(reading.conflictLine).toBe(5);
      expect(reading.positions).toEqual({ a: { x: 1, y: 2 }, b: { x: 1, y: 1 } });
      expect(reading.problemsAt.map((p) => [p.code, p.line])).toEqual([
        ['layoutBadLine', 4],
        ['layoutBadLine', 8],
        ['layoutMergeConflict', 5],
      ]);
      expect(reading.problemsAt[0].message).toBe('line 4 of erd_layout is not <name> <x> <y>; it is skipped and that table is placed automatically');
    });

    it('no entry, a diagram with no Project, and a syntax error', () => {
      expect(readErdLayoutDbml("Project p {\n  erd_schema_version: '7'\n}\n", parser)).toEqual({ positions: {}, stickies: [], problems: [], keyCount: 0, problemsAt: [] });
      expect(readErdLayoutDbml('', parser)!.keyCount).toBe(0);
      expect(readErdLayoutDbml('Project p {\n  erd_layout: \'\'\'\n', parser)).toBeNull();
    });
  });

  describe('erdLayoutEntrySpan', () => {
    it('is the first entry\'s whole lines, its last line break included', () => {
      const span = erdLayoutEntrySpan(SALES, parser)!;
      expect(SALES.slice(span.start, span.end)).toBe("  erd_layout: '''\n    dim_customer 40 60\n    fct_order 400 200\n    note/3f2b 720 40 220 120\n  '''\n");
    });

    it('counts a byte-order mark, so offsets are into the text given', () => {
      const span = erdLayoutEntrySpan(`﻿${SALES}`, parser)!;
      expect(`﻿${SALES}`.slice(span.start, span.end)).toMatch(/^ {2}erd_layout: '''[^]*'''\n$/);
    });

    it('is { 0, 0 } with no entry, and null on a syntax error', () => {
      expect(erdLayoutEntrySpan("Project p {\n  Note: 'x'\n}\n", parser)).toEqual({ start: 0, end: 0 });
      expect(erdLayoutEntrySpan('Project p {', parser)).toBeNull();
    });
  });

  describe('editDiagramLayoutDbml', () => {
    it('adds the key as the Project\'s last entry', () => {
      const text = "Project sales {\n  Note: 'Sales'\n  erd_schema_version: '7'\n}\n";
      const out = edit(text, { b: { x: 1, y: 2 }, a: { x: 3.456, y: 0 } }, []);
      expect(out).toBe("Project sales {\n  Note: 'Sales'\n  erd_schema_version: '7'\n  erd_layout: '''\n    a 3.46 0\n    b 1 2\n  '''\n}\n");
    });

    it('adds it on a one-line Project too', () => {
      const out = edit("Project p { erd_schema_version: '7' }\n", { a: { x: 1, y: 2 } }, []);
      expect(out).toBe("Project p { erd_schema_version: '7' \n  erd_layout: '''\n    a 1 2\n  '''\n}\n");
    });

    it('edits only the first entry; a later one is never touched', () => {
      const text = "Project p {\n  erd_layout: '''\n    a 1 2\n  '''\n  ERD_LAYOUT: '''\n    a 9 9\n  '''\n}\n";
      const out = edit(text, { a: { x: 5, y: 6 } }, []);
      expect(out).toBe("Project p {\n  erd_layout: '''\n    a 5 6\n  '''\n  ERD_LAYOUT: '''\n    a 9 9\n  '''\n}\n");
    });

    it('is byte-identical on a no-op, whatever the hand formatting', () => {
      const text = "Project p {\n    Note: 'x'\n\n\n    erd_layout: '''\n\n        b 1.0 2\n      a   3   4\n\n    '''   // positions\n}\n";
      expect(edit(text, { a: { x: 3, y: 4 }, b: { x: 1, y: 2 } }, [])).toBe(text);
      expect(edit(SALES, { fct_order: { x: 400, y: 200 }, dim_customer: { x: 40.001, y: 60 } })).toBe(SALES);
    });

    it('rewrites the whole value in canonical form, at the Project body\'s indent', () => {
      const text = "Project p {\n    Note: 'x'\n    erd_layout: '''\n  b 1 2\n      a 3 4\n    '''\n}\n";
      expect(edit(text, { a: { x: 3, y: 4 }, b: { x: 1, y: 7 } }, [])).toBe("Project p {\n    Note: 'x'\n    erd_layout: '''\n      a 3 4\n      b 1 7\n    '''\n}\n");
    });

    it('touches only the value span', () => {
      const out = edit(SALES, { dim_customer: { x: 41, y: 60 }, fct_order: { x: 400, y: 200 } });
      const start = SALES.indexOf("'''");
      const end = SALES.lastIndexOf("'''") + 3;
      expect(out.slice(0, start)).toBe(SALES.slice(0, start));
      expect(out.slice(out.length - (SALES.length - end))).toBe(SALES.slice(end));
      expect(out.slice(start, out.length - (SALES.length - end))).toBe("'''\n    dim_customer 41 60\n    fct_order 400 200\n    note/3f2b 720 40 220 120\n  '''");
    });

    it("escapes ' and \\ so the parser decodes the names back", () => {
      const out = edit(SALES, { "it's": { x: 1, y: 1 }, 'a\\b': { x: 2, y: 2 }, 'with space': { x: 3, y: 3 } }, []);
      expect(out).toContain("    a\\\\b 2 2\n    it\\'s 1 1\n    with space 3 3\n");
      expect(readErdLayoutDbml(out, parser)!.positions).toEqual({ "it's": { x: 1, y: 1 }, 'a\\b': { x: 2, y: 2 }, 'with space': { x: 3, y: 3 } });
    });

    it('cuts the key when nothing is left to place', () => {
      const out = edit(SALES, {}, []);
      expect(out).toBe(SALES.replace(/ {2}erd_layout: '''[^]*?'''\n/, ''));
      expect(out).not.toContain('erd_layout');
      // No entry and nothing to place: unchanged.
      expect(edit(out, {}, [])).toBe(out);
    });

    it('refuses while the current value holds a merge conflict', () => {
      const text = "Project p {\n  erd_layout: '''\n<<<<<<< HEAD\n    a 1 2\n=======\n    a 3 4\n>>>>>>> theirs\n  '''\n}\n";
      let err: unknown;
      try {
        editDiagramLayoutDbml(text, { filePath: FILE, positions: { a: { x: 5, y: 5 } }, annotations: [], parser });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DbmlEditRefused);
      expect((err as DbmlEditRefused).line).toBe(3);
      expect((err as Error).message).toBe(`${FILE} has a merge conflict in erd_layout (line 3). Only positions differ: keep either side, then try again. Positions are not saved until then.`);
    });

    it('a conflicted value the edit leaves alone is not refused: the text comes back unchanged', () => {
      const text = "Project p {\n  erd_layout: '''\n<<<<<<< HEAD\n    a 1 2\n=======\n    a 3 4\n>>>>>>> theirs\n  '''\n}\n";
      // The best-effort reading (first copy wins), as the canvas holds it: a drop in place.
      expect(editDiagramLayoutDbml(text, { filePath: FILE, positions: { a: { x: 1, y: 2 } }, annotations: [], parser })).toBe(text);
    });

    it('refuses a text that does not parse, and a second Project', () => {
      expect(() => editDiagramLayoutDbml('Project p {', { filePath: FILE, positions: {}, annotations: [], parser })).toThrow(DbmlEditRefused);
      expect(() => editDiagramLayoutDbml("Project a {\n  Note: 'x'\n}\nProject b {\n  Note: 'y'\n}\n", { filePath: FILE, positions: { a: { x: 1, y: 1 } }, annotations: [], parser }))
        .toThrow(/second Project \(line 4\)/);
    });

    it('appends a Project at the end when there is none (Project last)', () => {
      const text = "// header\n\nNote n {\n  'x'\n}\n\n\n";
      const out = edit(text, { a: { x: 1, y: 2 } }, [{ id: 'n', text: 'x', x: 9, y: 9 }]);
      expect(out).toBe("// header\n\nNote n {\n  'x'\n}\n\nProject sales {\n  erd_layout: '''\n    a 1 2\n    note/n 9 9\n  '''\n}\n");
      expect(edit('', { a: { x: 1, y: 2 } }, [])).toBe("Project sales {\n  erd_layout: '''\n    a 1 2\n  '''\n}\n");
      const quoted = editDiagramLayoutDbml('', { filePath: 'gold/diagrams/customer-360.dbml', positions: { a: { x: 1, y: 2 } }, annotations: [], parser });
      expect(quoted.startsWith('Project "customer-360" {\n')).toBe(true);
      expectCompiles(quoted);
    });

    it('keeps CRLF line endings, inside the value too', () => {
      const crlf = SALES.replace(/\n/g, '\r\n');
      const out = edit(crlf, { dim_customer: { x: 1, y: 1 }, fct_order: { x: 2, y: 2 } });
      expect(out.replace(/\r\n/g, '')).not.toContain('\n');
      expect(out).toContain("  erd_layout: '''\r\n    dim_customer 1 1\r\n    fct_order 2 2\r\n    note/3f2b 720 40 220 120\r\n  '''\r\n}\r\n");
      const added = edit("Project p {\r\n  Note: 'x'\r\n}\r\n", { a: { x: 1, y: 1 } }, []);
      expect(added).toBe("Project p {\r\n  Note: 'x'\r\n  erd_layout: '''\r\n    a 1 1\r\n  '''\r\n}\r\n");
    });

    it('keeps a byte-order mark', () => {
      const out = edit(`﻿${SALES}`, { dim_customer: { x: 1, y: 1 } });
      expect(out.charCodeAt(0)).toBe(0xfeff);
      expect(out.slice(1)).toBe(edit(SALES, { dim_customer: { x: 1, y: 1 } }));
      expect(edit(`﻿${SALES}`, { dim_customer: { x: 40, y: 60 }, fct_order: { x: 400, y: 200 } })).toBe(`﻿${SALES}`);
    });

    it("drops a note line with no Note block, and spells a member's line as the member", () => {
      const text = "Project p {\n  erd_layout: '''\n    Dim_Customer 1 2\n    dim_customer 3 4\n    note/gone 1 1\n    stray 7 7\n  '''\n}\n";
      const out = edit(text, { Dim_Customer: { x: 1, y: 2 }, dim_customer: { x: 30, y: 40 }, stray: { x: 7, y: 7 } }, [], ['dim_customer']);
      expect(out).toBe("Project p {\n  erd_layout: '''\n    dim_customer 30 40\n    stray 7 7\n  '''\n}\n");
    });

    it("spells lines by the diagram's own members when none are given", () => {
      const unlinked = "Project p {\n  erd_unlinked_tables: 'dim_customer'\n  erd_layout: '''\n    Dim_Customer 1 2\n    dim_customer 3 4\n    stray 7 7\n  '''\n}\n";
      const out = edit(unlinked, { Dim_Customer: { x: 1, y: 2 }, dim_customer: { x: 30, y: 40 }, stray: { x: 7, y: 7 } }, []);
      expect(out).toBe("Project p {\n  erd_unlinked_tables: 'dim_customer'\n  erd_layout: '''\n    dim_customer 30 40\n    stray 7 7\n  '''\n}\n");
      // A use line's stem is a member too (syntax only: the imported file is not there to bind).
      const used = "use { table Dim_Customer } from '../tables/gold/Dim_Customer.dbml'\n\nProject p {\n  erd_layout: '''\n    Dim_Customer 1 2\n    dim_customer 3 4\n  '''\n}\n";
      const back = editDiagramLayoutDbml(used, { filePath: FILE, positions: { dim_customer: { x: 3, y: 4 }, Dim_Customer: { x: 10, y: 20 } }, annotations: [], parser });
      expect(back).toBe("use { table Dim_Customer } from '../tables/gold/Dim_Customer.dbml'\n\nProject p {\n  erd_layout: '''\n    Dim_Customer 10 20\n  '''\n}\n");
      // A layout whose only line for a member is a case variant is re-keyed to the member.
      expect(edit(unlinked, { Dim_Customer: { x: 5, y: 5 } }, [])).toBe("Project p {\n  erd_unlinked_tables: 'dim_customer'\n  erd_layout: '''\n    dim_customer 5 5\n  '''\n}\n");
    });

    it('replaces a value written as a block with key: string', () => {
      const text = "Project p {\n  ERD_Layout {\n    'a 1 2'\n  }\n}\n";
      expect(edit(text, { a: { x: 1, y: 2 } }, [])).toBe("Project p {\n  ERD_Layout: '''\n    a 1 2\n  '''\n}\n");
      expect(edit("Project p {\n  erd_layout: 42\n}\n", { a: { x: 1, y: 2 } }, [])).toBe("Project p {\n  erd_layout: '''\n    a 1 2\n  '''\n}\n");
    });

    it('empties, never cuts, the first of a repeated key, so the next one is never read in its place', () => {
      const text = "Project p {\n  erd_layout: '''\n    a 1 2\n  '''\n  ERD_LAYOUT: '''\n    old 5 5\n  '''\n}\n";
      const out = edit(text, {}, []);
      expect(out).toBe("Project p {\n  erd_layout: ''\n  ERD_LAYOUT: '''\n    old 5 5\n  '''\n}\n");
      expect(readErdLayoutDbml(out, parser)!.positions).toEqual({});
      expect(edit(out, {}, [])).toBe(out);
      expect(edit(out, { a: { x: 1, y: 2 } }, [])).toBe(text);
    });

    it('the result is never formatted', () => {
      const text = "Project   p{\n\terd_schema_version :'7'\n}\n\n\n\nNote n{'x'}\n";
      const out = edit(text, { a: { x: 1, y: 1 } }, []);
      expect(out).toBe("Project   p{\n\terd_schema_version :'7'\n\terd_layout: '''\n\t  a 1 1\n\t'''\n}\n\n\n\nNote n{'x'}\n");
    });

    it('a 1,100-line value round trips quickly', () => {
      const positions: Record<string, NodePosition> = {};
      for (let i = 0; i < 1000; i++) positions[`table_${i}`] = { x: (i % 40) * 320.5, y: Math.floor(i / 40) * 240.25 };
      const annotations: Annotation[] = [];
      for (let i = 0; i < 100; i++) annotations.push({ id: `sticky_${i}`, text: '', x: i * 10, y: -i, width: 200, height: 100 });
      const text = "Project big {\n  erd_schema_version: '7'\n}\n";
      // Warm up the parser, then time one write and one read.
      editDiagramLayoutDbml(text, { filePath: FILE, positions: { a: { x: 1, y: 1 } }, annotations: [], parser });
      const started = performance.now();
      const out = editDiagramLayoutDbml(text, { filePath: FILE, positions, annotations, parser });
      const reading = readErdLayoutDbml(out, parser)!;
      const again = editDiagramLayoutDbml(out, { filePath: FILE, positions, annotations, parser });
      const elapsed = performance.now() - started;
      expect(Object.keys(reading.positions)).toHaveLength(1000);
      expect(reading.stickies).toHaveLength(100);
      expect(again).toBe(out);
      // 50 ms, with the repo's margin for a busy machine (3×) or a loaded CI runner (8×).
      const MARGIN = process.env.CI ? 8 : 3;
      expect(elapsed).toBeLessThan(50 * MARGIN);
    });
  });
});

describe('the parse the edit and the reader share', () => {
  it('reads the literal of a layout the edit wrote identically in every parser', () => {
    const out = editDiagramLayoutDbml(SALES, { filePath: FILE, positions: { "o'brien \\ co": { x: 1, y: 2 } }, annotations: notes });
    const readings = STORAGE_PARSERS.map(([, parser]) => readErdLayoutDbml(out, parser));
    for (const reading of readings) expect(reading).toEqual(readings[0]);
    expect(parseSyntax(out).errors).toEqual([]);
  });
});
