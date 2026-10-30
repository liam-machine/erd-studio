/**
 * `src/services/dbmlWriters.ts`: core's DBML splicers followed by the
 * formatter, the only way the host writes a `.dbml`. Holds the boundary (no
 * other host module imports a writer from core), the no-op rule, the 1.9.x
 * layout reading and converging, and the logged fallback when the formatter
 * declines.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { formatDbml, parseTableDbml } from '@erd-studio/core/dbml';

import {
  editDiagramLayoutDbml,
  canonicalDbml,
  editSubjectAreaDbml,
  editTableDbml,
  formatWrittenDbml,
  renderNewSubjectAreaDbml,
  renderNewTableDbml,
} from '../../src/services/dbmlWriters';
import { clearLogBuffer, recentLogLines } from '../../src/services/logger';
import type { SemanticTable } from '../../src/types/semantic';

const SRC = path.resolve(__dirname, '../../src');
const WRITERS = ['renderNewTableDbml', 'editTableDbml', 'editRelationshipsDbml', 'renderNewSubjectAreaDbml', 'editSubjectAreaDbml'];

/** Every .ts file under `dir`. */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : e.name.endsWith('.ts') ? [p] : [];
  });
}

/** A table file exactly as ERD Studio 1.9.3 wrote it: settings in the old order, the Note last, nothing aligned. */
const V193_TABLE = `Table fct_order [schema: 'gold', role: 'transaction-fact'] {
  order_line_id BIGINT [pk, note: 'Line id from the shop', natural_key: 'true']
  customer_key INT [note: 'FK to dim_customer', foreign_key: 'true']
  amount "DECIMAL(18,2)" [note: 'Line total', additive_type: 'additive']
  Note: 'Order lines'
}
`;

beforeEach(() => clearLogBuffer());

describe('the boundary', () => {
  it('no host module but dbmlWriters.ts imports a DBML writer from core, so every write is formatted', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      if (path.basename(file) === 'dbmlWriters.ts') continue;
      const text = fs.readFileSync(file, 'utf-8');
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@erd-studio\/core\/dbml'/g)) {
        const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean);
        for (const n of names) if (WRITERS.includes(n)) offenders.push(`${path.relative(SRC, file)}: ${n}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('formatWrittenDbml', () => {
  it('formats; text it cannot format is written as it is, and the reason logged at info', () => {
    expect(formatWrittenDbml('Table t {\n    id int  [pk]\n}\n', 'tables/t.dbml')).toBe('Table t {\n  id int [pk]\n}\n');
    const broken = 'Table t {\n  id int [pk\n}\n';
    expect(formatWrittenDbml(broken, 'tables/t.dbml')).toBe(broken);
    expect(recentLogLines().some((l) => /\[info\] \[dbml\] tables\/t\.dbml was written without formatting: \d+ syntax errors? \(first: line \d+: /.test(l))).toBe(true);
  });
});

describe('canonicalDbml', () => {
  it('formats without logging, and is undefined for text the formatter declines (a read, not a write)', () => {
    expect(canonicalDbml('Table t {\n    id int  [pk]\n}\n')).toBe('Table t {\n  id int [pk]\n}\n');
    expect(canonicalDbml('Table t {\n  id int [pk\n}\n')).toBeUndefined();
    expect(recentLogLines()).toEqual([]);
  });
});

describe('the writers', () => {
  it('a new table: Note first, aligned, settings in the canonical order with the note last, a fixed point of the formatter', () => {
    const table: SemanticTable = {
      name: 'fct_order',
      schema: 'gold',
      description: 'Order lines',
      columns: [
        { name: 'order_line_id', dataType: 'BIGINT', description: 'Line id', isPrimaryKey: true, isNaturalKey: true },
        { name: 'amount', dataType: 'DECIMAL(18,2)', description: 'Line total', additiveType: 'additive' },
      ],
    };
    const text = renderNewTableDbml(table);
    expect(text).toBe(
      "Table fct_order [schema: 'gold'] {\n" +
      "  Note: 'Order lines'\n" +
      '\n' +
      "  order_line_id BIGINT          [pk, natural_key: 'true', note: 'Line id']\n" +
      "  amount        \"DECIMAL(18,2)\" [additive_type: 'additive', note: 'Line total']\n" +
      '}\n',
    );
    expect(formatDbml(text)).toMatchObject({ changed: false });
  });

  it('a column whose settings pass 100 characters gets them one per line', () => {
    const long = 'x'.repeat(90);
    const text = renderNewTableDbml({ name: 't', columns: [{ name: 'id', dataType: 'int', description: long, isPrimaryKey: true }] });
    expect(text).toBe(`Table t {\n  id int [\n    pk,\n    note: '${long}'\n  ]\n}\n`);
  });

  it('a 1.9.3 table file still reads, the same table as the new layout', () => {
    const old = parseTableDbml(V193_TABLE, 'fct_order');
    expect(old.ok).toBe(true);
    if (!old.ok) return;
    const fresh = parseTableDbml(renderNewTableDbml(old.table), 'fct_order');
    expect(fresh.ok && fresh.table).toEqual(old.table);
  });

  it('an edit that changes nothing returns a 1.9.3 file byte for byte (no reformat on a no-op)', () => {
    const reading = parseTableDbml(V193_TABLE, 'fct_order');
    if (!reading.ok) throw new Error('no read');
    expect(editTableDbml(V193_TABLE, reading.table)).toBe(V193_TABLE);
  });

  it('the first real edit of a 1.9.3 file converges it on the canonical layout in one write, keeping its order', () => {
    const reading = parseTableDbml(V193_TABLE, 'fct_order');
    if (!reading.ok) throw new Error('no read');
    const desired = structuredClone(reading.table);
    desired.columns![1].description = 'Who ordered';
    const out = editTableDbml(V193_TABLE, desired);
    expect(out).toBe(`Table fct_order [
  schema: 'gold',
  role: 'transaction-fact'
] {
  order_line_id BIGINT          [pk, note: 'Line id from the shop', natural_key: 'true']
  customer_key  INT             [note: 'Who ordered', foreign_key: 'true']
  amount        "DECIMAL(18,2)" [note: 'Line total', additive_type: 'additive']
  Note: 'Order lines'
}
`);
    expect(formatDbml(out).changed).toBe(false);
    const back = parseTableDbml(out, 'fct_order');
    expect(back.ok && back.table).toEqual(desired);
    // A second identical edit is a no-op.
    expect(editTableDbml(out, desired)).toBe(out);
  });

  it('a new diagram aligns its table use lines', () => {
    const text = renderNewSubjectAreaDbml({
      filePath: 'gold/sales.dbml',
      domain: 'sales',
      members: [
        { name: 'fct_order', reference: 'fct_order', path: 'tables/gold/fct_order.dbml' },
        { name: 'dim_date', reference: 'dim_date', path: 'tables/dim_date.dbml' },
      ],
      relationshipsFiles: [],
      annotations: [],
    });
    expect(text).toContain("use { table fct_order } from '../tables/gold/fct_order.dbml'\nuse { table dim_date }  from '../tables/dim_date.dbml'\n");
    expect(formatDbml(text).changed).toBe(false);
  });

  it('a diagram edit that changes nothing leaves an unformatted file byte for byte', () => {
    const text = "Project sales {\n    erd_schema_version: '7'\n}\nuse { table fct_order } from '../tables/gold/fct_order.dbml'\nuse { table dim_date } from '../tables/dim_date.dbml'\n";
    const obj = { schemaVersion: 5, domain: 'sales', layer: 'gold', logical: { models: ['fct_order', 'dim_date'], relationships: [] } };
    const out = editSubjectAreaDbml(text, {
      filePath: 'gold/sales.dbml',
      before: obj,
      after: structuredClone(obj),
      resolveTable: (name) => ({ name, reference: name, path: name === 'dim_date' ? 'tables/dim_date.dbml' : `tables/gold/${name}.dbml`, storage: 'dbml' }),
      relationshipsFilesFor: () => [],
      fileExists: () => true,
    });
    expect(out).toBe(text);
  });

  it('a layout-only edit (a drag) is NOT formatted: only erd_layout changes, the rest keeps its hand layout', () => {
    const text = "Project sales {\n    erd_schema_version: '7'\n    erd_layout: '''\n      fct_order 1 2\n    '''\n}\nuse { table fct_order } from '../tables/gold/fct_order.dbml'\nuse { table dim_date } from '../tables/dim_date.dbml'\n";
    expect(formatDbml(text).changed).toBe(true);
    const out = editDiagramLayoutDbml(text, { filePath: 'gold/sales.dbml', positions: { fct_order: { x: 3, y: 4 } }, annotations: [] });
    expect(out).toBe(text.replace('      fct_order 1 2\n', '      fct_order 3 4\n'));
  });
});
