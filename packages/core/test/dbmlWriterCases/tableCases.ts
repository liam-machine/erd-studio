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

const path = (stem: string): string => `gold/tables/gold/${stem}.dbml`;

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
  // A field new to the file is written bare (context fields), among the field settings in catalogue order.
  tableCase('a setting added to a multi-line list gets its own line at its place in the canonical order', 'fct_order', FCT_ORDER, (t) => {
    t.rationale = { ...t.rationale, design: 'Star' };
  }, (out) => {
    expect(out).toBe(FCT_ORDER.replace("  rationale_measures:", "  design: 'Star',\n  rationale_measures:"));
  }),
  tableCase('a setting added last to a multi-line list gets its own line, with a comma after the one before', 'fct_order', FCT_ORDER, (t) => {
    t.meta = { ...t.meta, team: 'orders' };
  }, (out) => {
    expect(out).toContain(`  meta_json: '{"pii":false,"tags":["finance"]}',\n  team: 'orders'\n] {`);
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
  // The schema is the Table's qualifier (§1.2 of the 2.0 tree design), never a setting.
  tableCase('a new schema (requalify) is a qualifier put before an unqualified name, never a setting', 'fct_order', INLINE, (t) => { t.schema = 'gold'; }, (out) => {
    expect(out).toBe(INLINE.replace('Table fct_order [', 'Table gold.fct_order ['));
    expect(readTable(out, 'fct_order').table.schema).toBe('gold');
  }, undefined, { requalify: true }),
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
  tableCase('a new string meta entry is its own bare setting', 'fct_order', BARE, (t) => { t.meta = { team: 'sales' }; }, (out) => {
    expect(out).toBe(BARE.replace('Table fct_order {', "Table fct_order [team: 'sales'] {"));
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
  tableCase('a new description is the first line of the body, with a blank line after it', 'fct_order', BARE, (t) => { t.description = '  Leading space is dropped'; }, (out) => {
    expect(out).toBe(BARE.replace('Table fct_order {\n', "Table fct_order {\n  Note: 'Leading space is dropped'\n\n"));
  }),
  tableCase('a new description goes below a comment on the brace line', 'fct_order', 'Table fct_order { // the orders\n  // the key\n  id int\n}\n', (t) => { t.description = 'Orders'; }, (out) => {
    expect(out).toBe("Table fct_order { // the orders\n  Note: 'Orders'\n\n  // the key\n  id int\n}\n");
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
    expect(out).toBe(FCT_ORDER.replace('  order_date_key INT\n', "  order_date_key INT\n  promised_date_key INT [foreign_key: 'true', note: 'When promised']\n"));
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
    expect(out).toContain("  customer_key INT [pk, foreign_key: 'true']\n");
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
  tableCase('reordering columns while going to a composite key puts the indexes block last when the body Note sits among the columns', 'fct_order',
    "Table fct_order {\n  a int [pk]\n  Note: 'n'\n  b int\n}\n", (t) => {
      t.columns!.reverse();
      for (const c of t.columns!) c.isPrimaryKey = true;
    }, (out) => {
      expect(out).toBe("Table fct_order {\n  b int\n  a int\n  Note: 'n'\n  indexes {\n    (b, a) [pk]\n  }\n}\n");
    }),
  tableCase('a composite key in a table whose Note comes first puts the indexes block last', 'fct_order',
    "Table fct_order {\n  Note: 'n'\n\n  a int [pk]\n  b int\n}\n", (t) => {
      for (const c of t.columns!) c.isPrimaryKey = true;
    }, (out) => {
      expect(out).toBe("Table fct_order {\n  Note: 'n'\n\n  a int\n  b int\n  indexes {\n    (a, b) [pk]\n  }\n}\n");
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
      // natural_key sorts before note, so it goes in front of it.
      expect(out).toBe("Table fct_order {\n  id int [ /* keep me */ natural_key: 'true', note: 'a']\n  v int [/* first */  pk]\n}\n");
    }),
  tableCase('renaming a column that an index names renames it there too', 'fct_order', COMPOSITE, (t) => { t.columns![1].name = 'b2'; }, (out) => {
    expect(out).toBe(COMPOSITE.replace('  b int', '  b2 int').replace('(a, b) [pk]', '(a, b2) [pk]'));
  }),

  // --- Placeholder ----------------------------------------------------------------
  tableCase('a table left with no columns gets the placeholder', 'fct_order', BARE, (t) => { t.columns = []; }, (out) => {
    expect(out).toBe("Table fct_order {\n  _erd_no_columns unknown [erd_placeholder: 'true', note: 'ERD Studio: this table has no columns yet, and DBML needs one']\n}\n");
    expect(readTable(out, 'fct_order').table.columns).toEqual([]);
  }),
  tableCase('the placeholder goes when a column is added', 'fct_order', renderNewTableDbml({ name: 'fct_order', schema: 'gold', columns: [] }), (t) => {
    t.columns = [{ name: 'id', dataType: 'int', description: '' }];
  }, (out) => {
    expect(out).toBe('Table gold.fct_order {\n  id int\n}\n');
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
  tableCase('a schema-qualified name with an old schema property: requalify replaces the qualifier, the property\'s bytes stay', 'fct_order', "Table gold.fct_order [schema: 'gold'] {\n  id int\n}\n", (t) => {
    t.schema = 'silver';
  }, (out) => {
    expect(out).toBe("Table silver.fct_order [schema: 'gold'] {\n  id int\n}\n");
    const read = readTable(out, 'fct_order');
    expect(read.table.schema).toBe('silver');
    expect(read.problems.map((p) => p.code)).toEqual(['schemaProperty']);
  }, undefined, { requalify: true }),
  tableCase('requalify retargets the Metadata blocks of the file, beside a rename', 'fct_order',
    "Table gold.fct_order {\n  id int\n}\nMetadata Table gold.fct_order {\n  grain: 'g'\n}\nMetadata Column gold.fct_order.id {\n  note: 'the key'\n}\n", (t) => {
      t.schema = 'sales';
      t.name = 'fct_order_line';
    }, (out) => {
      expect(out).toBe("Table sales.fct_order_line {\n  id int\n}\nMetadata Table sales.fct_order_line {\n  grain: 'g'\n}\nMetadata Column sales.fct_order_line.id {\n  note: 'the key'\n}\n");
      const read = readTable(out, 'fct_order_line').table;
      expect(read).toMatchObject({ name: 'fct_order_line', schema: 'sales', grain: 'g' });
      expect(read.columns![0].description).toBe('the key');
    }, undefined, { requalify: true, rename: true }),
  tableCase('requalify of an unqualified table qualifies its unqualified Metadata blocks too', 'fct_order',
    "Table fct_order {\n  id int\n}\nMetadata Table fct_order {\n  grain: 'g'\n}\n", (t) => {
      t.schema = 'gold';
    }, (out) => {
      expect(out).toBe("Table gold.fct_order {\n  id int\n}\nMetadata Table gold.fct_order {\n  grain: 'g'\n}\n");
    }, undefined, { requalify: true }),
  tableCase('the schema the file reads as (its folder, for an unqualified Table) is no change', 'fct_order', BARE, (t) => {
    t.schema = 'gold';
    t.grain = 'g';
  }, (out) => {
    expect(out).toBe(BARE.replace('Table fct_order {', "Table fct_order [grain: 'g'] {"));
  }, undefined, { schemaFolder: 'gold' }),
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
      const created = renderNewTableDbml({ name: 'Order Lines (v2)', schema: 'SAP FI', columns: [{ name: 'id', dataType: 'int', description: '', isPrimaryKey: true }] });
      return { path: 'gold/tables/SAP FI/Order Lines (v2).dbml', input: created, output: edited(created, (t) => { t.grain = 'g'; }, 'Order Lines (v2)') };
    },
    check: (o) => {
      expect(o.output).toBe("Table \"SAP FI\".\"Order Lines (v2)\" [grain: 'g'] {\n  id int [pk]\n}\n");
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
    expect(out).toContain("  design: 'd',\r\n  rationale_measures:");
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

/**
 * Context fields (spec §4, A3–A10): a field is edited in the spelling it was
 * read from, cleared in every spelling of its home (and no other), and a new
 * one is written as a new file writes it.
 */
export const FIELD_CASES: WriterCase[] = [
  // --- Rationale-home fields -------------------------------------------------
  tableCase('a rationale value is spliced in its old spelling (rationale_<key>)', 'fct_order', FCT_ORDER, (t) => {
    t.rationale = { ...t.rationale, purpose: 'Revenue' };
  }, (out) => {
    expect(out).toBe(FCT_ORDER.replace("rationale_purpose: 'Revenue reporting by day, customer and region'", "rationale_purpose: 'Revenue'"));
  }),
  tableCase('…in the bare spelling, leaving a shadowed old one alone', 'fct_order',
    "Table fct_order [purpose: 'a', rationale_purpose: 'old'] {\n  id int\n}\n", (t) => { t.rationale = { purpose: 'b' }; }, (out) => {
      expect(out).toBe("Table fct_order [purpose: 'b', rationale_purpose: 'old'] {\n  id int\n}\n");
    }),
  tableCase('…in an erd_ spelling', 'fct_order', "Table fct_order [erd_rationale_purpose: 'a'] {\n  id int\n}\n", (t) => { t.rationale = { purpose: 'b' }; }, (out) => {
    expect(out).toBe("Table fct_order [erd_rationale_purpose: 'b'] {\n  id int\n}\n");
  }),
  tableCase('…in the Metadata block that sets it (D25)', 'fct_order',
    "Table fct_order [purpose: 'inline'] {\n  id int\n}\nMetadata Table fct_order {\n  purpose: 'block'\n}\n", (t) => { t.rationale = { purpose: 'edited' }; }, (out) => {
      expect(out).toBe("Table fct_order [purpose: 'inline'] {\n  id int\n}\nMetadata Table fct_order {\n  purpose: 'edited'\n}\n");
    }),
  tableCase('…past an empty spelling that comes first (it is skipped on read, so it stays)', 'fct_order',
    "Table fct_order [purpose: '', rationale_purpose: 'r'] {\n  id int\n}\n", (t) => { t.rationale = { purpose: 'r2' }; }, (out) => {
      expect(out).toBe("Table fct_order [purpose: '', rationale_purpose: 'r2'] {\n  id int\n}\n");
    }),
  tableCase('a value for a field held only by empty spellings fills the first of them, never a duplicate', 'fct_order',
    "Table fct_order [rationale_purpose: '', purpose: ''] {\n  id int\n}\n", (t) => { t.rationale = { purpose: 'x' }; }, (out) => {
      expect(out).toBe("Table fct_order [rationale_purpose: '', purpose: 'x'] {\n  id int\n}\n");
    }),
  tableCase('a cleared rationale field loses every spelling, inline and in blocks, but never meta_<key> (another home)', 'fct_order',
    "Table fct_order [purpose: 'b', rationale_purpose: 'r', meta_purpose: 'kept', owner: 'o'] {\n  id int\n}\nMetadata Table fct_order {\n  erd_purpose: 'e'\n  rationale_purpose: 'rb'\n}\n",
    (t) => { delete t.rationale; }, (out) => {
      expect(out).toBe("Table fct_order [meta_purpose: 'kept', owner: 'o'] {\n  id int\n}\nMetadata Table fct_order {\n}\n");
      expect(readTable(out, 'fct_order').table).toMatchObject({ meta: { purpose: 'kept', owner: 'o' } });
      expect(readTable(out, 'fct_order').table.rationale).toBeUndefined();
    }),
  tableCase('a new built-in field is written bare, in catalogue order among the fields', 'fct_order', FCT_ORDER, (t) => {
    t.rationale = { ...t.rationale, decisions: 'Lines, not orders', openQuestions: 'Refunds?', retention: 'Seven years' };
  }, (out) => {
    expect(out).toBe(FCT_ORDER.replace(
      "  rationale_measures: 'amount is additive',\n",
      "  decisions: 'Lines, not orders',\n  open_questions: 'Refunds?',\n  rationale_measures: 'amount is additive',\n  retention: 'Seven years',\n",
    ));
  }),

  // --- Meta-home fields --------------------------------------------------------
  tableCase('a meta value is spliced in the spelling it is read from: bare, rationale_<key>, erd_meta_<key>', 'fct_order',
    "Table fct_order [owner: 'o', meta_owner: 'old', rationale_sla: 's', erd_meta_tier: 't'] {\n  id int [business_rule: 'b']\n}\n", (t) => {
      t.meta = { owner: 'o2', sla: 's2', tier: 't2' };
      t.columns![0].meta = { business_rule: 'b2' };
    }, (out) => {
      expect(out).toBe("Table fct_order [owner: 'o2', meta_owner: 'old', rationale_sla: 's2', erd_meta_tier: 't2'] {\n  id int [business_rule: 'b2']\n}\n");
    }),
  tableCase('text a meta_json entry holds is edited inside meta_json', 'fct_order',
    `Table fct_order [meta_json: '{"owner":"j","pii":true}'] {\n  id int\n}\n`, (t) => { t.meta = { owner: 'k', pii: true }; }, (out) => {
      expect(out).toBe(`Table fct_order [meta_json: '{"owner":"k","pii":true}'] {\n  id int\n}\n`);
    }),
  tableCase('a cleared meta key loses every spelling and its meta_json entry, and nothing resurfaces', 'fct_order',
    `Table fct_order [owner: 'b', meta_owner: 'm', rationale_owner: 'r', meta_json: '{"owner":"j","pii":true}', purpose: 'p'] {\n  id int\n}\nMetadata Table fct_order {\n  erd_owner: 'e'\n}\n`,
    (t) => { t.meta = { pii: true }; }, (out) => {
      expect(out).toBe(`Table fct_order [meta_json: '{"pii":true}', purpose: 'p'] {\n  id int\n}\nMetadata Table fct_order {\n}\n`);
      expect(readTable(out, 'fct_order').table).toMatchObject({ meta: { pii: true }, rationale: { purpose: 'p' } });
    }),
  tableCase('a new text entry under a reserved name or a built-in kept elsewhere is meta_<key>, never bare', 'fct_order', BARE, (t) => {
    t.meta = { note: 'n', role: 'r', purpose: 'p', grain: 'g', dbml: 'd', alias: 'a' };
  }, (out) => {
    expect(out).toBe(BARE.replace('Table fct_order {',
      "Table fct_order [\n  meta_note: 'n',\n  meta_role: 'r',\n  meta_purpose: 'p',\n  meta_grain: 'g',\n  meta_dbml: 'd',\n  meta_alias: 'a'\n] {"));
    const read = readTable(out, 'fct_order').table;
    expect(read.meta).toEqual({ note: 'n', role: 'r', purpose: 'p', grain: 'g', dbml: 'd', alias: 'a' });
    expect([read.description, read.modelRole, read.grain, read.alias, read.rationale]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  }),
  tableCase('the parser-unsafe names constructor and __proto__ are meta_ spellings', 'fct_order', BARE, (t) => {
    const meta = {} as NonNullable<SemanticTable['meta']>;
    Object.defineProperty(meta, '__proto__', { value: 'p', enumerable: true, writable: true, configurable: true });
    meta.constructor = 'c' as never;
    t.meta = meta;
    t.columns![0].meta = { constructor: 'cc' } as never;
  }, (out) => {
    expect(out).toBe("Table fct_order [\n  meta___proto__: 'p',\n  meta_constructor: 'c'\n] {\n  id int [pk, meta_constructor: 'cc']\n  amount int\n}\n");
    const read = readTable(out, 'fct_order').table;
    expect(Object.getOwnPropertyDescriptor(read.meta!, '__proto__')?.value).toBe('p');
    expect(read.columns![0].meta!.constructor).toBe('cc');
  }),
  tableCase('a key that is not an identifier, or json, goes into meta_json', 'fct_order', BARE, (t) => {
    t.meta = { 'Odd Key': 'x', json: 'j', '1st': 'f' };
  }, (out) => {
    expect(out).toBe(BARE.replace('Table fct_order {', `Table fct_order [meta_json: '{"Odd Key":"x","json":"j","1st":"f"}'] {`));
  }),
  tableCase('a column\'s fields are bare after its ERD Studio flags and before its note (business_rule, a column purpose)', 'fct_order', BARE, (t) => {
    t.columns![1] = { ...t.columns![1], description: 'Total', additiveType: 'additive', meta: { business_rule: 'Sum of lines', purpose: 'p' } };
  }, (out) => {
    expect(out).toBe(BARE.replace('  amount int\n', "  amount int [additive_type: 'additive', business_rule: 'Sum of lines', purpose: 'p', note: 'Total']\n"));
  }),
  // A9: a key added between two the file holds, and a value turning into a list.
  tableCase('an entry added between two bare ones rewrites the owner\'s meta in key order', 'fct_order',
    "Table fct_order [owner: 'a', team: 'b'] {\n  id int\n}\n", (t) => { t.meta = { owner: 'a', n: 1 as never, team: 'b' }; }, (out) => {
      expect(out).toBe("Table fct_order [owner: 'a', n: '1', team: 'b'] {\n  id int\n}\n");
      expect(Object.keys(readTable(out, 'fct_order').table.meta!)).toEqual(['owner', 'n', 'team']);
    }),
  tableCase('a bare text value that becomes a list moves into meta_json, in its place', 'fct_order',
    "Table fct_order [owner: 'a', team: 'b'] {\n  id int\n}\n", (t) => { t.meta = { owner: 'a', team: ['x'] }; }, (out) => {
      expect(out).toBe(`Table fct_order [owner: 'a', meta_json: '{"team":["x"]}'] {\n  id int\n}\n`);
    }),
  tableCase('a meta_json value that becomes text is written as a new file writes it, in its place', 'fct_order',
    `Table fct_order [meta_json: '{"pii":true}', owner: 'o'] {\n  id int\n}\n`, (t) => { t.meta = { pii: 'yes', owner: 'o' }; }, (out) => {
      expect(out).toBe("Table fct_order [pii: 'yes', owner: 'o'] {\n  id int\n}\n");
    }),
  tableCase('the key-order rewrite takes every meta spelling of the owner, block entries too, and no other setting', 'fct_order',
    "Table fct_order [owner: 'a', purpose: 'p', color: 'c'] {\n  id int\n}\nMetadata Table fct_order {\n  team: 'b'\n}\n", (t) => {
      t.meta = { flag: true, owner: 'a', team: 'b' };
    }, (out) => {
      expect(out).toBe(`Table fct_order [purpose: 'p', color: 'c', meta_json: '{"flag":true}', owner: 'a', team: 'b'] {\n  id int\n}\nMetadata Table fct_order {\n}\n`);
      expect(Object.keys(readTable(out, 'fct_order').table.meta!)).toEqual(['flag', 'owner', 'team']);
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

/** A table with every rationale-home field (given out of order) and meta that shadows built-ins. */
const FIELDS_TABLE: SemanticTable = {
  name: 'dim_store',
  schema: 'gold',
  modelRole: 'conformed-dim',
  rationale: {
    retention: 'r', measures: 'm', purpose: 'p', knownIssues: 'k', design: 'old design', decisions: 'd', freshness: 'daily',
    grainChoice: 'gc', openQuestions: 'q', roleChoice: 'rc', scdStrategy: 's', sourceOfTruth: 'POS',
  },
  meta: { owner: 'ops', purpose: 'shadow', note: 'n', pii: true, business_rule: 'a team field on a table' },
  columns: [{ name: 'code', dataType: 'VARCHAR', description: '', isNaturalKey: true, meta: { business_rule: 'Till prefix', purpose: 'col', role: 'r' } }],
};

/** New-file cases: `renderNewTableDbml` and its read-back. */
export const NEW_TABLE_CASES: WriterCase[] = [
  {
    name: 'a new table reads back as the table it was given',
    run: () => ({ path: 'silver/tables/silver/dim_customer.dbml', input: null, output: renderNewTableDbml(READ_BACK_TABLE) }),
    check: (o) => { expect(readTable(o.output, 'dim_customer').table).toEqual(READ_BACK_TABLE); },
  },
  {
    name: 'a new table follows the §2.2 layout',
    run: () => ({
      path: 'gold/tables/gold/fct_order.dbml',
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
      expect(o.output).toBe(`Table gold.fct_order [
  role: 'transaction-fact',
  grain: 'One row per order line',
  purpose: 'Revenue',
  measures: 'amount is additive',
  owner: 'sales-data',
  meta_json: '{"pii":false}'
] {
  Note: 'Order lines'

  id BIGINT [pk, natural_key: 'true', scd_type: '0', note: 'Line id']
  amount "DECIMAL(18,2)" [additive_type: 'additive', foreign_key: 'true', unit: 'AUD']
}
`);
    },
  },
  {
    // Context fields (A10): every rationale-home field bare in RATIONALE_FIELD_KEYS order; meta bare,
    // meta_<key> for a reserved name or a built-in kept elsewhere, meta_json for the rest.
    name: 'a new table writes every field bare, in catalogue order, and keeps meta that shadows a built-in as meta_<key>',
    run: () => ({ path: 'gold/tables/gold/dim_store.dbml', input: null, output: renderNewTableDbml(FIELDS_TABLE) }),
    check: (o) => {
      expect(o.output).toBe(`Table gold.dim_store [
  role: 'conformed-dim',
  purpose: 'p',
  decisions: 'd',
  open_questions: 'q',
  design: 'old design',
  grain_choice: 'gc',
  role_choice: 'rc',
  scd_strategy: 's',
  measures: 'm',
  source_of_truth: 'POS',
  freshness: 'daily',
  known_issues: 'k',
  retention: 'r',
  owner: 'ops',
  meta_purpose: 'shadow',
  meta_note: 'n',
  meta_json: '{"pii":true}',
  business_rule: 'a team field on a table'
] {
  code VARCHAR [natural_key: 'true', business_rule: 'Till prefix', purpose: 'col', meta_role: 'r']
}
`);
      const read = readTable(o.output, 'dim_store');
      expect(read.table).toEqual(FIELDS_TABLE);
      expect(read.fieldSpellings!.filter((f) => f.old)).toEqual([]);
    },
  },
  {
    name: 'a new table with a composite key writes an indexes block',
    run: () => ({
      path: 'gold/tables/gold/sat.dbml',
      input: null,
      output: renderNewTableDbml({ name: 'sat', schema: 'gold', columns: [
        { name: 'hk', dataType: 'binary', description: '', isPrimaryKey: true },
        { name: 'load_date', dataType: 'timestamp', description: '', isPrimaryKey: true },
      ] }),
    }),
    check: (o) => {
      expect(o.output).toBe('Table gold.sat {\n  hk binary\n  load_date timestamp\n  indexes {\n    (hk, load_date) [pk]\n  }\n}\n');
    },
  },
  {
    // Stress round 1: `{ owner: 'x', contains_pii: true }` read back as `{ contains_pii, owner }`.
    name: 'a new table keeps its meta in key order (meta_json where its first entry is)',
    run: () => ({
      path: 'gold/tables/gold/dim_employee.dbml',
      input: null,
      output: renderNewTableDbml({
        name: 'dim_employee',
        schema: 'gold',
        meta: { owner: 'people', contains_pii: true, exposure: 'crm' },
        columns: [{ name: 'id', dataType: 'int', description: '', meta: { a: 'x', b: true, c: 'y', d: ['p', 'q'], e: 'z' } }],
      }),
    }),
    check: (o) => {
      expect(o.output).toBe(
        "Table gold.dim_employee [\n  owner: 'people',\n  meta_json: '{\"contains_pii\":true}',\n  exposure: 'crm'\n] {\n" +
          "  id int [a: 'x', meta_json: '{\"b\":true,\"c\":\"y\",\"d\":[\"p\",\"q\"]}', e: 'z']\n}\n",
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
      name: 'fct_m', schema: 'gold', meta: meta as SemanticTable['meta'],
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
        input({ owner: 'p' }, { a: 'x', b: true, c: 'y' }), (t) => { t.columns![0].meta = { a: 'x', b: true, c: 'y', d: ['1'] }; }, (out) => {
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
