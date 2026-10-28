/**
 * The last few DBML diagram readings (`src/services/dbmlDiagramReadings.ts`):
 * one open of a canvas reads its diagram once, wherever the path it is named
 * by comes from, and a changed diagram or layout is always read again.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import * as dbml from '@erd-studio/core/dbml';
import { clearDbmlDiagramReadings, readDbmlDiagram, readingPathKey } from '../../src/services/dbmlDiagramReadings';

const DIAGRAM = `Project sales {
  erd_schema_version: '7'
}

use { table fct_order } from '../tables/gold/fct_order.dbml'
use { table dim_date } from '../tables/dim_date.dbml'
`;
const layout = (x: number): string => JSON.stringify({ version: '3.0.0', defaultView: { tablePositions: [{ name: 'fct_order', schemaName: 'public', x, y: 20 }] } });
const LAYOUT = layout(10);

beforeEach(() => {
  clearDbmlDiagramReadings();
});

describe('readDbmlDiagram', () => {
  it('reads as core does', () => {
    expect(readDbmlDiagram(DIAGRAM, '/p/.erd-studio/gold/sales.dbml', LAYOUT)).toEqual(dbml.parseSubjectAreaDbml(DIAGRAM, '/p/.erd-studio/gold/sales.dbml', LAYOUT));
  });

  it('answers a repeat from memory, as a copy each caller may edit', () => {
    const first = readDbmlDiagram(DIAGRAM, '/p/.erd-studio/gold/sales.dbml', LAYOUT);
    (first.obj.logical as { models: string[] }).models.push('edited');
    first.members.length = 0;
    const second = readDbmlDiagram(DIAGRAM, '/p/.erd-studio/gold/sales.dbml', LAYOUT);
    expect(second.members).toEqual(['fct_order', 'dim_date']);
    expect((second.obj.logical as { models: string[] }).models).toEqual(['fct_order', 'dim_date']);
    expect(second).not.toBe(first);
  });

  it('the absolute path and the project-relative one share a reading (same layer and stem); the reading is the same either way', () => {
    expect(readingPathKey('/p/.erd-studio/gold/sales.dbml')).toBe(readingPathKey('gold/sales.dbml'));
    expect(readingPathKey('C:\\p\\.erd-studio\\gold\\sales.dbml')).toBe('gold/sales');
    expect(readingPathKey('gold/sales.dbml')).not.toBe(readingPathKey('silver/sales.dbml'));
    const absolute = dbml.parseSubjectAreaDbml(DIAGRAM, '/p/.erd-studio/gold/sales.dbml', LAYOUT);
    const relative = dbml.parseSubjectAreaDbml(DIAGRAM, 'gold/sales.dbml', LAYOUT);
    expect(relative).toEqual(absolute);
    readDbmlDiagram(DIAGRAM, '/p/.erd-studio/gold/sales.dbml', LAYOUT);
    expect(readDbmlDiagram(DIAGRAM, 'gold/sales.dbml', LAYOUT)).toEqual(absolute);
  });

  it('a diagram in another layer, a changed text or a changed layout is read again', () => {
    const gold = readDbmlDiagram(DIAGRAM, 'gold/sales.dbml', LAYOUT);
    expect(readDbmlDiagram(DIAGRAM, 'silver/sales.dbml', LAYOUT).obj.layer).toBe('silver');
    expect(gold.obj.layer).toBe('gold');
    const moved = readDbmlDiagram(DIAGRAM, 'gold/sales.dbml', layout(99));
    expect((moved.obj.viewConfig as { positions: Record<string, { x: number }> }).positions.fct_order.x).toBe(99);
    expect(readDbmlDiagram(DIAGRAM, 'gold/sales.dbml', null).obj.viewConfig).toMatchObject({ positions: {} });
    const edited = readDbmlDiagram(DIAGRAM.replace("use { table dim_date } from '../tables/dim_date.dbml'\n", ''), 'gold/sales.dbml', LAYOUT);
    expect(edited.members).toEqual(['fct_order']);
  });

  it('a failure is not remembered, and names the path it was asked with', () => {
    const broken = 'Project p {\n  erd_schema_version: \'7\'\n';
    expect(() => readDbmlDiagram(broken, 'gold/a.dbml', null)).toThrow(/gold\/a\.dbml/);
    expect(() => readDbmlDiagram(broken, '/abs/.erd-studio/gold/a.dbml', null)).toThrow(/\/abs\/\.erd-studio\/gold\/a\.dbml/);
  });
});
