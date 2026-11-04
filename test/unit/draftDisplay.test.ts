/**
 * The draft's diagram (docs/dev/draft-first.md §13 P1): tables in memory
 * through core's pipeline, each link once; files in memory through
 * `loadDisplaySubjectArea`; the schema counts.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_LAYERS, linkKey } from '@erd-studio/core';
import { displayFromFiles, displayFromTables, draftSchemas } from '../../src/services/draftDisplay';
import { EXAMPLE_PROJECTS, exampleFiles } from '../../src/services/exampleProjects';
import type { Relationship, SemanticTable } from '../../src/types/semantic';

const rel: Relationship = { fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id', cardinality: 'many-to-one' };

const tables: SemanticTable[] = [
  {
    name: 'fct_order',
    schema: 'sales',
    columns: [{ name: 'order_id', dataType: 'int', isPrimaryKey: true }, { name: 'customer_id', dataType: 'int' }],
    // Library mode: the plan's table carries its own link too.
    relationships: [{ toModel: 'dim_customer', fromColumn: 'customer_id', toColumn: 'customer_id', cardinality: 'many-to-one' } as never],
  },
  { name: 'dim_customer', schema: 'sales', columns: [{ name: 'customer_id', dataType: 'int', isPrimaryKey: true }] },
  { name: 'dim_date', columns: [{ name: 'date_day', dataType: 'date', isPrimaryKey: true }] },
];

describe('displayFromTables', () => {
  it('draws every table, each link once, read-only and auto laid out', () => {
    const { display, autoLayout } = displayFromTables({ name: 'sales', layer: 'gold', tables, relationships: [rel], layers: DEFAULT_LAYERS });
    expect(display.readOnly).toBe(true);
    expect(display.stage).toBe('logical');
    expect(display.models.map((m) => m.name)).toEqual(['fct_order', 'dim_customer', 'dim_date']);
    expect(display.relationships).toHaveLength(1);
    expect(new Set(display.relationships.map(linkKey)).size).toBe(display.relationships.length);
    expect(autoLayout).toBe(true);
    // The fallback placement is filled in for every table.
    for (const m of display.models) expect(display.viewConfig.positions?.[m.name]).toBeDefined();
    // The FK end is marked.
    expect(display.models[0].columns.find((c) => c.name === 'customer_id')?.isForeignKey).toBe(true);
  });

  it('keeps stored positions and is not auto laid out when one table has a position', () => {
    const { display, autoLayout } = displayFromTables({
      name: 'sales', layer: 'gold', tables, relationships: [rel], layers: DEFAULT_LAYERS,
      viewConfig: { positions: { fct_order: { x: 10, y: 20 } } },
    });
    expect(autoLayout).toBe(false);
    expect(display.viewConfig.positions?.fct_order).toEqual({ x: 10, y: 20 });
  });

  it('accepts a layer layers.json does not list yet (a new project)', () => {
    const { display } = displayFromTables({ name: 'sales', layer: 'main', tables, relationships: [], layers: DEFAULT_LAYERS });
    expect(display.layer).toBe('main');
  });

  it('does not change the tables it was given', () => {
    const before = JSON.stringify(tables);
    displayFromTables({ name: 'sales', layer: 'gold', tables, relationships: [rel], layers: DEFAULT_LAYERS });
    expect(JSON.stringify(tables)).toBe(before);
  });
});

describe('displayFromFiles', () => {
  it('draws an example project diagram from memory; a missing file reads as none', async () => {
    const project = EXAMPLE_PROJECTS.find((p) => p.id === 'medallion')!;
    const { display } = await displayFromFiles({ files: exampleFiles(project.id), domainPath: project.startDiagram });
    expect(display.readOnly).toBe(true);
    expect(display.models.map((m) => m.name).sort()).toEqual(['dim_customer', 'dim_date', 'dim_product', 'fct_order_line']);
    await expect(displayFromFiles({ files: {}, domainPath: project.startDiagram })).rejects.toThrow();
  });

  it('auto lays out a JSON diagram with no positions, not one with them', async () => {
    const files = {
      '.erd-studio/gold/sales.json': JSON.stringify({ schemaVersion: 5, domain: 'sales', layer: 'gold', description: '', logical: { models: ['a'], relationships: [] }, viewConfig: {} }),
      '.erd-studio/logical-models/a.yml': 'name: a\ncolumns:\n  - name: id\n    dataType: int\n',
    };
    expect((await displayFromFiles({ files, domainPath: '.erd-studio/gold/sales.json' })).autoLayout).toBe(true);
    const positioned = {
      ...files,
      '.erd-studio/gold/sales.json': JSON.stringify({ schemaVersion: 5, domain: 'sales', layer: 'gold', description: '', logical: { models: ['a'], relationships: [] }, viewConfig: { positions: { a: { x: 1, y: 2 } } } }),
    };
    expect((await displayFromFiles({ files: positioned, domainPath: '.erd-studio/gold/sales.json' })).autoLayout).toBe(false);
  });
});

describe('draftSchemas', () => {
  it('counts by schema, biggest first, then by name; no schema is the empty string', () => {
    expect(draftSchemas([{ schema: 'b' }, { schema: 'a' }, { schema: 'b' }, {}, { schema: 'a' }, { schema: 'c' }])).toEqual([
      { schema: 'a', tables: 2 }, { schema: 'b', tables: 2 }, { schema: '', tables: 1 }, { schema: 'c', tables: 1 },
    ]);
    expect(draftSchemas([])).toEqual([]);
  });
});
