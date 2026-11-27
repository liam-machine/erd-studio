/**
 * Sample rows (D37) and privacy: a cell of a `records` block may hold real
 * data, so no message core builds may carry one. A sentinel value is put in
 * every shape a script is likely to get wrong (§3.7 of the sample-rows
 * plan) and must be absent from everything that leaves a reader, a writer,
 * the multi-file compile, the formatter or the loader, in 9.1.1, 10.3.1 and
 * 11.0.0:
 *
 * - a dotted bare word (`zqSENTX7.y`, `s.zqSENTX7.z`), which the parser reads
 *   as an enum reference and quotes ([4000]);
 * - quoting mistakes (`'zq''SENTX7'`, `'zq'SENTX7'`, a bare word with a
 *   space, an unclosed `'''`);
 * - row errors (a short row, a duplicate primary key, a value under a
 *   foreign key);
 * - a value in the header (`(id, "zqSENTX7")`);
 * - placement (a top-level `Records` block, two blocks).
 *
 * A stubbed parser diagnostic outside every block that quotes the first
 * segment of a dotted value exercises the value backstop on its own.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import * as DbmlParse from '@dbml/parse';

import { parseTableDbml } from '../../src/dbml/readTable';
import { editTableDbml } from '../../src/dbml/writeTable';
import { compileDbmlProject } from '../../src/dbml/compileProject';
import { formatDbml } from '../../src/dbml/format';
import { dbmlMessageSanitiser, parserStoppedMessage } from '../../src/dbml/diagnosticText';
import { dbmlStorageReader, parserStoppedMessage as exportedParserStoppedMessage } from '../../src/dbml/index';
import { compileOne } from '../../src/dbml/parser';
import { DbmlEditRefused } from '../../src/dbml/errors';
import { loadDisplaySubjectArea } from '../../src/loadDisplayDomain';
import type { DbmlParserModule } from '../../src/dbml/parserModule';
import type { SemanticTable } from '../../src/types/semantic';
import { STORAGE_PARSERS } from '../dbmlParsers';

/** The sentinel; its tail is what a split value (`'zq''SENTX7'`) would leak. */
const SENTINEL = 'zqSENTX7';
const LEAK = /SENTX7/;

const head = (name: string): string => `Table gold.${name} {\n  id int [pk]\n  name varchar\n  owner_id int\n`;
const block = (name: string, rows: string, list = '(id, name)'): string => `${head(name)}\n  records ${list} {\n${rows}  }\n}\n`;

/** Each shape, as table `name`'s file. */
const SHAPES: Record<string, (name: string) => string> = {
  'a dotted bare word': (n) => block(n, `    1, ${SENTINEL}.y\n`),
  'a three-part dotted bare word': (n) => block(n, `    1, s.${SENTINEL}.z\n`),
  "SQL-style '' escaping": (n) => block(n, "    1, 'zq''SENTX7'\n"),
  'an unescaped apostrophe': (n) => block(n, "    1, 'zq'SENTX7'\n"),
  'a bare word with a space': (n) => block(n, `    1, ${SENTINEL} x\n`),
  "an unclosed '''": (n) => block(n, `    1, '''${SENTINEL}\n`),
  'a short row': (n) => block(n, `    1, '${SENTINEL}'\n`, '(id, name, owner_id)'),
  'a duplicate primary key': (n) => block(n, `    1, '${SENTINEL}'\n    1, '${SENTINEL}'\n`),
  'a value under a foreign key': (n) => block(n, `    1, 'a', '${SENTINEL}'\n`, '(id, name, owner_id)'),
  'a value in the header': (n) => block(n, "    1, 'a'\n", `(id, "${SENTINEL}")`),
  'a top-level Records block': (n) => `${head(n)}}\n\nRecords gold.${n}(id, name) {\n  1, '${SENTINEL}'\n}\n`,
  'a top-level Records block with a dotted value': (n) => `${head(n)}}\n\nRecords gold.${n}(id, name) {\n  1, ${SENTINEL}.y\n}\n`,
  'two blocks': (n) => `${head(n)}\n  records (id, name) {\n    1, '${SENTINEL}'\n  }\n  records (id, name) {\n    2, ${SENTINEL}.y\n  }\n}\n`,
  'a header the parser does not read as records': (n) => `${head(n)}\n  records (id, name) // c\n  {\n    1, ${SENTINEL}.y\n  }\n}\n`,
};

function thrown(fn: () => unknown): Error | undefined {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  return undefined;
}

const KEEP_ID: SemanticTable = { name: 't', schema: 'gold', columns: [{ name: 'id', dataType: 'int', description: '' }] };

describe.each(STORAGE_PARSERS)('no cell value leaves core (%s)', (_label, parser) => {
  for (const [shape, text] of Object.entries(SHAPES)) {
    describe(shape, () => {
      const file = text('t');

      it('the reading: its error message, its problems and the whole reading', () => {
        const reading = parseTableDbml(file, 't', { schemaFolder: 'gold' }, parser);
        if (!reading.ok) expect(reading.error.message).not.toMatch(LEAK);
        else expect(JSON.stringify(reading.problems)).not.toMatch(LEAK);
        expect(JSON.stringify(reading)).not.toMatch(LEAK);
      });

      it('a writer refusal', () => {
        const err = thrown(() => editTableDbml(file, KEEP_ID, { fileStem: 't', file: 'gold/tables/gold/t.dbml', schemaFolder: 'gold', parser }));
        if (err) expect(err.message).not.toMatch(LEAK);
      });

      it('the multi-file compile', () => {
        const out = compileDbmlProject({ 'gold/tables/gold/t.dbml': file }, ['gold/tables/gold/t.dbml'], parser);
        expect(JSON.stringify(out)).not.toMatch(LEAK);
      });

      it("the formatter's errors and self-check detail", () => {
        const out = formatDbml(file, { parser });
        expect(JSON.stringify(out.errors ?? [])).not.toMatch(LEAK);
        expect(out.detail ?? '').not.toMatch(LEAK);
      });
    });
  }
});

describe('the messages a records block gets (pinned parser)', () => {
  const read = (text: string): string => {
    const reading = parseTableDbml(text, 't', { schemaFolder: 'gold' });
    if (reading.ok) throw new Error('expected the file not to read');
    return reading.error.message;
  };

  it('a value: located in the body, fixed words with the line, column and code', () => {
    expect(read(SHAPES['a dotted bare word']('t'))).toBe('Line 7, column 8: a value in the sample data (records) does not read as DBML [4000].');
    expect(read(SHAPES['a bare word with a space']('t'))).toBe('Line 7, column 5: a value in the sample data (records) does not read as DBML [3084].');
    expect(read(SHAPES["an unclosed '''"]('t'))).toBe('Line 7, column 8: a value in the sample data (records) does not read as DBML [1002].');
  });

  it('the header: a value or an unknown column in the list, and two blocks', () => {
    expect(read(SHAPES['a value in the header']('t'))).toBe('Line 6, column 16: the header of the sample data (records) does not read as DBML [4000].');
    const twoBlocks = `${head('t')}\n  records (id, name) {\n    1, '${SENTINEL}'\n  }\n  records (id, name) {\n    2, 'b'\n  }\n}\n`;
    expect(read(twoBlocks)).toBe('Line 6, column 3: the header of the sample data (records) does not read as DBML [3086].');
  });

  it('a top-level Records block: told to nest it, its header without the table name', () => {
    expect(read(SHAPES['a top-level Records block']('t'))).toBe(
      'Line 7: a table file keeps its sample data inside its Table. Move this Records block into the Table and write its header as records (column, …), without the table name.',
    );
    const reading = parseTableDbml(SHAPES['a top-level Records block']('t'), 't', { schemaFolder: 'gold' });
    expect(reading.ok ? undefined : reading.error).toMatchObject({ kind: 'dbmlStructure', code: 'structure:unsupportedElement', line: 7 });
  });

  it('a file without records keeps the parser\'s own message', () => {
    expect(read('Table gold.t {\n  id int [pk]\n  amount decimal [default: x.y]\n}\n')).toMatch(/^Line 3, column \d+: (?!a value|this line)/);
  });

  it('the multi-file compile says the same in fixed words, keeping each code, line and column', () => {
    const out = compileDbmlProject({ 't.dbml': SHAPES['a dotted bare word']('t') }, ['t.dbml']);
    expect(out['t.dbml']).toEqual([{ code: 4000, line: 7, column: 8, message: 'a value in the sample data (records) does not read as DBML' }]);
  });

  it("the formatter's self-check names a changed token by its place and kind, never its text (forced with a stub parser)", () => {
    const input = `Table gold.t {\n    id int [pk]\n  name varchar\n\n  records (id, name) {\n    1, '${SENTINEL}'\n  }\n}\n`;
    const pinned = DbmlParse as unknown as DbmlParserModule;
    const Base = pinned.MemoryProjectLayout as unknown as new () => { setSource(p: unknown, text: string): void };
    class Changing extends Base {
      setSource(p: unknown, text: string): void {
        super.setSource(p, text === input ? text : text.replace(SENTINEL, 'zqOTHER'));
      }
    }
    const out = formatDbml(input, { parser: { ...pinned, MemoryProjectLayout: Changing as unknown as DbmlParserModule['MemoryProjectLayout'] } });
    expect(out.skipped).toBe('self-check');
    expect(out.detail).toMatch(/^token \d+ changed \(<string>\)$/);
    expect(out.detail).not.toMatch(LEAK);
  });

  it("the formatter's syntax errors, located in a block", () => {
    const out = formatDbml(SHAPES['an unescaped apostrophe']('t'));
    expect(out.skipped).toBe('parse-errors');
    expect(out.errors!.length).toBeGreaterThan(0);
    for (const e of out.errors!) expect(e.message).toBe('a value in the sample data (records) does not read as DBML');
  });
});

describe('the value backstop: a diagnostic outside every block', () => {
  /** The pinned parser, whose compile adds a diagnostic at the start of the file quoting the first segment of a dotted value. */
  function quotingParser(quoted: string): DbmlParserModule {
    const pinned = DbmlParse as unknown as DbmlParserModule;
    const Real = pinned.Compiler as unknown as new (layout: unknown) => Record<string, unknown> & { parse: Record<string, (...a: unknown[]) => unknown> };
    class Quoting {
      constructor(layout: unknown) {
        const real = new Real(layout);
        const parse = new Proxy(real.parse, {
          get(target, prop) {
            const value = Reflect.get(target, prop) as unknown;
            if (prop === 'errors') {
              return (...a: unknown[]) => [
                ...((target.errors as (...b: unknown[]) => unknown[]).apply(target, a) ?? []),
                { code: 4000, diagnostic: `Enum '${quoted}' does not exist in Schema 'public'`, start: 0, nodeOrToken: { start: 0 } },
              ];
            }
            return typeof value === 'function' ? (value as (...b: unknown[]) => unknown).bind(target) : value;
          },
        });
        return new Proxy(real, {
          get(target, prop) {
            if (prop === 'parse') return parse;
            const value = Reflect.get(target, prop) as unknown;
            return typeof value === 'function' ? (value as (...b: unknown[]) => unknown).bind(target) : value;
          },
        });
      }
    }
    return { ...pinned, Compiler: Quoting as unknown as DbmlParserModule['Compiler'] };
  }

  const TEXT = block('t', `    1, '${SENTINEL}.y'\n`);

  it('is scrubbed in the reader and the multi-file compile, with its line, column and code', () => {
    const parser = quotingParser(SENTINEL);
    expect(compileOne(TEXT, parser).errors.map((e) => e.message)).toContain(`Enum '${SENTINEL}' does not exist in Schema 'public'`);
    const reading = parseTableDbml(TEXT, 't', { schemaFolder: 'gold' }, parser);
    expect(reading.ok ? '' : reading.error.message).toBe('Line 1, column 1: this line does not read as DBML [4000].');
    const out = compileDbmlProject({ 't.dbml': TEXT }, ['t.dbml'], parser);
    expect(out['t.dbml']).toEqual([{ code: 4000, line: 1, column: 1, message: 'this line does not read as DBML' }]);
    const err = thrown(() => editTableDbml(TEXT, KEEP_ID, { fileStem: 't', file: 't.dbml', schemaFolder: 'gold', parser }));
    expect(err).toBeInstanceOf(DbmlEditRefused);
    expect(err!.message).not.toMatch(LEAK);
  });

  it('a quoted token the file does not declare is scrubbed even when it is too short to be a value segment', () => {
    const text = block('t', "    1, 'ab.cd'\n");
    const sanitise = dbmlMessageSanitiser(text);
    expect(sanitise("Enum 'ab' does not exist in Schema 'public'", 0)).toBe('this line does not read as DBML');
    // A message naming only what the file declares keeps its words.
    expect(sanitise("Column 'name' does not exist in Table 'gold.t'", 0)).toBe("Column 'name' does not exist in Table 'gold.t'");
    expect(sanitise('Invalid newline encountered while parsing', 0)).toBe('Invalid newline encountered while parsing');
  });

  it('in a file without a records token, every message is the parser\'s own', () => {
    const sanitise = dbmlMessageSanitiser('Table gold.t {\n  id int\n}\n');
    expect(sanitise(`Enum '${SENTINEL}' does not exist in Schema 'public'`, 0)).toBe(`Enum '${SENTINEL}' does not exist in Schema 'public'`);
  });
});

describe('a parser that throws', () => {
  it('keeps its message only when the text holds no records token', () => {
    expect(exportedParserStoppedMessage).toBe(parserStoppedMessage);
    const boom = new Error(`boom ${SENTINEL}`);
    expect(parserStoppedMessage(boom, 'Table t {\n  id int\n}\n')).toBe(`The DBML parser stopped: boom ${SENTINEL}`);
    expect(parserStoppedMessage(boom, block('t', `    1, '${SENTINEL}'\n`))).toBe('The DBML parser stopped.');
    expect(parserStoppedMessage('plain', 'x')).toBe('The DBML parser stopped: plain');
  });

  it('the reader and the writer say only that it stopped, for a file with records', () => {
    const pinned = DbmlParse as unknown as DbmlParserModule;
    class Throwing {
      constructor() {
        throw new Error(`stopped at ${SENTINEL}`);
      }
    }
    const parser = { ...pinned, Compiler: Throwing as unknown as DbmlParserModule['Compiler'] };
    const text = block('t', `    1, '${SENTINEL}'\n`);
    const reading = parseTableDbml(text, 't', { schemaFolder: 'gold' }, parser);
    expect(reading.ok ? '' : reading.error.message).toBe('The DBML parser stopped.');
    const err = thrown(() => editTableDbml(text, KEEP_ID, { fileStem: 't', file: 't.dbml', schemaFolder: 'gold', parser }));
    expect(err!.message).toBe('Fix the DBML in t.dbml first (the DBML parser stopped). ERD Studio never rewrites a file it cannot read.');
  });
});

describe("the writer's own refusals hold no value", () => {
  const HEAD = 'Table gold.t {\n  id int\n  name varchar\n  amount decimal\n\n';
  const keep = (...names: string[]): SemanticTable => ({
    name: 't', schema: 'gold',
    columns: [['id', 'int'], ['name', 'varchar'], ['amount', 'decimal']].filter(([n]) => names.includes(n)).map(([name, dataType]) => ({ name, dataType, description: '' })),
  });

  it('the safety net (forced with a stub parser that loses a row on read-back)', () => {
    const pinned = DbmlParse as unknown as DbmlParserModule;
    const Base = pinned.MemoryProjectLayout as unknown as new () => { setSource(p: unknown, text: string): void };
    class RowDropping extends Base {
      setSource(p: unknown, text: string): void {
        super.setSource(p, text.includes('amount') ? text : text.replace("\n    2, 'b'", ''));
      }
    }
    const parser: DbmlParserModule = { ...pinned, MemoryProjectLayout: RowDropping as unknown as DbmlParserModule['MemoryProjectLayout'] };
    const text = `${HEAD}  records (id, name, amount) {\n    1, '${SENTINEL}', 1.5\n    2, 'b', 2.5\n  }\n}\n`;
    const err = thrown(() => editTableDbml(text, keep('id', 'name'), { fileStem: 't', file: 't.dbml', parser }));
    expect(err).toBeInstanceOf(DbmlEditRefused);
    expect(err!.message).not.toMatch(LEAK);
  });

  it('the cut guard (a cut that would cross a line break)', () => {
    const text = `${HEAD}  records (id, name) {\n    1, /* a note\n    over two lines */ '${SENTINEL}'\n  }\n}\n`;
    const err = thrown(() => editTableDbml(text, keep('name', 'amount'), { fileStem: 't', file: 't.dbml' }));
    expect(err).toBeDefined();
    expect(err!.message).not.toMatch(LEAK);
  });

  it('the sign refusal (R2)', () => {
    const text = `${HEAD}  records (id, amount, name) {\n    1, 1.5, '${SENTINEL}'\n    2, -2.5, 'b'\n  }\n}\n`;
    const err = thrown(() => editTableDbml(text, keep('amount', 'name'), { fileStem: 't', file: 't.dbml' }));
    expect(err).toBeInstanceOf(DbmlEditRefused);
    expect(err!.message).not.toMatch(LEAK);
  });
});

describe('the loader: no warning holds a value', () => {
  const FIXTURE = path.resolve(__dirname, '../fixtures/dbml/sample-rows-2.0');
  function fixture(): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out[path.relative(FIXTURE, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf-8');
      }
    };
    walk(FIXTURE);
    return out;
  }

  for (const [shape, text] of Object.entries(SHAPES)) {
    it(shape, async () => {
      const files: Record<string, string> = { ...fixture(), '.erd-studio/gold/tables/gold/dim_store.dbml': text('dim_store') };
      const warnings: string[] = [];
      const display = await loadDisplaySubjectArea({
        domainPath: '.erd-studio/gold/diagrams/catalog.dbml',
        readFile: async (p) => files[p] ?? null,
        readOnly: false,
        warn: (m) => warnings.push(m),
        dbml: dbmlStorageReader,
      });
      expect(warnings.join('\n')).not.toMatch(LEAK);
      expect(JSON.stringify(display)).not.toMatch(LEAK);
    });
  }
});
