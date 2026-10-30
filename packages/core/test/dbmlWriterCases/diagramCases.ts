/**
 * The diagram writer cases (§9.3 `dbmlWriteDiagram`): each one edits (or
 * creates) `gold/sales.dbml` against a small library and checks the text.
 * `dbmlWriteDiagram.test.ts` runs the checks; `dbmlMultiParser.test.ts`
 * compiles every output again, with the files its `use` lines name, under
 * 9.1.1, 10.3.1 and 11.0.0. Not a test file.
 */
import { expect } from 'vitest';

import { parseSubjectAreaDbml } from '../../src/dbml/readDiagram';
import { editSubjectAreaDbml, renderNewSubjectAreaDbml, type SubjectAreaDbmlEdit } from '../../src/dbml/writeDiagram';
import { relationshipsFilePathOf } from '../../src/storage';
import { detectSubjectAreaFormat } from '../../src/types/semantic';
import { clone, diagramResolver, libraryOf, type WriterCase, type WriterOutcome } from '../dbmlWriterSupport';
import { LIBRARY } from './relationshipsCases';

export const DIAGRAM_PATH = 'gold/sales.dbml';

/** The library plus its two relationships files. */
export const DIAGRAM_LIBRARY: Readonly<Record<string, string>> = {
  ...LIBRARY,
  'tables/gold/_relationships.dbml': `use { table gold.dim_customer } from './dim_customer.dbml'
use { table fct_order } from './fct_order.dbml'

Ref: fct_order.Customer_Key >? gold.dim_customer.customer_key
`,
  'tables/_relationships.dbml': '// ERD Studio relationships.\n',
};

export const SALES = `// The sales star.

Project sales {
  Note: 'Sales star schema'
  erd_schema_version: '7'
  database_type: 'Snowflake'
}

use { table fct_order } from '../tables/gold/fct_order.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use * from '../tables/gold/_relationships.dbml'

Note "3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c" [color: #f59e0b, linked_table: 'fct_order'] {
  'Check the grain with finance'
}
`;

/** An erd_layout value git left two versions of (markers at the start of their lines). */
const CONFLICTED_LAYOUT = "  erd_layout: '''\n<<<<<<< HEAD\n    dim_customer 1 2\n=======\n    dim_customer 5 6\n>>>>>>> theirs\n  '''\n";

/** SALES whose erd_layout holds a git merge conflict. */
export const SALES_CONFLICTED = SALES.replace("  database_type: 'Snowflake'\n", `  database_type: 'Snowflake'\n${CONFLICTED_LAYOUT}`);

/** SALES as a new diagram is written: the Project last, erd_layout its last key (§1.4). */
export const SALES_LAST = `// The sales star.

use { table fct_order } from '../tables/gold/fct_order.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use * from '../tables/gold/_relationships.dbml'

Note "3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c" [color: #f59e0b, linked_table: 'fct_order'] {
  'Check the grain with finance'
}

Project sales {
  Note: 'Sales star schema'
  erd_schema_version: '7'
  erd_layout: '''
    dim_customer 40 60
    fct_order 400 200
    note/3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c 720 40
  '''
}
`;

/** SALES with a member that has no table file and its pending relationship (D26/D27). */
export const SALES_MISSING = SALES
  .replace("  database_type: 'Snowflake'\n", "  database_type: 'Snowflake'\n  erd_unlinked_tables: 'gld_fct_risk_child'\n")
  .concat('\n// erd-studio pending: Ref: gld_fct_risk_child.customer_key >? gold.dim_customer.customer_key\n');

/** SALES_MISSING with dim_date unlinked too, though it has a table file now. */
export const SALES_UNLINKED = SALES_MISSING.replace("erd_unlinked_tables: 'gld_fct_risk_child'", "erd_unlinked_tables: 'gld_fct_risk_child, dim_date'");

/** The library with \`dim_customer\` renamed to \`dim_client\` (its relationships file following). */
const CLIENT_LIBRARY: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = { ...DIAGRAM_LIBRARY };
  delete out['tables/gold/dim_customer.dbml'];
  out['tables/gold/dim_client.dbml'] = DIAGRAM_LIBRARY['tables/gold/dim_customer.dbml'].replace('gold.dim_customer', 'gold.dim_client');
  out['tables/gold/_relationships.dbml'] = DIAGRAM_LIBRARY['tables/gold/_relationships.dbml'].replace(/dim_customer/g, 'dim_client');
  return out;
})();

/** The library with dim_customer's \`customer_key\` renamed to \`customer_id\` (its relationships file following). */
const CUSTOMER_ID_LIBRARY: Readonly<Record<string, string>> = {
  ...DIAGRAM_LIBRARY,
  'tables/gold/dim_customer.dbml': DIAGRAM_LIBRARY['tables/gold/dim_customer.dbml'].replace('customer_key int [pk]', 'customer_id int [pk]'),
  'tables/gold/_relationships.dbml': DIAGRAM_LIBRARY['tables/gold/_relationships.dbml'].replace('gold.dim_customer.customer_key', 'gold.dim_customer.customer_id'),
};

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Read `text` as the diagram at `path`. */
export function readDiagram(text: string, path = DIAGRAM_PATH): Obj {
  return parseSubjectAreaDbml(text, path).obj;
}

/** The edit's lookups over `library`. */
export function lookups(library: Readonly<Record<string, string>>, yaml: Record<string, string> = {}): Pick<SubjectAreaDbmlEdit, 'resolveTable' | 'relationshipsFilesFor' | 'fileExists'> {
  const resolveTable = diagramResolver(libraryOf(library, yaml));
  return {
    resolveTable,
    relationshipsFilesFor: (names) => names
      .map((n) => resolveTable(n))
      .filter((t): t is NonNullable<typeof t> => t !== undefined && t.storage === 'dbml')
      .map((t) => relationshipsFilePathOf(t.path)),
    fileExists: (p) => Object.prototype.hasOwnProperty.call(library, p),
  };
}

/** Read `text`, change a copy of its object, and write it back. */
export function diagramEdit(
  text: string,
  change: (after: Obj) => void,
  options: { library?: Readonly<Record<string, string>>; yaml?: Record<string, string>; extra?: Partial<SubjectAreaDbmlEdit>; path?: string } = {},
): string {
  const path = options.path ?? DIAGRAM_PATH;
  const before = readDiagram(text, path);
  const after = clone(before);
  change(after);
  return editSubjectAreaDbml(text, { filePath: path, before, after, ...lookups(options.library ?? DIAGRAM_LIBRARY, options.yaml), ...options.extra });
}

/** The Law 2/3 edit: a rename, a description, a member change, a flag and Notes edited and added. */
function lawChange(a: Obj): void {
  a.domain = 'sales_v2';
  a.description = '  Indented first line is dropped';
  a.logical.models = ['dim_date', 'fct_order'];
  a.viewConfig.showFkEdges = true;
  a.viewConfig.annotations[0].text = 'edited';
  a.viewConfig.annotations.push({ id: 'n2', text: 'two', x: 0, y: 0, linkedModel: 'dim_date' });
}

function diagramCase(
  name: string,
  text: string,
  change: (after: Obj) => void,
  check: (output: string) => void,
  options: Parameters<typeof diagramEdit>[2] & { parsers?: readonly string[] } = {},
): WriterCase {
  return {
    name,
    run: (): WriterOutcome => ({
      path: options.path ?? DIAGRAM_PATH,
      input: text,
      output: diagramEdit(text, change, options),
      context: { ...(options.library ?? DIAGRAM_LIBRARY) },
      ...(options.parsers ? { parsers: options.parsers } : {}),
    }),
    check: (o) => check(o.output),
  };
}

export const DIAGRAM_CASES: WriterCase[] = [
  diagramCase('a no-op is byte-identical', SALES, () => undefined, (out) => { expect(out).toBe(SALES); }),

  // --- Project ------------------------------------------------------------------
  diagramCase('the description is the Project Note, spliced', SALES, (a) => { a.description = 'Revenue star'; }, (out) => {
    expect(out).toBe(SALES.replace("Note: 'Sales star schema'", "Note: 'Revenue star'"));
  }),
  diagramCase('an empty description removes the Project Note', SALES, (a) => { a.description = ''; }, (out) => {
    expect(out).toBe(SALES.replace("  Note: 'Sales star schema'\n", ''));
  }),
  diagramCase('a new key goes in after the last known key before it; unknown keys are kept', SALES, (a) => {
    a.viewConfig.showFkEdges = false;
    a.viewConfig.layoutOptions = { 'elk.direction': 'RIGHT' };
    a.modelFolder = 'models/gold';
    a.stubColumns = ['customer_key'];
  }, (out) => {
    expect(out).toBe(SALES.replace("  erd_schema_version: '7'\n", `  erd_schema_version: '7'
  erd_model_folder: 'models/gold'
  erd_show_fk_edges: 'false'
  erd_layout_options: '{"elk.direction":"RIGHT"}'
  erd_stub_columns: '["customer_key"]'
`));
    const read = readDiagram(out);
    expect(read.viewConfig.showFkEdges).toBe(false);
    expect(read.viewConfig.layoutOptions).toEqual({ 'elk.direction': 'RIGHT' });
    expect(read.modelFolder).toBe('models/gold');
    expect(read.stubColumns).toEqual(['customer_key']);
  }),
  diagramCase('a key removed loses its line', SALES.replace("  erd_schema_version: '7'\n", "  erd_schema_version: '7'\n  erd_show_fk_edges: 'true'\n"), (a) => {
    delete a.viewConfig.showFkEdges;
  }, (out) => {
    expect(out).toBe(SALES);
  }),
  diagramCase('a diagram rename (after.domain) splices the Project name', SALES, (a) => { a.domain = 'sales v2'; }, (out) => {
    expect(out).toBe(SALES.replace('Project sales {', 'Project "sales v2" {'));
  }),
  diagramCase('a diagram with no Project gets one at the end, after a blank line (§1.4, Project last)',
    "// The sales star.\n\nuse { table fct_order } from '../tables/gold/fct_order.dbml'\n", (a) => { a.description = 'Sales'; }, (out) => {
      expect(out).toBe("// The sales star.\n\nuse { table fct_order } from '../tables/gold/fct_order.dbml'\n\nProject sales {\n  Note: 'Sales'\n  erd_schema_version: '7'\n}\n");
    }),
  diagramCase('…and a comment that runs straight into the first line stays with it',
    "// about fct_order\nuse { table fct_order } from '../tables/gold/fct_order.dbml'\n", (a) => { a.domain = 'renamed'; }, (out) => {
      expect(out).toBe("// about fct_order\nuse { table fct_order } from '../tables/gold/fct_order.dbml'\n\nProject renamed {\n  erd_schema_version: '7'\n}\n");
    }),
  diagramCase('…holding erd_layout last when a position changed too',
    "use { table fct_order } from '../tables/gold/fct_order.dbml'\n", (a) => { a.domain = 'renamed'; a.viewConfig.positions = { fct_order: { x: 1.006, y: -0 } }; }, (out) => {
      expect(out).toBe("use { table fct_order } from '../tables/gold/fct_order.dbml'\n\nProject renamed {\n  erd_schema_version: '7'\n  erd_layout: '''\n    fct_order 1.01 0\n  '''\n}\n");
    }),

  // --- Members --------------------------------------------------------------------
  diagramCase('a member added goes after the last table use line, with its folder\'s relationships file', SALES, (a) => {
    a.logical.models.push('dim_date');
  }, (out) => {
    expect(out).toBe(SALES.replace(
      "use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse * from '../tables/gold/_relationships.dbml'\n",
      "use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse { table dim_date } from '../tables/dim_date.dbml'\nuse * from '../tables/_relationships.dbml'\nuse * from '../tables/gold/_relationships.dbml'\n",
    ));
  }),
  diagramCase('a member added in the middle goes before the next member\'s line', SALES, (a) => {
    a.logical.models.splice(1, 0, 'dim_region');
  }, (out) => {
    expect(out).toContain("use { table fct_order } from '../tables/gold/fct_order.dbml'\nuse { table dim_region } from '../tables/gold/dim_region.dbml'\nuse { table gold.dim_customer }");
    expect(readDiagram(out).logical.models).toEqual(['fct_order', 'dim_region', 'dim_customer']);
  }),
  diagramCase('a member removed is cut; a relationships file no member needs goes', SALES, (a) => {
    a.logical.models = ['dim_date'];
  }, (out) => {
    expect(out).toContain("use { table dim_date } from '../tables/dim_date.dbml'\nuse * from '../tables/_relationships.dbml'\n\nNote");
    expect(out).not.toContain('gold/_relationships');
    expect(out).not.toContain('fct_order.dbml');
  }),
  diagramCase('a new member order rebuilds the table use lines', SALES, (a) => {
    a.logical.models.reverse();
  }, (out) => {
    expect(out).toContain("use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse { table fct_order } from '../tables/gold/fct_order.dbml'\nuse * from");
  }),
  diagramCase('a new member order keeps each line\'s trailing comment and the comment lines above', SALES
    .replace("'../tables/gold/fct_order.dbml'", "'../tables/gold/fct_order.dbml' // the facts")
    .replace("use { table gold.dim_customer }", "// customers\nuse { table gold.dim_customer }"), (a) => {
    a.logical.models.reverse();
  }, (out) => {
    expect(out).toContain("// customers\nuse { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse { table fct_order } from '../tables/gold/fct_order.dbml' // the facts\nuse * from");
  }),
  diagramCase('a member whose table was deleted (pathChanged, no file now) loses its line, even with nothing else changed', SALES, () => undefined, (out) => {
    expect(out).toBe(SALES.replace("use { table fct_order } from '../tables/gold/fct_order.dbml'\n", ''));
  }, {
    library: (() => {
      const lib: Record<string, string> = { ...DIAGRAM_LIBRARY };
      delete lib['tables/gold/fct_order.dbml'];
      lib['tables/gold/_relationships.dbml'] = "use { table gold.dim_customer } from './dim_customer.dbml'\n";
      return lib;
    })(),
    extra: { pathChanged: new Set(['fct_order']) },
    // The input compiled clean against the library before the delete.
    parsers: ['9.1.1', '10.3.1', '11.0.0'],
  }),
  diagramCase('a member whose table moved is rewritten (pathChanged)', SALES, () => undefined, (out) => {
    expect(out).toBe(SALES.replace("use { table fct_order } from '../tables/gold/fct_order.dbml'", "use { table fct_order } from '../tables/fct_order.dbml'"));
  }, {
    library: (() => {
      const lib: Record<string, string> = { ...DIAGRAM_LIBRARY, 'tables/fct_order.dbml': LIBRARY['tables/gold/fct_order.dbml'] };
      delete lib['tables/gold/fct_order.dbml'];
      lib['tables/gold/_relationships.dbml'] = lib['tables/gold/_relationships.dbml'].replace("'./fct_order.dbml'", "'../fct_order.dbml'");
      return lib;
    })(),
    extra: { pathChanged: new Set(['fct_order']) },
    // The input compiled clean against the library before the move.
    parsers: ['9.1.1', '10.3.1', '11.0.0'],
  }),
  diagramCase('a member renamed with its table (pathChanged) gets its new line where the old one was', SALES, (a) => {
    a.logical.models[0] = 'fct_order_line';
  }, (out) => {
    expect(out).toBe(SALES.replace("use { table fct_order } from '../tables/gold/fct_order.dbml'", "use { table fct_order_line } from '../tables/gold/fct_order_line.dbml'"));
  }, {
    library: (() => {
      const lib: Record<string, string> = { ...DIAGRAM_LIBRARY, 'tables/gold/fct_order_line.dbml': LIBRARY['tables/gold/fct_order.dbml'].replace('Table fct_order', 'Table fct_order_line') };
      delete lib['tables/gold/fct_order.dbml'];
      lib['tables/gold/_relationships.dbml'] = lib['tables/gold/_relationships.dbml'].replace(/fct_order/g, 'fct_order_line');
      return lib;
    })(),
    extra: { pathChanged: new Set(['fct_order']) },
    // The input compiled clean against the library before the move.
    parsers: ['9.1.1', '10.3.1', '11.0.0'],
  }),
  diagramCase('a stale path is rewritten on an edit; a path whose file exists is never repointed', `Project sales {
  erd_schema_version: '7'
}

use { table fct_order } from '../tables/old/fct_order.dbml'
use { table dim_date } from '../tables/dim_date.dbml'
`, (a) => { a.description = 'x'; }, (out) => {
    expect(out).toContain("use { table fct_order } from '../tables/gold/fct_order.dbml'\n");
    // dim_date resolves to another copy (tables/gold/dim_date.dbml) first, but its line's target exists: kept.
    expect(out).toContain("use { table dim_date } from '../tables/dim_date.dbml'\n");
  }, {
    library: { ...DIAGRAM_LIBRARY, 'tables/gold/dim_date.dbml': 'Table dim_date {\n  date_key int [pk]\n}\n' },
  }),
  diagramCase('an existing member that resolves to a YAML table keeps its line bytes (D20)', `Project sales {
  erd_schema_version: '7'
}

use { table yml_t } from '../tables/yml_t.dbml'
use { table fct_order } from '../tables/gold/fct_order.dbml'
`, (a) => { a.description = 'x'; }, (out) => {
    expect(out).toContain("use { table yml_t } from '../tables/yml_t.dbml'\n");
  }, { yaml: { yml_t: 'logical-models/yml_t.yml' } }),

  // --- Relationships use lines ----------------------------------------------------------
  diagramCase('relationships use lines are left alone when membership does not change', SALES.replace("use * from '../tables/gold/_relationships.dbml'\n", ''), (a) => {
    a.description = 'x';
  }, (out) => {
    expect(out).not.toContain('_relationships');
  }),
  {
    name: '…and recomputed by the settle pass (refreshRelationshipsUses) with no other change',
    run: (): WriterOutcome => ({
      path: DIAGRAM_PATH,
      input: SALES.replace("use * from '../tables/gold/_relationships.dbml'\n", ''),
      output: diagramEdit(SALES.replace("use * from '../tables/gold/_relationships.dbml'\n", ''), () => undefined, { extra: { refreshRelationshipsUses: true } }),
      context: { ...DIAGRAM_LIBRARY },
    }),
    check: (o) => {
      expect(o.output).toBe(SALES);
    },
  },

  // --- erd_layout (§1.6) and the Project-last order (§1.4) ----------------------------------
  diagramCase('a position change writes erd_layout as the Project\'s last key, every other byte kept', SALES, (a) => {
    a.viewConfig.positions = { fct_order: { x: 10.123, y: 20 }, dim_customer: { x: -5, y: 1e3 } };
  }, (out) => {
    expect(out).toBe(SALES.replace("  database_type: 'Snowflake'\n", `  database_type: 'Snowflake'
  erd_layout: '''
    dim_customer -5 1000
    fct_order 10.12 20
    note/3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c 0 0
  '''
`));
  }),
  diagramCase('an existing erd_layout is rewritten in place; a key added goes above it, and a member removed loses its line',
    SALES.replace("  database_type: 'Snowflake'\n", "  database_type: 'Snowflake'\n  erd_layout: '''\n    dim_customer 1 2\n    fct_order 3 4\n  '''\n"), (a) => {
      a.logical.models = ['dim_customer'];
      delete a.viewConfig.positions.fct_order;
      a.viewConfig.showFkEdges = true;
    }, (out) => {
      expect(out).toContain("  erd_schema_version: '7'\n  erd_show_fk_edges: 'true'\n  database_type: 'Snowflake'\n  erd_layout: '''\n    dim_customer 1 2\n    note/3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c 323 2\n  '''\n}");
      expect(out).not.toContain('fct_order 3 4');
      expect(readDiagram(out).viewConfig.positions).toEqual({ dim_customer: { x: 1, y: 2 } });
    }),
  diagramCase('a position change keeps a member\'s spelling and drops its case variant',
    SALES.replace("  database_type: 'Snowflake'\n", "  database_type: 'Snowflake'\n  erd_layout: '''\n    DIM_CUSTOMER 1 2\n    gone 5 6\n  '''\n"), (a) => {
      a.viewConfig.positions.dim_customer = { x: 7, y: 8 };
    }, (out) => {
      expect(out).toContain("  erd_layout: '''\n    dim_customer 7 8\n    gone 5 6\n");
      expect(out).not.toContain('DIM_CUSTOMER');
    }),
  diagramCase('an edit that moves nothing leaves a conflicted erd_layout as it is and still writes', SALES_CONFLICTED, (a) => {
    a.description = 'Revenue star';
  }, (out) => {
    expect(out).toBe(SALES_CONFLICTED.replace("Note: 'Sales star schema'", "Note: 'Revenue star'"));
  }),
  diagramCase('keepLayoutIfConflicted: a conflicted erd_layout stays byte-identical while a member\'s use line goes', SALES_CONFLICTED, (a) => {
    a.logical.models = ['fct_order'];
    delete a.viewConfig.positions.dim_customer;
  }, (out) => {
    expect(out).not.toContain('gold.dim_customer } from');
    expect(out).toContain(CONFLICTED_LAYOUT);
  }, { extra: { keepLayoutIfConflicted: true } }),
  diagramCase('a Project-last diagram: a member\'s use line goes after the last use line, a new note before the Project', SALES_LAST, (a) => {
    a.logical.models.push('dim_date');
    a.viewConfig.annotations.push({ id: 'n2', text: 'two', x: 5, y: 6 });
  }, (out) => {
    expect(out).toContain("use { table dim_date } from '../tables/dim_date.dbml'\nuse * from '../tables/_relationships.dbml'\nuse * from '../tables/gold/_relationships.dbml'\n");
    expect(out).toContain("Note n2 {\n  'two'\n}\n\nProject sales {");
    expect(out.trimEnd().endsWith('}')).toBe(true);
    expect(out.indexOf('Project sales')).toBeGreaterThan(out.indexOf('Note n2'));
    expect(out).toContain('    note/n2 5 6\n');
  }),
  diagramCase('a diagram with no use line gets its first ones before the first Note, else before the Project',
    "Project sales {\n  erd_schema_version: '7'\n}\n", (a) => { a.logical.models = ['fct_order']; }, (out) => {
      expect(out).toBe("use { table fct_order } from '../tables/gold/fct_order.dbml'\nuse * from '../tables/gold/_relationships.dbml'\n\nProject sales {\n  erd_schema_version: '7'\n}\n");
    }),

  // --- Notes ---------------------------------------------------------------------------------
  diagramCase('a sticky note added is a Note block at the end, and its box goes in erd_layout', SALES, (a) => {
    a.viewConfig.annotations.push({ id: '9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f', text: '', x: 1, y: 2, color: 'blue' });
  }, (out) => {
    expect(out).toBe(`${SALES.replace("  database_type: 'Snowflake'\n", `  database_type: 'Snowflake'
  erd_layout: '''
    note/3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c 0 0
    note/9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f 1 2
  '''
`)}\nNote "9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f" [color: #3b82f6] {\n  ''\n}\n`);
  }),
  diagramCase('a sticky note\'s text, colour and link are spliced', SALES, (a) => {
    const note = a.viewConfig.annotations[0];
    note.text = "It's checked\nline two";
    note.color = 'green';
    delete note.linkedModel;
  }, (out) => {
    expect(out).toBe(SALES.replace(
      "[color: #f59e0b, linked_table: 'fct_order'] {\n  'Check the grain with finance'",
      "[color: #22c55e] {\n  '''It\\'s checked\nline two'''",
    ));
    expect(readDiagram(out).viewConfig.annotations[0]).toMatchObject({ text: "It's checked\nline two", color: 'green' });
  }),
  diagramCase('a sticky note removed is cut', SALES, (a) => { a.viewConfig.annotations = []; }, (out) => {
    // The cut rule takes the Note's lines; the blank line above it stays.
    expect(out).toBe(SALES.replace(/Note "3f2b[^]*$/, ''));
  }),
  {
    name: 'reads back as the object it was given (Law 3) and is idempotent (Law 2)',
    run: (): WriterOutcome => ({ path: DIAGRAM_PATH, input: SALES, output: diagramEdit(SALES, lawChange), context: { ...DIAGRAM_LIBRARY } }),
    check: (o) => {
      const after = clone(readDiagram(SALES));
      lawChange(after);
      expect(editSubjectAreaDbml(o.output, { filePath: DIAGRAM_PATH, before: readDiagram(o.output), after, ...lookups(DIAGRAM_LIBRARY) })).toBe(o.output);
      const read = readDiagram(o.output);
      expect(read.domain).toBe('sales_v2');
      expect(read.description).toBe('Indented first line is dropped');
      expect(read.logical.models).toEqual(['dim_date', 'fct_order']);
      expect(read.viewConfig.showFkEdges).toBe(true);
      expect(read.viewConfig.annotations.map((n: { id: string; text: string }) => [n.id, n.text])).toEqual([
        ['3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c', 'edited'], ['n2', 'two'],
      ]);
      expect(detectSubjectAreaFormat(read)).toBe('v5');
    },
  },
  {
    name: 'a byte-order mark and CRLF line endings are kept',
    run: (): WriterOutcome => {
      const crlf = `﻿${SALES.replace(/\n/g, '\r\n')}`;
      return { path: DIAGRAM_PATH, input: crlf, output: diagramEdit(crlf, (a) => { a.logical.models.push('dim_date'); a.description = 'x'; }), context: { ...DIAGRAM_LIBRARY } };
    },
    check: (o) => {
      expect(o.output.startsWith('﻿')).toBe(true);
      expect(o.output.replace(/\r\n/g, '')).not.toContain('\n');
      expect(o.output).toContain("use { table dim_date } from '../tables/dim_date.dbml'\r\n");
    },
  },

  // --- Members with no table file (D26) and pending relationships (D27) ----------------------
  diagramCase('a no-op keeps erd_unlinked_tables and the pending lines byte for byte', SALES_UNLINKED, () => undefined, (out) => { expect(out).toBe(SALES_UNLINKED); }),
  diagramCase('an edit keeps an unlinked member that still has no file, and its pending line', SALES_MISSING, (a) => { a.description = 'Revenue star'; }, (out) => {
    expect(out).toBe(SALES_MISSING.replace("Note: 'Sales star schema'", "Note: 'Revenue star'"));
  }),
  diagramCase('an unlinked member whose table now has a .dbml file gains a use line on any edit that changes something', SALES_UNLINKED, (a) => { a.description = 'Revenue star'; }, (out) => {
    expect(out).toBe(SALES_UNLINKED
      .replace("Note: 'Sales star schema'", "Note: 'Revenue star'")
      .replace("erd_unlinked_tables: 'gld_fct_risk_child, dim_date'", "erd_unlinked_tables: 'gld_fct_risk_child'")
      .replace("use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\n", "use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse { table dim_date } from '../tables/dim_date.dbml'\n")
      .replace("use * from '../tables/gold/_relationships.dbml'\n", "use * from '../tables/_relationships.dbml'\nuse * from '../tables/gold/_relationships.dbml'\n"));
    expect(readDiagram(out).logical.models).toEqual(['fct_order', 'dim_customer', 'dim_date', 'gld_fct_risk_child']);
  }),
  diagramCase('removing the last unlinked member drops the key (never written empty), and its pending line goes with its relationship', SALES_MISSING, (a) => {
    a.logical.models = a.logical.models.filter((m: string) => m !== 'gld_fct_risk_child');
    a.logical.relationships = [];
  }, (out) => {
    expect(out).toBe(SALES_MISSING
      .replace("  erd_unlinked_tables: 'gld_fct_risk_child'\n", '')
      .replace('\n// erd-studio pending: Ref: gld_fct_risk_child.customer_key >? gold.dim_customer.customer_key\n', ''));
    expect(out).not.toContain('erd_unlinked_tables');
  }),
  // A rename the provider makes runs renameTableInSubjectAreaRelationships on the diagram: its own pending
  // relationship follows, and its line is re-spelled (never refused as a relationship the diagram holds).
  diagramCase('renaming the table a pending line points at re-spells the line', SALES_MISSING, (a) => {
    a.logical.models = a.logical.models.map((m: string) => (m === 'dim_customer' ? 'dim_client' : m));
    for (const r of a.logical.relationships) if (r.toModel === 'dim_customer') r.toModel = 'dim_client';
  }, (out) => {
    expect(out).toContain('// erd-studio pending: Ref: gld_fct_risk_child.customer_key >? gold.dim_client.customer_key\n');
    expect(out).toContain("use { table gold.dim_client } from '../tables/gold/dim_client.dbml'\n");
    expect(readDiagram(out).logical.relationships).toEqual([
      { fromModel: 'gld_fct_risk_child', fromColumn: 'customer_key', toModel: 'dim_client', toColumn: 'customer_key', cardinality: 'many-to-one' },
    ]);
  }, { library: CLIENT_LIBRARY, extra: { pathChanged: new Set(['dim_customer', 'dim_client']) }, parsers: ['9.1.1', '10.3.1', '11.0.0'] }),
  diagramCase('renaming a column a pending line names re-spells only that column', SALES_MISSING, (a) => {
    for (const r of a.logical.relationships) if (r.toColumn === 'customer_key') r.toColumn = 'customer_id';
  }, (out) => {
    expect(out).toBe(SALES_MISSING.replace('>? gold.dim_customer.customer_key', '>? gold.dim_customer.customer_id'));
  }, { library: CUSTOMER_ID_LIBRARY, parsers: ['9.1.1', '10.3.1', '11.0.0'] }),
  diagramCase('renaming an unlinked YAML member keeps it unlinked, under its new name, in its place', SALES_MISSING.replace("erd_unlinked_tables: 'gld_fct_risk_child'", "erd_unlinked_tables: 'gld_fct_risk_child, left_yaml'"), (a) => {
    a.logical.models = a.logical.models.map((m: string) => (m === 'left_yaml' ? 'left_yaml2' : m));
  }, (out) => {
    expect(out).toContain("erd_unlinked_tables: 'gld_fct_risk_child, left_yaml2'");
    expect(out).not.toContain('use { table left_yaml2 }');
  }, { yaml: { left_yaml2: 'logical-models/left_yaml2.yml' } }),
];

/** New-file cases: `renderNewSubjectAreaDbml`. */
export const NEW_DIAGRAM_CASES: WriterCase[] = [
  {
    name: 'a new diagram follows the §2.5 order',
    run: () => ({
      path: DIAGRAM_PATH,
      input: null,
      output: renderNewSubjectAreaDbml({
        filePath: DIAGRAM_PATH,
        domain: 'sales',
        description: 'Sales star schema',
        showFkEdges: false,
        layoutOptions: { 'elk.direction': 'RIGHT' },
        members: [
          { name: 'fct_order', path: 'tables/gold/fct_order.dbml' },
          { name: 'dim_customer', reference: 'gold.dim_customer', path: 'tables/gold/dim_customer.dbml' },
          { name: 'dim_date', path: 'tables/dim_date.dbml' },
        ],
        relationshipsFiles: ['tables/gold/_relationships.dbml', 'tables/_relationships.dbml'],
        annotations: [
          { id: '3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c', text: 'Check the grain with finance', x: 720, y: 40, width: 220, height: 120, color: 'yellow', linkedModel: 'fct_order' },
          { id: '9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f', text: '', x: 0, y: 0, color: 'blue' },
        ],
        positions: { fct_order: { x: 400.499, y: 200 }, dim_customer: { x: 40, y: 60 } },
      }),
      context: { ...DIAGRAM_LIBRARY },
    }),
    check: (o) => {
      expect(o.output).toBe(`use { table fct_order } from '../tables/gold/fct_order.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table dim_date } from '../tables/dim_date.dbml'
use * from '../tables/_relationships.dbml'
use * from '../tables/gold/_relationships.dbml'

Note "3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c" [color: #f59e0b, linked_table: 'fct_order'] {
  'Check the grain with finance'
}

Note "9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f" [color: #3b82f6] {
  ''
}

Project sales {
  Note: 'Sales star schema'
  erd_schema_version: '7'
  erd_show_fk_edges: 'false'
  erd_layout_options: '{"elk.direction":"RIGHT"}'
  erd_layout: '''
    dim_customer 40 60
    fct_order 400.5 200
    note/3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c 720 40 220 120
    note/9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f 0 0
  '''
}
`);
      const read = parseSubjectAreaDbml(o.output, DIAGRAM_PATH);
      expect(read.members).toEqual(['fct_order', 'dim_customer', 'dim_date']);
      expect(read.obj.viewConfig).toMatchObject({
        showFkEdges: false,
        layoutOptions: { 'elk.direction': 'RIGHT' },
        positions: { dim_customer: { x: 40, y: 60 }, fct_order: { x: 400.5, y: 200 } },
      });
      expect((read.obj.viewConfig as { annotations: unknown[] }).annotations[0]).toMatchObject({ x: 720, y: 40, width: 220, height: 120 });
    },
  },
  {
    name: 'a new empty diagram is just its Project',
    run: () => ({ path: 'silver/empty.dbml', input: null, output: renderNewSubjectAreaDbml({ filePath: 'silver/empty.dbml', domain: 'empty', members: [], relationshipsFiles: [] }) }),
    check: (o) => { expect(o.output).toBe("Project empty {\n  erd_schema_version: '7'\n}\n"); },
  },
];
