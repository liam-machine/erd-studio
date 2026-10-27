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

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Read `text` as the diagram at `path`. */
export function readDiagram(text: string, path = DIAGRAM_PATH): Obj {
  return parseSubjectAreaDbml(text, path, null).obj;
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
  diagramCase('a diagram with no Project gets one after a header comment followed by a blank line',
    "// The sales star.\n\nuse { table fct_order } from '../tables/gold/fct_order.dbml'\n", (a) => { a.description = 'Sales'; }, (out) => {
      expect(out).toBe("// The sales star.\nProject sales {\n  Note: 'Sales'\n  erd_schema_version: '7'\n}\n\nuse { table fct_order } from '../tables/gold/fct_order.dbml'\n");
    }),
  diagramCase('…and at the top when the comment runs straight into the first line',
    "// about fct_order\nuse { table fct_order } from '../tables/gold/fct_order.dbml'\n", (a) => { a.domain = 'renamed'; }, (out) => {
      expect(out).toBe("Project renamed {\n  erd_schema_version: '7'\n}\n\n// about fct_order\nuse { table fct_order } from '../tables/gold/fct_order.dbml'\n");
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

  // --- Notes ---------------------------------------------------------------------------------
  diagramCase('a sticky note added is a Note block at the end', SALES, (a) => {
    a.viewConfig.annotations.push({ id: '9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f', text: '', x: 1, y: 2, color: 'blue' });
  }, (out) => {
    expect(out).toBe(`${SALES}\nNote "9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f" [color: #3b82f6] {\n  ''\n}\n`);
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
          { id: '3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c', text: 'Check the grain with finance', x: 0, y: 0, color: 'yellow', linkedModel: 'fct_order' },
          { id: '9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f', text: '', x: 0, y: 0, color: 'blue' },
        ],
      }),
      context: { ...DIAGRAM_LIBRARY },
    }),
    check: (o) => {
      expect(o.output).toBe(`Project sales {
  Note: 'Sales star schema'
  erd_schema_version: '7'
  erd_show_fk_edges: 'false'
  erd_layout_options: '{"elk.direction":"RIGHT"}'
}

use { table fct_order } from '../tables/gold/fct_order.dbml'
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
`);
      const read = parseSubjectAreaDbml(o.output, DIAGRAM_PATH, null);
      expect(read.members).toEqual(['fct_order', 'dim_customer', 'dim_date']);
      expect(read.obj.viewConfig).toMatchObject({ showFkEdges: false, layoutOptions: { 'elk.direction': 'RIGHT' } });
    },
  },
  {
    name: 'a new empty diagram is just its Project',
    run: () => ({ path: 'silver/empty.dbml', input: null, output: renderNewSubjectAreaDbml({ filePath: 'silver/empty.dbml', domain: 'empty', members: [], relationshipsFiles: [] }) }),
    check: (o) => { expect(o.output).toBe("Project empty {\n  erd_schema_version: '7'\n}\n"); },
  },
];
