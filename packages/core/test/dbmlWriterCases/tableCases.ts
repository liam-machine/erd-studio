/**
 * The table-file writer cases (§9.3 `dbmlWriteTable`): each one edits (or
 * creates) a table file and checks the text. `dbmlWriteTable.test.ts` runs
 * the checks; `dbmlMultiParser.test.ts` compiles every output again under
 * 9.1.1, 10.3.1 and 11.0.0. Not a test file.
 */
import { expect } from 'vitest';

import { editTableDbml, renderNewTableDbml } from '../../src/dbml/writeTable';
import type { SemanticTable } from '../../src/types/semantic';
import { clone, readTable, type WriterCase, type WriterOutcome } from '../dbmlWriterSupport';

/** Read `text`, apply `change` to a copy of the table, and write it back. */
export function edited(text: string, change: (t: SemanticTable) => void, stem = 'fct_order', options: Parameters<typeof editTableDbml>[2] = {}): string {
  const desired = clone(readTable(text, stem).table);
  change(desired);
  return editTableDbml(text, desired, { fileStem: stem, ...options });
}

const path = (stem: string): string => `tables/${stem}.dbml`;

function tableCase(
  name: string,
  stem: string,
  input: string,
  change: (t: SemanticTable) => void,
  check: (output: string) => void,
  parsers?: readonly string[],
  options: Parameters<typeof editTableDbml>[2] = {},
): WriterCase {
  return {
    name,
    run: (): WriterOutcome => ({ path: path(stem), input, output: edited(input, change, stem, options), ...(parsers ? { parsers } : {}) }),
    check: (o) => check(o.output),
  };
}

const RENAME = { rename: true } as const;

/** The spec's §2.2 example, with a header comment and comments on columns. */
export const FCT_ORDER = `// Order lines from the shop. Hand-written comments like this one survive every save.
Table fct_order [
  schema: 'gold',
  role: 'transaction-fact',
  grain: 'One row per order line',
  alias: 'orders',
  rationale_purpose: 'Revenue reporting by day, customer and region',
  rationale_measures: 'amount is additive',
  meta_owner: 'sales-data',
  meta_json: '{"pii":false,"tags":["finance"]}'
] {
  order_line_id BIGINT [pk, note: 'Line id from the shop']
  customer_key INT [foreign_key: 'true']
  order_date_key INT
  // the ship date, when known
  ship_date_key INT
  region_code VARCHAR
  country_code VARCHAR
  amount "DECIMAL(18,2)" [additive_type: 'additive', note: 'Line total']
  order_number VARCHAR [natural_key: 'true'] // the business key
  loaded_at timestamp [not null, default: \`now()\`]   // DBML-only settings: kept, never read
  Note: 'Order lines'
}
`;

const INLINE = `Table fct_order [role: 'transaction-fact'] {
  id int [pk]
  amount int
}
`;

const BARE = `Table fct_order {
  id int [pk]
  amount int
}
`;

const COMPOSITE = `Table fct_order {
  a int
  b int
  c int
  indexes {
    (a, b) [pk]
    c [unique]
  }
  Note: 'composite'
}
`;

/** The Law 2 edit: settings, a removed and a new column, the key moved and new meta. */
function lawTwoChange(t: SemanticTable): void {
  t.grain = 'g2';
  t.columns!.splice(2, 1);
  t.columns!.push({ name: 'z', dataType: 'int', description: 'zz', isNaturalKey: true });
  t.columns![0].isPrimaryKey = false;
  t.columns![1].isPrimaryKey = true;
  t.meta = { owner: 'o', n: ['1', true, null] };
}

export const TABLE_CASES: WriterCase[] = [
  tableCase('a no-op is byte-identical (Law 1)', 'fct_order', FCT_ORDER, () => undefined, (out) => { expect(out).toBe(FCT_ORDER); }),
  tableCase('is idempotent (Law 2)', 'fct_order', FCT_ORDER, lawTwoChange, (out) => {
    const desired = clone(readTable(FCT_ORDER, 'fct_order').table);
    lawTwoChange(desired);
    expect(editTableDbml(out, desired)).toBe(out);
  }),
  // --- Table settings -------------------------------------------------------
  tableCase('a changed setting splices its value only', 'fct_order', FCT_ORDER, (t) => { t.grain = 'One row per order'; }, (out) => {
    expect(out).toBe(FCT_ORDER.replace("grain: 'One row per order line'", "grain: 'One row per order'"));
  }),
  tableCase('a setting added to a multi-line list gets its own line, with a comma after the one before', 'fct_order', FCT_ORDER, (t) => {
    t.rationale = { ...t.rationale, design: 'Star' };
  }, (out) => {
    expect(out).toContain(`  meta_json: '{"pii":false,"tags":["finance"]}',\n  rationale_design: 'Star'\n] {`);
  }),
  tableCase('a setting removed from a multi-line list loses its line, and the comma before a new last one goes', 'fct_order', FCT_ORDER, (t) => {
    delete t.meta;
  }, (out) => {
    expect(out).toContain("  rationale_measures: 'amount is additive'\n] {");
    expect(out).not.toContain('meta_');
  }),
  tableCase('a setting added to an inline list is appended', 'fct_order', INLINE, (t) => { t.grain = 'One row per order'; }, (out) => {
    expect(out).toBe(INLINE.replace("[role: 'transaction-fact']", "[role: 'transaction-fact', grain: 'One row per order']"));
  }),
  tableCase('the last setting removed from an inline list removes the brackets', 'fct_order', INLINE, (t) => { delete t.modelRole; }, (out) => {
    expect(out).toBe(INLINE.replace(" [role: 'transaction-fact']", ''));
  }),
  tableCase('a table with no list gets one before its body', 'fct_order', BARE, (t) => { t.grain = 'g'; }, (out) => {
    expect(out).toBe(BARE.replace('Table fct_order {', "Table fct_order [grain: 'g'] {"));
  }),
  tableCase('several settings on a table with no list go one per line', 'fct_order', BARE, (t) => { t.grain = 'g'; t.modelRole = 'transaction-fact'; }, (out) => {
    expect(out).toBe(BARE.replace('Table fct_order {', "Table fct_order [\n  role: 'transaction-fact',\n  grain: 'g'\n] {"));
  }),
  tableCase('a new list on `Table x as X {` goes after the alias', 'fct_order', 'Table fct_order as FO {\n  id int\n}\n', (t) => { t.grain = 'g'; }, (out) => {
    expect(out).toBe("Table fct_order as FO [grain: 'g'] {\n  id int\n}\n");
  }),
  tableCase('an erd_ spelling is kept when its value changes', 'fct_order', "Table fct_order [erd_grain: 'old'] {\n  id int\n}\n", (t) => { t.grain = 'new'; }, (out) => {
    expect(out).toBe("Table fct_order [erd_grain: 'new'] {\n  id int\n}\n");
  }),
  tableCase('a value is compared by what it reads as: a double-quoted string the same as a single-quoted one', 'fct_order', 'Table fct_order [grain: "same"] {\n  id int\n}\n', (t) => { t.grain = 'same'; }, (out) => {
    expect(out).toBe('Table fct_order [grain: "same"] {\n  id int\n}\n');
  }),

  // --- Meta -------------------------------------------------------------------
  tableCase('only the meta entries that changed are touched', 'fct_order', FCT_ORDER, (t) => { t.meta = { ...t.meta, owner: 'finance' }; }, (out) => {
    expect(out).toBe(FCT_ORDER.replace("meta_owner: 'sales-data'", "meta_owner: 'finance'"));
  }),
  tableCase('meta_json is rewritten only when what it holds changes', 'fct_order', FCT_ORDER, (t) => { t.meta = { ...t.meta, pii: true }; }, (out) => {
    expect(out).toBe(FCT_ORDER.replace(`meta_json: '{"pii":false,"tags":["finance"]}'`, `meta_json: '{"pii":true,"tags":["finance"]}'`));
  }),
  tableCase('a new string meta entry is its own meta_<key>', 'fct_order', BARE, (t) => { t.meta = { team: 'sales' }; }, (out) => {
    expect(out).toBe(BARE.replace('Table fct_order {', "Table fct_order [meta_team: 'sales'] {"));
  }),
  tableCase('a meta_<key> that overrides the same key in meta_json is left alone by an edit of another key', 'fct_order',
    `Table fct_order [meta_owner: 'wins', meta_json: '{"owner":"loses","n":"1"}'] {\n  id int\n}\n`, (t) => { t.meta = { ...t.meta, n: '2' }; }, (out) => {
      expect(out).toBe(`Table fct_order [meta_owner: 'wins', meta_json: '{"owner":"loses","n":"2"}'] {\n  id int\n}\n`);
    }),
  tableCase('2000-character meta values with quotes, backslashes and new lines round-trip', 'fct_order', BARE, (t) => {
    const long = `${"it's a \\ path\nand 'more' ".repeat(80)}`.slice(0, 2000);
    t.meta = { long, other: long };
    t.grain = long;
  }, (out) => {
    const long = `${"it's a \\ path\nand 'more' ".repeat(80)}`.slice(0, 2000);
    const table = readTable(out, 'fct_order').table;
    expect(table.meta).toEqual({ long, other: long });
    expect(table.grain).toBe(long);
  }),

  // --- Description ------------------------------------------------------------
  tableCase('the body Note is spliced', 'fct_order', FCT_ORDER, (t) => { t.description = 'Lines'; }, (out) => {
    expect(out).toBe(FCT_ORDER.replace("Note: 'Order lines'", "Note: 'Lines'"));
  }),
  tableCase('a header note setting is edited where it is', 'fct_order', "Table fct_order [note: 'old'] {\n  id int\n}\n", (t) => { t.description = 'new'; }, (out) => {
    expect(out).toBe("Table fct_order [note: 'new'] {\n  id int\n}\n");
  }),
  tableCase('a new description is the last line of the body', 'fct_order', BARE, (t) => { t.description = '  Leading space is dropped'; }, (out) => {
    expect(out).toBe(BARE.replace('  amount int\n}', "  amount int\n  Note: 'Leading space is dropped'\n}"));
  }),
  tableCase('a removed description loses its line', 'fct_order', FCT_ORDER, (t) => { delete t.description; }, (out) => {
    expect(out).toBe(FCT_ORDER.replace("  Note: 'Order lines'\n", ''));
  }),

  // --- Columns ----------------------------------------------------------------
  tableCase('a column type change splices the type', 'fct_order', FCT_ORDER, (t) => { t.columns![2].dataType = 'DATE'; }, (out) => {
    expect(out).toBe(FCT_ORDER.replace('order_date_key INT', 'order_date_key DATE'));
  }),
  tableCase('a type with arguments is quoted', 'fct_order', BARE, (t) => { t.columns![1].dataType = 'DECIMAL(18,2)'; }, (out) => {
    expect(out).toBe(BARE.replace('amount int', 'amount "DECIMAL(18,2)"'));
  }),
  tableCase('a column renamed in place (one removed and one added at the same index) keeps its settings', 'fct_order', FCT_ORDER, (t) => {
    t.columns![7].name = 'order_ref';
  }, (out) => {
    expect(out).toBe(FCT_ORDER.replace("order_number VARCHAR [natural_key: 'true']", "order_ref VARCHAR [natural_key: 'true']"));
  }),
  tableCase('a column settings change splices only that setting', 'fct_order', FCT_ORDER, (t) => {
    t.columns![6].additiveType = 'semi-additive';
    t.columns![0].description = 'The line id';
  }, (out) => {
    expect(out).toBe(FCT_ORDER
      .replace("[additive_type: 'additive', note: 'Line total']", "[additive_type: 'semi-additive', note: 'Line total']")
      .replace("note: 'Line id from the shop'", "note: 'The line id'"));
  }),
  tableCase('a flag set gets added; one unset removes the setting', 'fct_order', FCT_ORDER, (t) => {
    t.columns![1].isForeignKey = false;
    t.columns![2].isForeignKey = true;
  }, (out) => {
    expect(out).toContain('  customer_key INT\n');
    expect(out).toContain("  order_date_key INT [foreign_key: 'true']\n");
  }),
  tableCase('a new column goes after the line of the previous desired column', 'fct_order', FCT_ORDER, (t) => {
    t.columns!.splice(3, 0, { name: 'promised_date_key', dataType: 'INT', description: 'When promised', isForeignKey: true });
  }, (out) => {
    expect(out).toBe(FCT_ORDER.replace('  order_date_key INT\n', "  order_date_key INT\n  promised_date_key INT [note: 'When promised', foreign_key: 'true']\n"));
  }),
  tableCase('a new first column goes before the first column', 'fct_order', BARE, (t) => {
    t.columns!.unshift({ name: 'tenant', dataType: 'int', description: '' });
  }, (out) => {
    expect(out).toBe(BARE.replace('  id int [pk]', '  tenant int\n  id int [pk]'));
  }),
  tableCase('removing a column keeps the comment lines above it', 'fct_order', FCT_ORDER, (t) => {
    t.columns!.splice(3, 1);
  }, (out) => {
    expect(out).toBe(FCT_ORDER.replace('  ship_date_key INT\n', ''));
    expect(out).toContain('// the ship date, when known');
  }),
  tableCase('removing the first column never touches the header comment', 'fct_order', FCT_ORDER, (t) => {
    t.columns!.shift();
    t.columns![0].isPrimaryKey = true;
  }, (out) => {
    expect(out.startsWith('// Order lines from the shop.')).toBe(true);
    expect(out).toContain("  customer_key INT [foreign_key: 'true', pk]\n");
    expect(out).not.toContain('order_line_id');
  }),
  tableCase('reordering columns moves each with the comment lines above it', 'fct_order', FCT_ORDER, (t) => {
    const cols = t.columns!;
    t.columns = [cols[3], ...cols.slice(0, 3), ...cols.slice(4)];
  }, (out) => {
    expect(out).toContain("] {\n  // the ship date, when known\n  ship_date_key INT\n  order_line_id BIGINT [pk, note: 'Line id from the shop']\n");
    expect(readTable(out, 'fct_order').table.columns!.map((c) => c.name)).toEqual([
      'ship_date_key', 'order_line_id', 'customer_key', 'order_date_key', 'region_code', 'country_code', 'amount', 'order_number', 'loaded_at',
    ]);
    expect(out.startsWith('// Order lines from the shop.')).toBe(true);
    expect(out).toContain("  order_number VARCHAR [natural_key: 'true'] // the business key\n");
  }),
  tableCase('reordering with an edit inside a moved column keeps both', 'fct_order', BARE, (t) => {
    t.columns = [{ ...t.columns![1], description: 'Total' }, t.columns![0]];
  }, (out) => {
    expect(out).toBe("Table fct_order {\n  amount int [note: 'Total']\n  id int [pk]\n}\n");
  }),

  // --- Primary key --------------------------------------------------------------
  tableCase('primary key 1 → 0 removes the flag', 'fct_order', BARE, (t) => { t.columns![0].isPrimaryKey = false; }, (out) => {
    expect(out).toBe(BARE.replace('  id int [pk]', '  id int'));
  }),
  tableCase('primary key 0 → 1 adds the flag', 'fct_order', 'Table fct_order {\n  id int\n}\n', (t) => { t.columns![0].isPrimaryKey = true; }, (out) => {
    expect(out).toBe('Table fct_order {\n  id int [pk]\n}\n');
  }),
  tableCase('primary key 1 → 2 moves it to an indexes block before the Note', 'fct_order', FCT_ORDER, (t) => { t.columns![1].isPrimaryKey = true; }, (out) => {
    expect(out).toContain("  order_line_id BIGINT [note: 'Line id from the shop']\n");
    expect(out).toContain("  loaded_at timestamp [not null, default: `now()`]   // DBML-only settings: kept, never read\n  indexes {\n    (order_line_id, customer_key) [pk]\n  }\n  Note: 'Order lines'\n");
  }),
  tableCase('primary key 2 → 1 puts the flag on the column and removes the empty indexes block', 'fct_order',
    'Table fct_order {\n  a int\n  b int\n  indexes {\n    (a, b) [pk]\n  }\n}\n', (t) => { t.columns![1].isPrimaryKey = false; }, (out) => {
      expect(out).toBe('Table fct_order {\n  a int [pk]\n  b int\n}\n');
    }),
  tableCase('primary key 2 → 0 keeps other index lines', 'fct_order', COMPOSITE, (t) => { for (const c of t.columns!) c.isPrimaryKey = false; }, (out) => {
    expect(out).toBe(COMPOSITE.replace('    (a, b) [pk]\n', ''));
  }),
  tableCase('primary key 2 → 2 (another pair) replaces the pk line', 'fct_order', COMPOSITE, (t) => {
    t.columns![0].isPrimaryKey = false;
    t.columns![2].isPrimaryKey = true;
  }, (out) => {
    expect(out).toBe(COMPOSITE.replace('(a, b) [pk]', '(b, c) [pk]'));
  }),
  tableCase('primary key 0 → 2 goes into an existing indexes block', 'fct_order', 'Table fct_order {\n  a int\n  b int\n  indexes {\n    a [unique]\n  }\n}\n', (t) => {
    t.columns![0].isPrimaryKey = true;
    t.columns![1].isPrimaryKey = true;
  }, (out) => {
    expect(out).toBe('Table fct_order {\n  a int\n  b int\n  indexes {\n    a [unique]\n    (a, b) [pk]\n  }\n}\n');
  }),
  tableCase('reordering columns while going to a composite key puts the indexes block before a body Note among the columns', 'fct_order',
    "Table fct_order {\n  a int [pk]\n  Note: 'n'\n  b int\n}\n", (t) => {
      t.columns!.reverse();
      for (const c of t.columns!) c.isPrimaryKey = true;
    }, (out) => {
      expect(out).toBe("Table fct_order {\n  b int\n  a int\n  indexes {\n    (b, a) [pk]\n  }\n  Note: 'n'\n}\n");
    }),
  tableCase('removing a column cuts the index lines that name it, with their comments, and keeps an expression index', 'fct_order',
    "Table fct_order {\n  a int [pk]\n  b int\n  c int\n  indexes {\n    c [unique] // c alone\n    (b, c) [name: 'bc'] // b and c\n    `lower(b)` [name: 'expr']\n    b\n  }\n}\n", (t) => {
      t.columns!.pop();
    }, (out) => {
      expect(out).toBe("Table fct_order {\n  a int [pk]\n  b int\n  indexes {\n    `lower(b)` [name: 'expr']\n    b\n  }\n}\n");
    }),
  // A one-line settings list with a block comment is spliced element by element (Law 4).
  tableCase('a one-line settings list keeps a block comment when a value in it changes', 'fct_order',
    "Table fct_order {\n  id int [pk, /* keep me */ note: 'a']\n}\n", (t) => { t.columns![0].description = 'b'; }, (out) => {
      expect(out).toBe("Table fct_order {\n  id int [pk, /* keep me */ note: 'b']\n}\n");
    }),
  tableCase('…and when a setting is removed from it or added to it', 'fct_order',
    "Table fct_order {\n  id int [pk, /* keep me */ note: 'a']\n  v int [/* first */ note: 'x', pk]\n}\n", (t) => {
      t.columns![0].isPrimaryKey = false;
      t.columns![0].isNaturalKey = true;
      t.columns![1].description = '';
    }, (out) => {
      expect(out).toBe("Table fct_order {\n  id int [ /* keep me */ note: 'a', natural_key: 'true']\n  v int [/* first */  pk]\n}\n");
    }),
  tableCase('renaming a column that an index names renames it there too', 'fct_order', COMPOSITE, (t) => { t.columns![1].name = 'b2'; }, (out) => {
    expect(out).toBe(COMPOSITE.replace('  b int', '  b2 int').replace('(a, b) [pk]', '(a, b2) [pk]'));
  }),

  // --- Placeholder ----------------------------------------------------------------
  tableCase('a table left with no columns gets the placeholder', 'fct_order', BARE, (t) => { t.columns = []; }, (out) => {
    expect(out).toBe("Table fct_order {\n  _erd_no_columns unknown [erd_placeholder: 'true', note: 'ERD Studio: this table has no columns yet, and DBML needs one']\n}\n");
    expect(readTable(out, 'fct_order').table.columns).toEqual([]);
  }),
  tableCase('the placeholder goes when a column is added', 'fct_order', renderNewTableDbml({ name: 'fct_order', columns: [] }), (t) => {
    t.columns = [{ name: 'id', dataType: 'int', description: '' }];
  }, (out) => {
    expect(out).toBe('Table fct_order {\n  id int\n}\n');
  }),

  // --- Names ------------------------------------------------------------------------
  tableCase('a rename splices the name and keeps a schema qualifier and an alias', 'fct_order', "Table gold.fct_order as FO {\n  id int\n}\nMetadata Table gold.fct_order {\n  grain: 'g'\n}\n", (t) => {
    t.name = 'fct_order_line';
  }, (out) => {
    expect(out).toBe("Table gold.fct_order_line as FO {\n  id int\n}\nMetadata Table gold.fct_order_line {\n  grain: 'g'\n}\n");
  }, undefined, RENAME),
  tableCase('a name that differs only in case keeps the declared spelling when the edit is not a rename', 'fct_order', BARE, (t) => {
    t.name = 'FCT_ORDER';
    t.grain = 'g';
  }, (out) => {
    expect(out).toBe(BARE.replace('Table fct_order {', "Table fct_order [grain: 'g'] {"));
  }),
  tableCase('a schema-qualified name with a schema property edits the property', 'fct_order', "Table gold.fct_order [schema: 'gold'] {\n  id int\n}\n", (t) => {
    t.schema = 'silver';
  }, (out) => {
    expect(out).toBe("Table gold.fct_order [schema: 'silver'] {\n  id int\n}\n");
  }),
  tableCase('keywords, upper case, digit-leading and odd names are quoted', 'fct_order', BARE, (t) => {
    t.columns!.push(
      { name: 'note', dataType: 'int', description: '' },
      { name: 'Table', dataType: 'int', description: '' },
      { name: '1st', dataType: 'int', description: '' },
      { name: 'UPPER', dataType: 'double precision', description: '' },
      { name: 'with "quote"', dataType: '', description: '' },
    );
  }, (out) => {
    expect(out).toContain('  "note" int\n  "Table" int\n  "1st" int\n  UPPER "double precision"\n  "with \\"quote\\"" ""\n');
    expect(readTable(out, 'fct_order').table.columns!.map((c) => [c.name, c.dataType])).toEqual([
      ['id', 'int'], ['amount', 'int'], ['note', 'int'], ['Table', 'int'], ['1st', 'int'], ['UPPER', 'double precision'], ['with "quote"', ''],
    ]);
  }),
  {
    name: 'a table named as a keyword, with odd characters, is written and edited',
    run: (): WriterOutcome => {
      const created = renderNewTableDbml({ name: 'Order Lines (v2)', columns: [{ name: 'id', dataType: 'int', description: '', isPrimaryKey: true }] });
      return { path: 'tables/Order Lines (v2).dbml', input: created, output: edited(created, (t) => { t.grain = 'g'; }, 'Order Lines (v2)') };
    },
    check: (o) => {
      expect(o.output).toBe("Table \"Order Lines (v2)\" [grain: 'g'] {\n  id int [pk]\n}\n");
    },
  },

  // --- Files as they are ---------------------------------------------------------------
  {
    name: 'a byte-order mark is kept',
    run: () => ({ path: path('fct_order'), output: edited(`﻿${BARE}`, (t) => { t.grain = 'g'; }) }),
    check: (o) => { expect(o.output).toBe(`﻿${BARE.replace('Table fct_order {', "Table fct_order [grain: 'g'] {")}`); },
  },
  tableCase('CRLF line endings are kept, and new lines use them', 'fct_order', FCT_ORDER.replace(/\n/g, '\r\n'), (t) => {
    t.columns!.push({ name: 'extra', dataType: 'int', description: '' });
    t.rationale = { ...t.rationale, design: 'd' };
    t.description = 'x';
  }, (out) => {
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out).toContain("  rationale_design: 'd'\r\n] {");
    expect(out).toContain('  extra int\r\n');
  }),
  tableCase('a no-op keeps `indexes { id [pk] }`, `primary key` flags and erd_ names', 'fct_order',
    "Table fct_order [erd_role: 'fact'] {\n  id int\n  other int [primary key]\n  indexes {\n    id [pk]\n  }\n}\n", () => undefined, (out) => {
      expect(out).toBe("Table fct_order [erd_role: 'fact'] {\n  id int\n  other int [primary key]\n  indexes {\n    id [pk]\n  }\n}\n");
    }),
  tableCase('settings ERD Studio does not model, Enums and comments survive an edit', 'fct_order',
    "// head\nTable fct_order [headercolor: #aabbcc] {\n  id int [pk, increment] // c1\n  status status_enum [not null, default: 'new']\n}\nEnum status_enum {\n  new\n  done\n}\n", (t) => {
      t.columns![1].description = 'State';
    }, (out) => {
      expect(out).toBe("// head\nTable fct_order [headercolor: #aabbcc] {\n  id int [pk, increment] // c1\n  status status_enum [not null, default: 'new', note: 'State']\n}\nEnum status_enum {\n  new\n  done\n}\n");
    }),

  // --- 11.0 typed values (§2.2) -------------------------------------------------------------
  tableCase('typed values stay byte for byte through an edit of another column', 'fct_order',
    'Table fct_order {\n  id int [natural_key: true]\n  v int [scd_type: 2]\n  other int\n}\n', (t) => { t.columns![2].description = 'o'; }, (out) => {
      expect(out).toBe("Table fct_order {\n  id int [natural_key: true]\n  v int [scd_type: 2]\n  other int [note: 'o']\n}\n");
    }),
  tableCase('changing a typed value writes it quoted', 'fct_order',
    'Table fct_order {\n  id int [natural_key: true]\n  v int [scd_type: 2]\n}\n', (t) => { t.columns![1].scdType = 1; }, (out) => {
      expect(out).toBe("Table fct_order {\n  id int [natural_key: true]\n  v int [scd_type: '1']\n}\n");
    }),

  // --- Metadata blocks (D25) ----------------------------------------------------------------
  tableCase('a property set by a Metadata block is edited in the block', 'fct_order', METADATA_TABLE(), (t) => {
    t.grain = 'from the edit';
    t.columns![0].description = 'new note';
    t.columns![0].meta = { owner: 'z' };
  }, (out) => {
    expect(out).toBe(METADATA_TABLE()
      .replace("grain: 'from the block'", "grain: 'from the edit'")
      .replace("note: '''multi\nline'''", "note: 'new note'")
      .replace("meta_owner: 'x'", "meta_owner: 'z'"));
    const table = readTable(out, 'fct_order').table;
    expect(table.grain).toBe('from the edit');
    expect(table.columns![0].description).toBe('new note');
  }),
  tableCase('clearing a block-set property removes the entry and the inline duplicate it shadowed', 'fct_order', METADATA_TABLE(), (t) => {
    delete t.grain;
  }, (out) => {
    expect(out).not.toContain('grain');
    expect(out).toContain('Metadata Table fct_order {\n}');
    expect(readTable(out, 'fct_order').table.grain).toBeUndefined();
  }),
  tableCase('renaming a column and the table retargets their Metadata blocks', 'fct_order', METADATA_TABLE(), (t) => {
    t.name = 'fct_line';
    t.columns![0].name = 'line_id';
  }, (out) => {
    expect(out).toContain('Metadata Column fct_line.line_id {');
    expect(out).toContain('Metadata Table fct_line {');
    expect(readTable(out, 'fct_line').table.columns![0].description).toBe('multi\nline');
  }, undefined, RENAME),
  tableCase('a table rename that also removes a column cuts its Metadata Column block and retargets the rest', 'fct_order',
    "Table fct_order {\n  a int\n  b int\n}\nMetadata Table fct_order {\n  grain: 'g'\n}\nMetadata Column fct_order.b {\n  note: 'n'\n}\n", (t) => {
      t.name = 'fct_line';
      t.columns!.pop();
    }, (out) => {
      expect(out).toBe("Table fct_line {\n  a int\n}\nMetadata Table fct_line {\n  grain: 'g'\n}\n");
    }, undefined, RENAME),
  tableCase('deleting a column removes its Metadata Column blocks', 'fct_order', METADATA_TABLE(), (t) => {
    t.columns!.shift();
  }, (out) => {
    expect(out).not.toContain('Metadata Column');
    expect(out).toContain('Metadata Table fct_order');
  }),
  tableCase('a block-set description (note) is edited in its block', 'fct_order', "Table fct_order {\n  id int\n  Note: 'body'\n}\nMetadata Table fct_order {\n  note: 'block'\n  headercolor: #aabbcc\n}\n", (t) => {
    t.description = 'edited';
  }, (out) => {
    expect(out).toBe("Table fct_order {\n  id int\n  Note: 'body'\n}\nMetadata Table fct_order {\n  note: 'edited'\n  headercolor: #aabbcc\n}\n");
  }),
  tableCase('a no-op keeps a file with Metadata blocks byte for byte', 'fct_order', METADATA_TABLE(), () => undefined, (out) => {
    expect(out).toBe(METADATA_TABLE());
  }),
];

/** A table file with `Metadata` blocks before and after the Table (D25). */
export function METADATA_TABLE(): string {
  return `Metadata Table fct_order {
  grain: 'from the block'
}
Table fct_order [grain: 'inline'] {
  id int [note: 'x']
  amount int
}
Metadata Column fct_order.id {
  note: '''multi
line'''
  meta_owner: 'x'
}
`;
}

/** A table with every kind of value, for the read-back of a new file. */
const READ_BACK_TABLE: SemanticTable = {
  name: 'dim_customer',
  schema: 'silver',
  alias: 'customers',
  modelRole: 'conformed-dim',
  rationale: { scdStrategy: 'Type 2 on segment' },
  description: 'Customers\n  - indented bullet',
  meta: { tags: ['a', 'b'], owner: 'crm', 'Odd Key': 'x' },
  columns: [
    { name: 'customer_key', dataType: 'INT', description: 'Surrogate', isPrimaryKey: true, scdType: 0 },
    { name: 'segment', dataType: 'VARCHAR', description: '', scdType: 2, isNaturalKey: true },
  ],
};

/** New-file cases: `renderNewTableDbml` and its read-back. */
export const NEW_TABLE_CASES: WriterCase[] = [
  {
    name: 'a new table reads back as the table it was given',
    run: () => ({ path: 'tables/dim_customer.dbml', input: null, output: renderNewTableDbml(READ_BACK_TABLE) }),
    check: (o) => { expect(readTable(o.output, 'dim_customer').table).toEqual(READ_BACK_TABLE); },
  },
  {
    name: 'a new table follows the §2.2 layout',
    run: () => ({
      path: 'tables/gold/fct_order.dbml',
      input: null,
      output: renderNewTableDbml({
        name: 'fct_order',
        schema: 'gold',
        modelRole: 'transaction-fact',
        grain: 'One row per order line',
        description: 'Order lines',
        rationale: { measures: 'amount is additive', purpose: 'Revenue' },
        meta: { owner: 'sales-data', pii: false },
        columns: [
          { name: 'id', dataType: 'BIGINT', description: 'Line id', isPrimaryKey: true, isNaturalKey: true, scdType: 0 },
          { name: 'amount', dataType: 'DECIMAL(18,2)', description: '', additiveType: 'additive', isForeignKey: true, meta: { unit: 'AUD' } },
        ],
      }),
    }),
    check: (o) => {
      expect(o.output).toBe(`Table fct_order [
  schema: 'gold',
  role: 'transaction-fact',
  grain: 'One row per order line',
  rationale_purpose: 'Revenue',
  rationale_measures: 'amount is additive',
  meta_owner: 'sales-data',
  meta_json: '{"pii":false}'
] {
  id BIGINT [pk, note: 'Line id', natural_key: 'true', scd_type: '0']
  amount "DECIMAL(18,2)" [additive_type: 'additive', foreign_key: 'true', meta_unit: 'AUD']
  Note: 'Order lines'
}
`);
    },
  },
  {
    name: 'a new table with a composite key writes an indexes block',
    run: () => ({
      path: 'tables/sat.dbml',
      input: null,
      output: renderNewTableDbml({ name: 'sat', columns: [
        { name: 'hk', dataType: 'binary', description: '', isPrimaryKey: true },
        { name: 'load_date', dataType: 'timestamp', description: '', isPrimaryKey: true },
      ] }),
    }),
    check: (o) => {
      expect(o.output).toBe('Table sat {\n  hk binary\n  load_date timestamp\n  indexes {\n    (hk, load_date) [pk]\n  }\n}\n');
    },
  },
  {
    // Stress round 1: `{ owner: 'x', contains_pii: true }` read back as `{ contains_pii, owner }`.
    name: 'a new table keeps its meta in key order (meta_json where its first entry is)',
    run: () => ({
      path: 'tables/dim_employee.dbml',
      input: null,
      output: renderNewTableDbml({
        name: 'dim_employee',
        meta: { owner: 'people', contains_pii: true, exposure: 'crm' },
        columns: [{ name: 'id', dataType: 'int', description: '', meta: { a: 'x', b: true, c: 'y', d: ['p', 'q'], e: 'z' } }],
      }),
    }),
    check: (o) => {
      expect(o.output).toBe(
        "Table dim_employee [\n  meta_owner: 'people',\n  meta_json: '{\"contains_pii\":true}',\n  meta_exposure: 'crm'\n] {\n" +
          "  id int [meta_a: 'x', meta_json: '{\"b\":true,\"c\":\"y\",\"d\":[\"p\",\"q\"]}', meta_e: 'z']\n}\n",
      );
      const read = readTable(o.output, 'dim_employee').table;
      expect(Object.keys(read.meta ?? {})).toEqual(['owner', 'contains_pii', 'exposure']);
      expect(read.meta).toEqual({ owner: 'people', contains_pii: true, exposure: 'crm' });
      expect(Object.keys(read.columns?.[0]?.meta ?? {})).toEqual(['a', 'b', 'c', 'd', 'e']);
      expect(read.columns?.[0]?.meta).toEqual({ a: 'x', b: true, c: 'y', d: ['p', 'q'], e: 'z' });
    },
  },
  // Review of the stress fixes: an edit keeps the meta key order as YAML does.
  ...((): WriterCase[] => {
    const input = (meta: Record<string, unknown>, columnMeta?: Record<string, unknown>): string => renderNewTableDbml({
      name: 'fct_m', meta: meta as SemanticTable['meta'],
      columns: [{ name: 'id', dataType: 'int', description: '', ...(columnMeta ? { meta: columnMeta as SemanticTable['meta'] } : {}) }],
    });
    const order = (out: string, keys: string[], columnKeys?: string[]): void => {
      const read = readTable(out, 'fct_m').table;
      expect(Object.keys(read.meta ?? {})).toEqual(keys);
      if (columnKeys) expect(Object.keys(read.columns?.[0]?.meta ?? {})).toEqual(columnKeys);
    };
    return [
      tableCase('a new non-text meta entry reads back last, after the text entries that follow meta_json', 'fct_m',
        input({ owner: 'p', pii: true, team: 'd' }), (t) => { t.meta = { owner: 'p', pii: true, team: 'd', flag: false }; }, (out) => {
          order(out, ['owner', 'pii', 'team', 'flag']);
          expect(readTable(out, 'fct_m').table.meta).toEqual({ owner: 'p', pii: true, team: 'd', flag: false });
        }),
      tableCase('a text meta entry that becomes non-text keeps its place', 'fct_m',
        input({ owner: 'p', team: 'd', pii: true }), (t) => { t.meta = { owner: 'p', team: true, pii: true }; }, (out) => {
          order(out, ['owner', 'team', 'pii']);
        }),
      tableCase('the first meta entry turning non-text stays first', 'fct_m',
        input({ owner: 'p', team: 'd', pii: true }), (t) => { t.meta = { owner: true, team: 'd', pii: true }; }, (out) => {
          order(out, ['owner', 'team', 'pii']);
        }),
      tableCase('a column meta add keeps the column meta in key order', 'fct_m',
        input({ owner: 'p' }, { a: 'x', b: true, c: 'y' }), (t) => { t.columns![0].meta = { a: 'x', b: true, c: 'y', d: [1] }; }, (out) => {
          order(out, ['owner'], ['a', 'b', 'c', 'd']);
        }),
      tableCase('a meta add that keeps the order is still a splice', 'fct_m',
        input({ owner: 'p', pii: true }), (t) => { t.meta = { owner: 'p', pii: true, flag: false }; }, (out) => {
          expect(out).toBe(input({ owner: 'p', pii: true }).replace(`meta_json: '{"pii":true}'`, `meta_json: '{"pii":true,"flag":false}'`));
          order(out, ['owner', 'pii', 'flag']);
        }),
    ];
  })(),
];
