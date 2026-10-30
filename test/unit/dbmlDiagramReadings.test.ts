/**
 * The last few DBML diagram readings (`src/services/dbmlDiagramReadings.ts`):
 * one open of a canvas reads its diagram once, wherever the path it is named
 * by comes from, and a changed diagram (its erd_layout included) is always
 * read again; a drag's write is remembered from the reading before it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import * as dbml from '@erd-studio/core/dbml';
import { clearDbmlDiagramReadings, primeLayoutOnlyReading, readDbmlDiagram, readingPathKey } from '../../src/services/dbmlDiagramReadings';

const diagram = (x: number): string => `use { table fct_order } from '../tables/gold/fct_order.dbml'
use { table dim_date } from '../tables/dim_date.dbml'

Project sales {
  erd_schema_version: '7'
  erd_layout: '''
    fct_order ${x} 20
  '''
}
`;
const DIAGRAM = diagram(10);

beforeEach(() => {
  clearDbmlDiagramReadings();
});

describe('readDbmlDiagram', () => {
  it('reads as core does', () => {
    expect(readDbmlDiagram(DIAGRAM, '/p/.erd-studio/gold/sales.dbml')).toEqual(dbml.parseSubjectAreaDbml(DIAGRAM, '/p/.erd-studio/gold/sales.dbml'));
  });

  it('answers a repeat from memory, as a copy each caller may edit', () => {
    const first = readDbmlDiagram(DIAGRAM, '/p/.erd-studio/gold/sales.dbml');
    (first.obj.logical as { models: string[] }).models.push('edited');
    first.members.length = 0;
    const second = readDbmlDiagram(DIAGRAM, '/p/.erd-studio/gold/sales.dbml');
    expect(second.members).toEqual(['fct_order', 'dim_date']);
    expect((second.obj.logical as { models: string[] }).models).toEqual(['fct_order', 'dim_date']);
    expect(second).not.toBe(first);
  });

  it('the absolute path and the project-relative one share a reading (same layer and stem); the reading is the same either way', () => {
    expect(readingPathKey('/p/.erd-studio/gold/sales.dbml')).toBe(readingPathKey('gold/sales.dbml'));
    expect(readingPathKey('C:\\p\\.erd-studio\\gold\\sales.dbml')).toBe('gold/sales');
    expect(readingPathKey('gold/sales.dbml')).not.toBe(readingPathKey('silver/sales.dbml'));
    const absolute = dbml.parseSubjectAreaDbml(DIAGRAM, '/p/.erd-studio/gold/sales.dbml');
    const relative = dbml.parseSubjectAreaDbml(DIAGRAM, 'gold/sales.dbml');
    expect(relative).toEqual(absolute);
    readDbmlDiagram(DIAGRAM, '/p/.erd-studio/gold/sales.dbml');
    expect(readDbmlDiagram(DIAGRAM, 'gold/sales.dbml')).toEqual(absolute);
  });

  it('a diagram in another layer, a changed text or a changed erd_layout is read again', () => {
    const gold = readDbmlDiagram(DIAGRAM, 'gold/sales.dbml');
    expect(readDbmlDiagram(DIAGRAM, 'silver/sales.dbml').obj.layer).toBe('silver');
    expect(gold.obj.layer).toBe('gold');
    const moved = readDbmlDiagram(diagram(99), 'gold/sales.dbml');
    expect((moved.obj.viewConfig as { positions: Record<string, { x: number }> }).positions.fct_order.x).toBe(99);
    const edited = readDbmlDiagram(DIAGRAM.replace("use { table dim_date } from '../tables/dim_date.dbml'\n", ''), 'gold/sales.dbml');
    expect(edited.members).toEqual(['fct_order']);
  });

  it('a failure is not remembered, and names the path it was asked with', () => {
    const broken = 'Project p {\n  erd_schema_version: \'7\'\n';
    expect(() => readDbmlDiagram(broken, 'gold/a.dbml')).toThrow(/gold\/a\.dbml/);
    expect(() => readDbmlDiagram(broken, '/abs/.erd-studio/gold/a.dbml')).toThrow(/\/abs\/\.erd-studio\/gold\/a\.dbml/);
  });
});

describe('primeLayoutOnlyReading', () => {
  const NOTES = `use { table fct_order } from '../tables/gold/fct_order.dbml'
use { table Dim_Date } from '../tables/Dim_Date.dbml'

Note a {
  'x'
}

Project sales {
  erd_schema_version: '7'
  erd_layout: '''
    DIM_DATE 1 2
    fct_order 10 20
    gone 5 6
    note/a 300 40 200 100
    note/stray 1 1
  '''
}
`;

  it('remembers what the drag wrote as the reader reads it, so the next read compiles nothing and equals a fresh one', () => {
    const before = readDbmlDiagram(NOTES, 'gold/sales.dbml');
    const after = structuredClone(before.obj) as { viewConfig: { positions: Record<string, { x: number; y: number }>; annotations: Array<Record<string, unknown>> } };
    after.viewConfig.positions.fct_order = { x: 12.345, y: -3 };
    after.viewConfig.annotations[0].x = 7;
    delete after.viewConfig.annotations[0].width;
    const written = dbml.editDiagramLayoutDbml(NOTES, { filePath: 'gold/sales.dbml', positions: after.viewConfig.positions, annotations: after.viewConfig.annotations as never });
    primeLayoutOnlyReading(NOTES, written, '/p/.erd-studio/gold/sales.dbml', after);
    const compiles = vi.spyOn(dbml, 'parseSubjectAreaDbml');
    const primed = readDbmlDiagram(written, 'gold/sales.dbml');
    expect(compiles).not.toHaveBeenCalled();
    compiles.mockRestore();
    expect(primed).toEqual(dbml.parseSubjectAreaDbml(written, 'gold/sales.dbml'));
    expect((primed.obj.viewConfig as { positions: unknown }).positions).toEqual({ Dim_Date: { x: 1, y: 2 }, fct_order: { x: 12.35, y: -3 }, gone: { x: 5, y: 6 } });
  });

  it('moves the lines it recorded after erd_layout when a drag changes its line count (a Project first)', () => {
    const first = `Project sales {
  erd_schema_version: '7'
  erd_layout: '''
    fct_order 10 20
  '''
}

use { table fct_order } from '../tables/gold/fct_order.dbml'
use { table other_x } from './other_x.dbml'
use { table dim_date } from '../tables/dim_date.dbml'

Note a {
  'x'
}
`;
    const before = readDbmlDiagram(first, 'gold/sales.dbml');
    expect(before.warnings.some((w) => w.startsWith('Line 9:'))).toBe(true);
    const after = structuredClone(before.obj) as { viewConfig: { positions: Record<string, { x: number; y: number }>; annotations: Array<Record<string, unknown>> } };
    after.viewConfig.positions.dim_date = { x: 1, y: 2 };
    after.viewConfig.positions.other_x = { x: 3, y: 4 };
    after.viewConfig.annotations[0].x = 9;
    const written = dbml.editDiagramLayoutDbml(first, { filePath: 'gold/sales.dbml', positions: after.viewConfig.positions, annotations: after.viewConfig.annotations as never });
    expect(written.split('\n').length).toBeGreaterThan(first.split('\n').length);
    primeLayoutOnlyReading(first, written, 'gold/sales.dbml', after);
    const compiles = vi.spyOn(dbml, 'parseSubjectAreaDbml');
    const primed = readDbmlDiagram(written, 'gold/sales.dbml');
    expect(compiles).not.toHaveBeenCalled();
    compiles.mockRestore();
    expect(primed).toEqual(dbml.parseSubjectAreaDbml(written, 'gold/sales.dbml'));
  });

  it('does nothing when the text before the drag has no reading remembered', () => {
    const written = diagram(50);
    primeLayoutOnlyReading(diagram(40), written, 'gold/sales.dbml', { viewConfig: { positions: { fct_order: { x: 50, y: 20 } } } });
    const compiles = vi.spyOn(dbml, 'parseSubjectAreaDbml');
    readDbmlDiagram(written, 'gold/sales.dbml');
    expect(compiles).toHaveBeenCalledTimes(1);
    compiles.mockRestore();
  });
});
