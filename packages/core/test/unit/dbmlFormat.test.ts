/**
 * The DBML formatter (`formatDbml`): ERD Studio's one canonical layout,
 * whitespace only.
 *
 * - Goldens: `../dbmlFormat/golden/<case>.dbml` formats to
 *   `<case>.formatted.dbml` (regenerate with UPDATE_GOLDEN=1, only for an
 *   intended layout change).
 * - The rules, one by one, on small inline texts.
 * - Properties, over every `.dbml` under `test/fixtures` and
 *   `packages/core/test` (the synthetic projects in `../dbmlFormat/synthetic`
 *   included): the token sequence is unchanged, formatting is idempotent,
 *   each file gives the same diagnostics as a multi-file project in 9.1.1,
 *   10.3.1 and 11.0.0, and its interpreted database (positions aside) is
 *   deep-equal before and after.
 * - Time: linear, and a 500-table diagram well under 100 ms.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { formatDbml, type DbmlFormatResult } from '../../src/dbml/index';
import { MAX_WIDTH } from '../../src/dbml/format';
import type { DbmlParserModule } from '../../src/dbml/parserModule';
import { PARSER_PINNED, PARSER_V10, PARSER_V9, STORAGE_PARSERS } from '../dbmlParsers';

const UPDATE = process.env.UPDATE_GOLDEN === '1';
const GOLDEN = path.resolve(__dirname, '../dbmlFormat/golden');
const REPO = path.resolve(__dirname, '../../../..');

function format(text: string): string {
  const result = formatDbml(text);
  expect(result.skipped, result.detail ?? JSON.stringify(result.errors)).toBeUndefined();
  return result.text;
}

/** The token and comment sequence (kind and exact text) under the pinned parser, whitespace left out. */
function tokenSequence(text: string, parser: DbmlParserModule = PARSER_PINNED): string[] {
  const body = text.replace(/^﻿/, '');
  const layout = new parser.MemoryProjectLayout();
  const file = parser.Filepath.from('/erd-studio/file.dbml');
  layout.setSource(file, body);
  const out: string[] = [];
  for (const token of new parser.Compiler(layout).parse.tokens(file)) {
    for (const t of [...token.leadingTrivia, token, ...token.trailingTrivia]) {
      if (!['<space>', '<tab>', '<newline>', '<eof>'].includes(t.kind)) out.push(`${t.kind} ${body.slice(t.start, t.end)}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Goldens

const GOLDEN_CASES = fs.readdirSync(GOLDEN).filter((f) => f.endsWith('.dbml') && !f.endsWith('.formatted.dbml')).sort();

describe('goldens', () => {
  it('holds the cases the layout was specified with', () => {
    expect(GOLDEN_CASES).toEqual([
      'diagram-layout.dbml',
      'diagram.dbml',
      'enum-group.dbml',
      'refs.dbml',
      'relationships.dbml',
      'table-comments.dbml',
      'table-erd-studio.dbml',
      'table-groups.dbml',
      'table-indexes.dbml',
      'table-long.dbml',
      'table-quoted.dbml',
      'table-triple-note.dbml',
    ]);
  });

  it.each(GOLDEN_CASES)('%s', (name) => {
    const input = fs.readFileSync(path.join(GOLDEN, name), 'utf8');
    const expectedPath = path.join(GOLDEN, name.replace(/\.dbml$/, '.formatted.dbml'));
    const output = format(input);
    if (UPDATE) fs.writeFileSync(expectedPath, output);
    expect(output).toBe(fs.readFileSync(expectedPath, 'utf8'));
    // The golden output is already canonical.
    const again = formatDbml(output);
    expect(again).toEqual({ text: output, changed: false });
  });

  it('formats the same with every parser it is given (the tree has one shape in 9.1.1, 10.3.1 and 11.0.0)', () => {
    for (const name of GOLDEN_CASES) {
      const input = fs.readFileSync(path.join(GOLDEN, name), 'utf8');
      const pinned = formatDbml(input).text;
      for (const parser of [PARSER_V9, PARSER_V10]) {
        const other = formatDbml(input, { parser });
        // 9.1.1 has no `?` relation marks: it refuses those files, unchanged.
        if (other.skipped) expect(other).toMatchObject({ skipped: 'parse-errors', text: input });
        else expect({ name, text: other.text }).toEqual({ name, text: pinned });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The rules

describe('F0 whitespace only, and refusals', () => {
  it('returns a file with a syntax error unchanged, with the errors', () => {
    const input = 'Table t {\n    a int [pk\n}\n';
    const result = formatDbml(input);
    expect(result.text).toBe(input);
    expect(result.changed).toBe(false);
    expect(result.skipped).toBe('parse-errors');
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(result.errors![0].code).toBeGreaterThanOrEqual(1000);
    expect(result.errors![0].code).toBeLessThan(2000);
    expect(result.errors![0].line).toBeGreaterThan(0);
  });

  it('formats a file that only fails to bind (a relationships file whose use targets are elsewhere)', () => {
    const result = formatDbml("use {table a} from './a.dbml'\nRef:a.x>?b.y\n");
    expect(result).toEqual({ text: "use { table a } from './a.dbml'\nRef: a.x >? b.y\n", changed: true });
  });

  it('returns the input unchanged when the formatted text does not re-lex to the same tokens', () => {
    // A parser whose second read (the self-check) sees something else.
    let reads = 0;
    class Tampering extends (PARSER_PINNED.MemoryProjectLayout as new () => { setSource(f: unknown, t: string): void }) {
      setSource(file: unknown, text: string): void {
        reads++;
        super.setSource(file, reads === 2 ? text.replace('int', 'bigint') : text);
      }
    }
    const input = 'Table t {\n      a    int\n}\n';
    const result = formatDbml(input, { parser: { ...PARSER_PINNED, MemoryProjectLayout: Tampering } });
    expect(result.text).toBe(input);
    expect(result.changed).toBe(false);
    expect(result.skipped).toBe('self-check');
    expect(result.detail).toMatch(/token/);
  });

  it('is a no-op on canonical text: the same string, changed false', () => {
    const input = "Table t {\n  a int [pk]\n}\n";
    const result = formatDbml(input);
    expect(result).toEqual({ text: input, changed: false });
  });

  it('keeps a byte-order mark', () => {
    expect(formatDbml('﻿Table t {\n    a int\n}').text).toBe('﻿Table t {\n  a int\n}\n');
  });

  it('leaves an empty file empty and empties a whitespace-only one', () => {
    expect(formatDbml('')).toEqual({ text: '', changed: false });
    expect(formatDbml('\n\n   \n')).toEqual({ text: '', changed: true });
  });

  it('never touches the inside of a token: strings, backtick expressions, quoted names, block comments', () => {
    const input = [
      "Table \"odd  name\" {",
      "     \"col   with  spaces\"   \"DECIMAL( 18 , 2 )\"   [default:   `now(  )`, note:   'two  spaces  kept']",
      "     /*   block   */   b int",
      '}',
      '',
    ].join('\n');
    const output = format(input);
    expect(output).toBe(
      [
        'Table "odd  name" {',
        "  \"col   with  spaces\" \"DECIMAL( 18 , 2 )\" [default: `now(  )`, note: 'two  spaces  kept']",
        '  /*   block   */ b int',
        '}',
        '',
      ].join('\n'),
    );
    expect(tokenSequence(output)).toEqual(tokenSequence(input));
  });

  it('keeps a triple-quoted string byte for byte, inner indentation and all', () => {
    const input = fs.readFileSync(path.join(GOLDEN, 'table-triple-note.dbml'), 'utf8');
    const output = format(input);
    const strings = (text: string) => text.match(/'''[\s\S]*?'''/g);
    expect(strings(output)).toEqual(strings(input));
    expect(strings(input)).toHaveLength(2);
  });

  it('never converts between quote styles', () => {
    const input = "Table t {\n  a int [note: \"double\", default: 'single']\n  Note: '''triple'''\n}\n";
    expect(format(input)).toBe(input);
  });
});

describe('F1 indentation, line endings, blank lines', () => {
  it('indents two spaces per depth, strips trailing whitespace, drops leading and doubled blank lines, ends with one newline', () => {
    const input = '\n\n\nTable t {   \n\n\n\t\ta int   \n\n\n\n        b int\n\n\n}   \n\n\n';
    expect(format(input)).toBe('Table t {\n  a int\n\n  b int\n}\n');
  });

  it('keeps a single blank line between top-level elements and adds none', () => {
    const input = 'Table a {\n  x int\n}\n\n\n\nTable b {\n  y int\n}\nTable c {\n  z int\n}\n';
    expect(format(input)).toBe('Table a {\n  x int\n}\n\nTable b {\n  y int\n}\nTable c {\n  z int\n}\n');
  });

  it('removes a blank line after an opening brace, also after the trailing comment on its line', () => {
    expect(format('Table t { // c\n\n  a int\n}\n')).toBe('Table t { // c\n  a int\n}\n');
  });

  it('writes CRLF for a CRLF file, the whole golden way', () => {
    const lf = fs.readFileSync(path.join(GOLDEN, 'table-comments.dbml'), 'utf8');
    const expected = fs.readFileSync(path.join(GOLDEN, 'table-comments.formatted.dbml'), 'utf8');
    const result = formatDbml(lf.replace(/\n/g, '\r\n'));
    expect(result.text).toBe(expected.replace(/\n/g, '\r\n'));
    expect(formatDbml(result.text)).toEqual({ text: result.text, changed: false });
  });

  it('uses the dominant line ending of a mixed file', () => {
    expect(format('Table t {\r\n  a int\r\n  b int\n}\r\n')).toBe('Table t {\r\n  a int\r\n  b int\r\n}\r\n');
    expect(format('Table t {\n  a int\n  b int\r\n}\n')).toBe('Table t {\n  a int\n  b int\n}\n');
  });
});

describe('F2 comments', () => {
  it('indents an own-line comment like the next line, and like the body before a closing brace', () => {
    const input = 'Table t {\n// first\n      a int\n            // last\n}\n    // after\n';
    expect(format(input)).toBe('Table t {\n  // first\n  a int\n  // last\n}\n// after\n');
  });

  it('drops the whitespace at the end of a // comment, which is the line\'s', () => {
    expect(format('// header   \t\nTable t {\n  a int // why  \n}\n')).toBe('// header\nTable t {\n  a int // why\n}\n');
  });

  it('keeps a trailing comment trailing, one space after the code', () => {
    expect(format('Table t {\n  a int//x\n  b int     /* y */\n}\n')).toBe('Table t {\n  a int //x\n  b int /* y */\n}\n');
  });

  it('keeps an own-line /* */ comment inside a settings list on its own line, with no space inside a bracket', () => {
    const cases: Array<[string, string]> = [
      // Between two settings of a column list that would fit on one line.
      ['Table a {\n  id int [\n    pk,\n    /* why unique */\n    unique\n  ]\n}\n', 'Table a {\n  id int [\n    pk,\n    /* why unique */\n    unique\n  ]\n}\n'],
      // Before the only setting of a Table header.
      ['Table a [\n  /* colour */\n  headercolor: #fff\n] {\n  id int\n}\n', 'Table a [\n  /* colour */\n  headercolor: #fff\n] {\n  id int\n}\n'],
      // After the last setting, before `]`.
      ['Table a {\n  id int [\n    pk\n    /* end */\n  ]\n}\n', 'Table a {\n  id int [\n    pk\n    /* end */\n  ]\n}\n'],
      // A trailing comment that ended the line before `]`.
      ['Table a {\n  id int [pk /* end */\n  ]\n}\n', 'Table a {\n  id int [\n    pk /* end */\n  ]\n}\n'],
    ];
    for (const [input, expected] of cases) {
      const out = format(input);
      expect(out).toBe(expected);
      expect(out).not.toMatch(/\[ |\S \]/);
      expect(format(out)).toBe(out);
      for (const parser of [PARSER_V9, PARSER_V10]) {
        const other = formatDbml(input, { parser });
        expect(other.skipped).toBeUndefined();
        expect(other.text).toBe(expected);
      }
    }
  });
});

describe('F3 column alignment', () => {
  it('aligns names, then the types of columns with settings, within a group', () => {
    const input = 'Table t {\n  id int [pk]\n  customer_name varchar\n  amount decimal(10,2) [note: \'x\']\n}\n';
    expect(format(input)).toBe(
      "Table t {\n  id            int            [pk]\n  customer_name varchar\n  amount        decimal(10, 2) [note: 'x']\n}\n",
    );
  });

  it('starts a new group after a blank line, an own-line comment or a line that is not a column', () => {
    const input = [
      'Table t {',
      '  a int [pk]',
      '  bbbb int [pk]',
      '',
      '  cc int [pk]',
      '  // comment',
      '  dddddd int [pk]',
      '  Note: \'n\'',
      '  e int',
      '}',
      '',
    ].join('\n');
    expect(format(input)).toBe(
      ['Table t {', '  a    int [pk]', '  bbbb int [pk]', '', '  cc int [pk]', '  // comment', '  dddddd int [pk]', "  Note: 'n'", '  e int', '}', ''].join('\n'),
    );
  });

  it('keeps a trailing comment inside the group', () => {
    expect(format('Table t {\n  a int [pk] // k\n  bbb int [pk]\n}\n')).toBe('Table t {\n  a   int [pk] // k\n  bbb int [pk]\n}\n');
  });

  it('caps the name width at 32 code points and the type width at 24', () => {
    const n32 = 'n'.repeat(32);
    const n33 = 'm'.repeat(33);
    const t24 = `"${'T'.repeat(22)}"`;
    const t25 = `"${'U'.repeat(23)}"`;
    const input = `Table t {\n  a int [pk]\n  ${n32} int [pk]\n  ${n33} int [pk]\n  b ${t24} [pk]\n  c ${t25} [pk]\n}\n`;
    const pad = (s: string, w: number) => s + ' '.repeat(w - s.length);
    expect(format(input)).toBe(
      [
        'Table t {',
        `  ${pad('a', 32)} ${pad('int', 24)} [pk]`,
        `  ${n32} ${pad('int', 24)} [pk]`,
        `  ${n33} ${pad('int', 24)} [pk]`,
        `  ${pad('b', 32)} ${t24} [pk]`,
        `  ${pad('c', 32)} ${t25} [pk]`,
        '}',
        '',
      ].join('\n'),
    );
  });

  it('measures widths in code points', () => {
    // "𝒳" is one code point and two UTF-16 units.
    expect(format('Table t {\n  "𝒳𝒳" int [pk]\n  abcd int [pk]\n}\n')).toBe('Table t {\n  "𝒳𝒳" int [pk]\n  abcd int [pk]\n}\n');
  });

  it("normalises only a type's spacing", () => {
    expect(format('Table t {\n  a decimal (10 ,2)\n  b varchar( 255 )\n  c int[]\n  d s.e\n}\n')).toBe(
      'Table t {\n  a decimal(10, 2)\n  b varchar(255)\n  c int[]\n  d s.e\n}\n',
    );
  });

  it('aligns TablePartial columns too', () => {
    expect(format('TablePartial audit {\n  created_at timestamp [not null]\n  by varchar [note: \'who\']\n}\n')).toBe(
      "TablePartial audit {\n  created_at timestamp [not null]\n  by         varchar   [note: 'who']\n}\n",
    );
  });
});

describe('F4 settings lists', () => {
  it('spaces a list as [a, b: c]', () => {
    expect(format("Table t {\n  a int [ pk ,not   null,note : 'x' ]\n}\n")).toBe("Table t {\n  a int [pk, not null, note: 'x']\n}\n");
  });

  it('keeps a column line of exactly 100 code points on one line and breaks one of 101', () => {
    const line = (noteLength: number) => `  a int [note: '${'x'.repeat(noteLength)}']`;
    const fits = MAX_WIDTH - line(0).length;
    expect(format(`Table t {\n${line(fits)}\n}\n`)).toBe(`Table t {\n${line(fits)}\n}\n`);
    expect(format(`Table t {\n${line(fits + 1)}\n}\n`)).toBe(`Table t {\n  a int [\n    note: '${'x'.repeat(fits + 1)}'\n  ]\n}\n`);
  });

  it('joins a short multi-line column list onto its line', () => {
    expect(format('Table t {\n  a int [\n    pk,\n    unique\n  ]\n}\n')).toBe('Table t {\n  a int [pk, unique]\n}\n');
  });

  it('breaks an index line the same way', () => {
    const long = 'n'.repeat(90);
    expect(format(`Table t {\n  a int\n  indexes {\n    a [name: '${long}']\n  }\n}\n`)).toBe(`Table t {\n  a int\n  indexes {\n    a [\n      name: '${long}'\n    ]\n  }\n}\n`);
  });

  it("keeps a Ref's, an Enum value's and a Note's list on one line, however long, unless it was already broken", () => {
    const long = `Ref: ${'a'.repeat(40)}.x >? ${'b'.repeat(40)}.y [delete: cascade, update: no action]\n`;
    expect(format(long)).toBe(long);
    expect(format('Ref: a.x > b.y [delete: cascade,\nupdate: restrict]\n')).toBe('Ref: a.x > b.y [\n  delete: cascade,\n  update: restrict\n]\n');
  });

  it('breaks a list holding a // comment, keeping each comment where it was', () => {
    expect(format('Table t {\n  a int [pk, // why\n  note: \'n\']\n}\n')).toBe("Table t {\n  a int [\n    pk, // why\n    note: 'n'\n  ]\n}\n");
  });
});

describe('F5 Table headers', () => {
  it('keeps one setting inline and breaks two or more', () => {
    expect(format("Table t [schema:'gold'] {\n  a int\n}\n")).toBe("Table t [schema: 'gold'] {\n  a int\n}\n");
    expect(format("Table t [schema: 'gold', role: 'fact'] {\n  a int\n}\n")).toBe("Table t [\n  schema: 'gold',\n  role: 'fact'\n] {\n  a int\n}\n");
  });

  it('breaks a single setting that does not fit', () => {
    const grain = 'g'.repeat(90);
    expect(format(`Table t [grain: '${grain}'] {\n  a int\n}\n`)).toBe(`Table t [\n  grain: '${grain}'\n] {\n  a int\n}\n`);
  });

  it('spaces the header parts', () => {
    expect(format('Table   gold.t   as   T   {\n  a int\n}\n')).toBe('Table gold.t as T {\n  a int\n}\n');
  });
});

describe('F6 other elements', () => {
  it('spaces a Ref around its operator and after its colon', () => {
    expect(format('Ref   r  :a.b>c.d\nRef:a.(x,y)<>e.(u,v)\nRef{\na.b-c.d\n}\n')).toBe('Ref r: a.b > c.d\nRef: a.(x, y) <> e.(u, v)\nRef {\n  a.b - c.d\n}\n');
  });

  it('spaces Project fields and keeps them one per line', () => {
    expect(format("Project p {\n      database_type :'x'\nNote:   'y'\n}\n")).toBe("Project p {\n  database_type: 'x'\n  Note: 'y'\n}\n");
  });
});

describe('F7 use lines', () => {
  it('aligns from across a run of one-line selective imports; a wildcard, a blank line or anything else ends the run', () => {
    const input = [
      "use {table a} from './a.dbml'",
      "reuse { table bbb }   from './b.dbml'",
      "use * from './_relationships.dbml'",
      "use { table cc } from './c.dbml'",
      '',
      "use { table dddddd } from './d.dbml'",
      "use { table e } from './e.dbml' // trailing",
      "use { table ffff } from './f.dbml'",
      '',
    ].join('\n');
    expect(format(input)).toBe(
      [
        "use { table a }     from './a.dbml'",
        "reuse { table bbb } from './b.dbml'",
        "use * from './_relationships.dbml'",
        "use { table cc } from './c.dbml'",
        '',
        "use { table dddddd } from './d.dbml'",
        "use { table e }      from './e.dbml' // trailing",
        "use { table ffff }   from './f.dbml'",
        '',
      ].join('\n'),
    );
  });
  it('a use line past USE_CAP gets one space and does not re-pad the rest of the run', () => {
    const long = 'a_very_long_table_name_that_is_over_the_cap_x';
    const input = [
      "use { table a } from './a.dbml'",
      `use { table ${long} } from './l.dbml'`,
      "use { table bbbb } from './b.dbml'",
      '',
    ].join('\n');
    expect(format(input)).toBe(
      [
        "use { table a }    from './a.dbml'",
        `use { table ${long} } from './l.dbml'`,
        "use { table bbbb } from './b.dbml'",
        '',
      ].join('\n'),
    );
  });
});

describe('F8 constructs it does not know', () => {
  it('only re-indents them', () => {
    const input = 'Table t {\n  a int\n  checks {\n          `a   >   0`   [name:  \'positive\']\n  }\n}\n';
    const result = formatDbml(input);
    if (result.skipped) return; // a construct this parser does not read at all is left alone
    expect(tokenSequence(result.text)).toEqual(tokenSequence(input));
    expect(result.text).toContain("    `a   >   0`");
  });
});

// ---------------------------------------------------------------------------
// Properties over every .dbml in the repository's fixtures

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.dbml')) out.push(p);
  }
}

/** Every repository .dbml, grouped as projects: by the `.erd-studio` folder it is in, else by its own folder. */
function repositoryProjects(): Array<{ name: string; files: Record<string, string> }> {
  const files: string[] = [];
  walk(path.join(REPO, 'test/fixtures'), files);
  walk(path.join(REPO, 'packages/core/test'), files);
  const groups = new Map<string, Record<string, string>>();
  for (const file of files.sort()) {
    const at = file.lastIndexOf(`${path.sep}.erd-studio${path.sep}`);
    const root = at >= 0 ? file.slice(0, at + '/.erd-studio/'.length) : path.dirname(file) + path.sep;
    const group = groups.get(root) ?? {};
    group[path.relative(root, file).split(path.sep).join('/')] = fs.readFileSync(file, 'utf8');
    groups.set(root, group);
  }
  return [...groups].map(([root, group]) => ({ name: path.relative(REPO, root), files: group }));
}

/** The interpreted database without positions, which a whitespace change moves. */
function withoutPositions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPositions);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) if (key !== 'token' && key !== 'filepath') out[key] = withoutPositions(v);
    return out;
  }
  return value;
}

/** For each file of a project compiled together: its diagnostics (code and message, no position) and its database. */
function compileProject(parser: DbmlParserModule, files: Record<string, string>): Record<string, { diagnostics: string[]; db: unknown }> {
  const layout = new parser.MemoryProjectLayout();
  for (const [p, text] of Object.entries(files)) layout.setSource(parser.Filepath.from(`/erd-studio/${p}`), text.replace(/^﻿/, ''));
  const compiler = new parser.Compiler(layout);
  const out: Record<string, { diagnostics: string[]; db: unknown }> = {};
  for (const p of Object.keys(files)) {
    const file = parser.Filepath.from(`/erd-studio/${p}`);
    const diagnostics = ((compiler.parse.errors(file) ?? []) as Array<{ code: number; diagnostic: string }>).map((e) => `${e.code} ${e.diagnostic}`).sort();
    out[p] = { diagnostics, db: diagnostics.length === 0 ? withoutPositions(compiler.parse.rawDb(file)) : undefined };
  }
  return out;
}

describe('properties over every repository .dbml', () => {
  const projects = repositoryProjects();
  const results = new Map<string, DbmlFormatResult>();
  const formatted = (project: { name: string; files: Record<string, string> }): Record<string, string> =>
    Object.fromEntries(
      Object.entries(project.files).map(([p, text]) => {
        const key = `${project.name}/${p}`;
        if (!results.has(key)) results.set(key, formatDbml(text));
        return [p, results.get(key)!.text];
      }),
    );

  it('finds the fixtures, the synthetic projects among them', () => {
    const count = projects.reduce((n, p) => n + Object.keys(p.files).length, 0);
    expect(count).toBeGreaterThan(120);
    expect(projects.map((p) => p.name)).toEqual(expect.arrayContaining([
      path.join('packages/core/test/dbmlFormat/synthetic/e2c/.erd-studio'),
      path.join('packages/core/test/dbmlFormat/synthetic/p100/.erd-studio'),
    ]));
  });

  describe.each(projects.map((p) => [p.name, p] as const))('%s', (_name, project) => {
    it('keeps every token and comment, is idempotent, and only skips files with syntax errors', () => {
      const after = formatted(project);
      for (const [p, text] of Object.entries(project.files)) {
        const result = results.get(`${project.name}/${p}`)!;
        expect({ p, skipped: result.skipped }).toEqual({ p, skipped: result.skipped === 'parse-errors' ? 'parse-errors' : undefined });
        expect({ p, tokens: tokenSequence(after[p]) }).toEqual({ p, tokens: tokenSequence(text) });
        expect({ p, again: formatDbml(after[p]).text }).toEqual({ p, again: after[p] });
      }
    });

    it.each(STORAGE_PARSERS)('reads the same in %s: diagnostics and database', (_label, parser) => {
      const before = compileProject(parser, project.files);
      const after = compileProject(parser, formatted(project));
      for (const p of Object.keys(project.files)) expect({ p, ...after[p] }).toEqual({ p, ...before[p] });
    });
  });
});

// ---------------------------------------------------------------------------
// Time

describe('time', () => {
  function diagram(tables: number): string {
    let text = "Project big {\n  Note: 'Big'\n  erd_schema_version: '7'\n}\n\n";
    for (let i = 0; i < tables; i++) text += `use { table table_${i}_${'x'.repeat(i % 17)} } from '../tables/gold/table_${i}_${'x'.repeat(i % 17)}.dbml'\n`;
    return text + "use * from '../tables/gold/_relationships.dbml'\n";
  }

  function wideTable(columns: number): string {
    let text = "Table wide [schema: 'gold', role: 'fact'] {\n";
    for (let i = 0; i < columns; i++) text += `  column_${i} ${i % 3 ? 'INT' : '"DECIMAL(18,2)"'} [note: 'Column ${i}${i % 7 ? '' : ' with a description long enough to wrap the line'}', additive_type: 'additive']\n`;
    return `${text}  Note: 'Wide'\n}\n`;
  }

  function median(text: string): number {
    for (let i = 0; i < 3; i++) formatDbml(text);
    const runs: number[] = [];
    for (let i = 0; i < 9; i++) {
      const start = performance.now();
      formatDbml(text);
      runs.push(performance.now() - start);
    }
    return runs.sort((a, b) => a - b)[4];
  }

  it('formats a 500-table diagram and a 200-column table quickly, and linearly', () => {
    const d500 = median(diagram(500));
    const d1000 = median(diagram(1000));
    const wide = median(wideTable(200));
    // Measured about 10 ms and 8 ms on a laptop; the bounds leave room for a slow CI machine.
    expect(d500).toBeLessThan(100);
    expect(wide).toBeLessThan(100);
    expect(d1000 / d500).toBeLessThan(3.5);
  });
});
