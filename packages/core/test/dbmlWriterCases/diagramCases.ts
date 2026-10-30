/**
 * The diagram writer cases (§9.3 `dbmlWriteDiagram`): each one edits (or
 * creates) `gold/diagrams/sales.dbml` against a small layer-first library
 * (§1.4 of the 2.0 tree design) and checks the text.
 * `dbmlWriteDiagram.test.ts` runs the checks; `dbmlMultiParser.test.ts`
 * compiles every output again, with the files its `use` lines name, under
 * 9.1.1, 10.3.1 and 11.0.0. Not a test file.
 */
import { expect } from 'vitest';

import { parseSubjectAreaDbml } from '../../src/dbml/readDiagram';
import { editSubjectAreaDbml, renderNewSubjectAreaDbml, type SubjectAreaDbmlEdit } from '../../src/dbml/writeDiagram';
import { readRelationshipsDbml } from '../../src/dbml/readRelationships';
import { detectSubjectAreaFormat } from '../../src/types/semantic';
import { clone, diagramResolver, libraryOf, relationshipsFilesOf, type WriterCase, type WriterOutcome } from '../dbmlWriterSupport';
import { LIBRARY } from './relationshipsCases';

export const DIAGRAM_PATH = 'gold/diagrams/sales.dbml';

/** The library plus two relationships files: gold's own, and a hand split holding fct_order's date Ref (to silver's `shared.dim_date`). */
export const DIAGRAM_LIBRARY: Readonly<Record<string, string>> = {
  ...LIBRARY,
  'gold/relationships/gold.dbml': `use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table gold.fct_order } from '../tables/gold/fct_order.dbml'

Ref: gold.fct_order.Customer_Key >? gold.dim_customer.customer_key
`,
  'gold/relationships/dates.dbml': `use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'
use { table gold.fct_order } from '../tables/gold/fct_order.dbml'

Ref: gold.fct_order.order_date_key >? shared.dim_date.date_key
`,
};

export const SALES = `// The sales star.

Project sales {
  Note: 'Sales star schema'
  erd_schema_version: '7'
  database_type: 'Snowflake'
}

use { table gold.fct_order } from '../tables/gold/fct_order.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use * from '../relationships/gold.dbml'

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

use { table gold.fct_order } from '../tables/gold/fct_order.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use * from '../relationships/gold.dbml'

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
  delete out['gold/tables/gold/dim_customer.dbml'];
  out['gold/tables/gold/dim_client.dbml'] = DIAGRAM_LIBRARY['gold/tables/gold/dim_customer.dbml'].replace('gold.dim_customer', 'gold.dim_client');
  out['gold/relationships/gold.dbml'] = DIAGRAM_LIBRARY['gold/relationships/gold.dbml'].replace(/dim_customer/g, 'dim_client');
  return out;
})();

/** The library with dim_customer's \`customer_key\` renamed to \`customer_id\` (its relationships file following). */
const CUSTOMER_ID_LIBRARY: Readonly<Record<string, string>> = {
  ...DIAGRAM_LIBRARY,
  'gold/tables/gold/dim_customer.dbml': DIAGRAM_LIBRARY['gold/tables/gold/dim_customer.dbml'].replace('customer_key int [pk]', 'customer_id int [pk]'),
  'gold/relationships/gold.dbml': DIAGRAM_LIBRARY['gold/relationships/gold.dbml'].replace('gold.dim_customer.customer_key', 'gold.dim_customer.customer_id'),
};

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Read `text` as the diagram at `path`. */
export function readDiagram(text: string, path = DIAGRAM_PATH): Obj {
  return parseSubjectAreaDbml(text, path).obj;
}

/**
 * The relationships files of `library` a diagram of `members` imports (§2.4
 * `relationshipsImportsFor`): each one holding a live Ref with both ends
 * among the members (a self-reference included), or a pending line with
 * both ends among the members and `unlinked`; one that does not read is
 * kept when the diagram imports it now (`current`), never added.
 */
export function importsOver(
  library: Readonly<Record<string, string>>,
  members: readonly string[],
  current: readonly string[],
  unlinked: readonly string[] = [],
): string[] {
  const names = new Set(members.map((m) => m.toLowerCase()));
  const drawn = new Set([...names, ...unlinked.map((m) => m.toLowerCase())]);
  return relationshipsFilesOf(library).filter((file) => {
    const reading = readRelationshipsDbml(library[file]);
    if (!reading.readable) return current.includes(file);
    return reading.refs.some((r) => names.has(r.owner.toLowerCase()) && names.has(r.target.toLowerCase()))
      || (reading.pending ?? []).some((r) => drawn.has(r.owner.toLowerCase()) && drawn.has(r.target.toLowerCase()));
  });
}

/** The edit's lookups over `library`. */
export function lookups(library: Readonly<Record<string, string>>, yaml: Record<string, string> = {}): Pick<SubjectAreaDbmlEdit, 'resolveTable' | 'relationshipsImportsFor' | 'fileExists'> {
  const resolveTable = diagramResolver(libraryOf(library, yaml));
  return {
    resolveTable,
    relationshipsImportsFor: (names, current, unlinked) => importsOver(library, names, current, unlinked),
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
    "// The sales star.\n\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n", (a) => { a.description = 'Sales'; }, (out) => {
      expect(out).toBe("// The sales star.\n\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\nProject sales {\n  Note: 'Sales'\n  erd_schema_version: '7'\n}\n");
    }),
  diagramCase('…and a comment that runs straight into the first line stays with it',
    "// about fct_order\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n", (a) => { a.domain = 'renamed'; }, (out) => {
      expect(out).toBe("// about fct_order\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\nProject renamed {\n  erd_schema_version: '7'\n}\n");
    }),
  diagramCase('…holding erd_layout last when a position changed too',
    "use { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n", (a) => { a.domain = 'renamed'; a.viewConfig.positions = { fct_order: { x: 1.006, y: -0 } }; }, (out) => {
      expect(out).toBe("use { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\nProject renamed {\n  erd_schema_version: '7'\n  erd_layout: '''\n    fct_order 1.01 0\n  '''\n}\n");
    }),

  // --- Members --------------------------------------------------------------------
  diagramCase('a member added goes after the last table use line, with the relationships file holding a Ref between members (§2.4)', SALES, (a) => {
    a.logical.models.push('dim_date');
  }, (out) => {
    expect(out).toBe(SALES.replace(
      "use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse * from '../relationships/gold.dbml'\n",
      "use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'\nuse * from '../relationships/dates.dbml'\nuse * from '../relationships/gold.dbml'\n",
    ));
  }),
  diagramCase('a member added in the middle goes before the next member\'s line', SALES, (a) => {
    a.logical.models.splice(1, 0, 'dim_region');
  }, (out) => {
    expect(out).toContain("use { table gold.fct_order } from '../tables/gold/fct_order.dbml'\nuse { table gold.dim_region } from '../tables/gold/dim_region.dbml'\nuse { table gold.dim_customer }");
    expect(readDiagram(out).logical.models).toEqual(['fct_order', 'dim_region', 'dim_customer']);
  }),
  diagramCase('a member removed is cut; a relationships file holding no Ref between the members left goes', SALES, (a) => {
    a.logical.models = ['dim_date'];
  }, (out) => {
    expect(out).toContain("use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'\n\nNote");
    expect(out).not.toContain('relationships/');
    expect(out).not.toContain('fct_order.dbml');
  }),
  diagramCase('a new member order rebuilds the table use lines', SALES, (a) => {
    a.logical.models.reverse();
  }, (out) => {
    expect(out).toContain("use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\nuse * from");
  }),
  diagramCase('a new member order keeps each line\'s trailing comment and the comment lines above', SALES
    .replace("'../tables/gold/fct_order.dbml'", "'../tables/gold/fct_order.dbml' // the facts")
    .replace("use { table gold.dim_customer }", "// customers\nuse { table gold.dim_customer }"), (a) => {
    a.logical.models.reverse();
  }, (out) => {
    expect(out).toContain("// customers\nuse { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml' // the facts\nuse * from");
  }),
  diagramCase('a member whose table was deleted (pathChanged, no file now) loses its line, even with nothing else changed', SALES, () => undefined, (out) => {
    expect(out).toBe(SALES.replace("use { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n", ''));
  }, {
    library: (() => {
      const lib: Record<string, string> = { ...DIAGRAM_LIBRARY };
      delete lib['gold/tables/gold/fct_order.dbml'];
      lib['gold/relationships/gold.dbml'] = "use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\n";
      delete lib['gold/relationships/dates.dbml'];
      return lib;
    })(),
    extra: { pathChanged: new Set(['fct_order']) },
    // The input compiled clean against the library before the delete.
    parsers: ['9.1.1', '10.3.1', '11.0.0'],
  }),
  diagramCase('a member whose table moved to another layer is rewritten (pathChanged)', SALES, () => undefined, (out) => {
    expect(out).toBe(SALES.replace("use { table gold.fct_order } from '../tables/gold/fct_order.dbml'", "use { table gold.fct_order } from '../../silver/tables/gold/fct_order.dbml'"));
  }, {
    library: (() => {
      const lib: Record<string, string> = { ...DIAGRAM_LIBRARY, 'silver/tables/gold/fct_order.dbml': LIBRARY['gold/tables/gold/fct_order.dbml'] };
      delete lib['gold/tables/gold/fct_order.dbml'];
      for (const f of ['gold/relationships/gold.dbml', 'gold/relationships/dates.dbml']) {
        lib[f] = lib[f].replace("'../tables/gold/fct_order.dbml'", "'../../silver/tables/gold/fct_order.dbml'");
      }
      return lib;
    })(),
    extra: { pathChanged: new Set(['fct_order']) },
    // The input compiled clean against the library before the move.
    parsers: ['9.1.1', '10.3.1', '11.0.0'],
  }),
  diagramCase('a member renamed with its table (pathChanged) gets its new line where the old one was', SALES, (a) => {
    a.logical.models[0] = 'fct_order_line';
  }, (out) => {
    expect(out).toBe(SALES.replace("use { table gold.fct_order } from '../tables/gold/fct_order.dbml'", "use { table gold.fct_order_line } from '../tables/gold/fct_order_line.dbml'"));
  }, {
    library: (() => {
      const lib: Record<string, string> = { ...DIAGRAM_LIBRARY, 'gold/tables/gold/fct_order_line.dbml': LIBRARY['gold/tables/gold/fct_order.dbml'].replace('Table gold.fct_order', 'Table gold.fct_order_line') };
      delete lib['gold/tables/gold/fct_order.dbml'];
      for (const f of ['gold/relationships/gold.dbml', 'gold/relationships/dates.dbml']) lib[f] = lib[f].replace(/fct_order/g, 'fct_order_line');
      return lib;
    })(),
    extra: { pathChanged: new Set(['fct_order']) },
    // The input compiled clean against the library before the move.
    parsers: ['9.1.1', '10.3.1', '11.0.0'],
  }),
  diagramCase('a stale path is rewritten on an edit; a path whose file exists is never repointed', `Project sales {
  erd_schema_version: '7'
}

use { table gold.fct_order } from '../tables/old/fct_order.dbml'
use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'
`, (a) => { a.description = 'x'; }, (out) => {
    expect(out).toContain("use { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n");
    // dim_date has another copy (gold/tables/gold/dim_date.dbml), but its line's target exists: kept.
    expect(out).toContain("use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'\n");
  }, {
    library: { ...DIAGRAM_LIBRARY, 'gold/tables/gold/dim_date.dbml': 'Table shared.dim_date {\n  date_key int [pk]\n}\n' },
  }),
  diagramCase('an existing member that resolves to a YAML table keeps its line bytes (D20)', `Project sales {
  erd_schema_version: '7'
}

use { table yml_t } from '../tables/yml_t.dbml'
use { table gold.fct_order } from '../tables/gold/fct_order.dbml'
`, (a) => { a.description = 'x'; }, (out) => {
    expect(out).toContain("use { table yml_t } from '../tables/yml_t.dbml'\n");
  }, { yaml: { yml_t: 'logical-models/yml_t.yml' } }),

  // --- Relationships use lines ----------------------------------------------------------
  diagramCase('relationships use lines are left alone when membership does not change', SALES.replace("use * from '../relationships/gold.dbml'\n", ''), (a) => {
    a.description = 'x';
  }, (out) => {
    expect(out).not.toContain('relationships/gold.dbml');
  }),
  {
    name: '…and recomputed by the settle pass (refreshRelationshipsUses) with no other change',
    run: (): WriterOutcome => ({
      path: DIAGRAM_PATH,
      input: SALES.replace("use * from '../relationships/gold.dbml'\n", ''),
      output: diagramEdit(SALES.replace("use * from '../relationships/gold.dbml'\n", ''), () => undefined, { extra: { refreshRelationshipsUses: true } }),
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
    expect(out).toContain("use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'\nuse * from '../relationships/dates.dbml'\nuse * from '../relationships/gold.dbml'\n");
    expect(out).toContain("Note n2 {\n  'two'\n}\n\nProject sales {");
    expect(out.trimEnd().endsWith('}')).toBe(true);
    expect(out.indexOf('Project sales')).toBeGreaterThan(out.indexOf('Note n2'));
    expect(out).toContain('    note/n2 5 6\n');
  }),
  diagramCase('a diagram with no use line gets its first ones before the first Note, else before the Project',
    "Project sales {\n  erd_schema_version: '7'\n}\n", (a) => { a.logical.models = ['fct_order', 'dim_customer']; }, (out) => {
      expect(out).toBe("use { table gold.fct_order } from '../tables/gold/fct_order.dbml'\nuse { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse * from '../relationships/gold.dbml'\n\nProject sales {\n  erd_schema_version: '7'\n}\n");
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
      expect(o.output).toContain("use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'\r\n");
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
      .replace("use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\n", "use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'\n")
      .replace("use * from '../relationships/gold.dbml'\n", "use * from '../relationships/dates.dbml'\nuse * from '../relationships/gold.dbml'\n"));
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
          { name: 'fct_order', reference: 'gold.fct_order', path: 'gold/tables/gold/fct_order.dbml' },
          { name: 'dim_customer', reference: 'gold.dim_customer', path: 'gold/tables/gold/dim_customer.dbml' },
          { name: 'dim_date', reference: 'shared.dim_date', path: 'silver/tables/shared/dim_date.dbml' },
        ],
        relationshipsFiles: ['gold/relationships/gold.dbml', 'gold/relationships/dates.dbml'],
        annotations: [
          { id: '3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c', text: 'Check the grain with finance', x: 720, y: 40, width: 220, height: 120, color: 'yellow', linkedModel: 'fct_order' },
          { id: '9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f', text: '', x: 0, y: 0, color: 'blue' },
        ],
        positions: { fct_order: { x: 400.499, y: 200 }, dim_customer: { x: 40, y: 60 } },
      }),
      context: { ...DIAGRAM_LIBRARY },
    }),
    check: (o) => {
      expect(o.output).toBe(`use { table gold.fct_order } from '../tables/gold/fct_order.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'
use * from '../relationships/dates.dbml'
use * from '../relationships/gold.dbml'

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
    run: () => ({ path: 'silver/diagrams/empty.dbml', input: null, output: renderNewSubjectAreaDbml({ filePath: 'silver/diagrams/empty.dbml', domain: 'empty', members: [], relationshipsFiles: [] }) }),
    check: (o) => { expect(o.output).toBe("Project empty {\n  erd_schema_version: '7'\n}\n"); },
  },
];
