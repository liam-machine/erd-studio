/**
 * The layer-first DBML tree's path helpers (ERD Studio 2.0, §1.1 and §1.8 of
 * the design): which folders are DBML layers, the exact shapes of a table,
 * relationships file and diagram, the path builders, and the 1.9
 * pre-release's shapes 2.0 no longer reads.
 */
import { describe, it, expect } from 'vitest';

import {
  DIAGRAMS_DIR,
  RELATIONSHIPS_DIR,
  RESERVED_LAYER_NAMES,
  dbmlTablePath,
  dbmlTreePathOf,
  diagramFilePath,
  diagramPathOf,
  isDbmlLayerName,
  isReservedLayerName,
  legacyDbmlFileMessage,
  legacyDbmlShapeOf,
  relationshipsFilePath,
} from '../../src/storage';
import * as core from '../../src/index';

describe('isReservedLayerName / isDbmlLayerName', () => {
  it('reserves tables, templates and logical-models in any case, and nothing else', () => {
    expect([...RESERVED_LAYER_NAMES].sort()).toEqual(['logical-models', 'tables', 'templates']);
    for (const name of ['tables', 'Tables', 'TABLES', 'templates', 'Templates', 'logical-models', 'Logical-Models']) {
      expect(isReservedLayerName(name), name).toBe(true);
      expect(isDbmlLayerName(name), name).toBe(false);
    }
    for (const name of ['diagrams', 'relationships', 'gold', 'logical', 'physical']) {
      expect(isReservedLayerName(name), name).toBe(false);
    }
  });

  it('accepts a lower-case layer id, the fixed folder names included', () => {
    for (const name of ['gold', 'silver', 'bronze', 'gold-old', 'raw_2', 'diagrams', 'relationships', 'a']) {
      expect(isDbmlLayerName(name), name).toBe(true);
    }
  });

  it('refuses NON_SUBJECT_AREA_DIRS, hidden folders and anything that is not a layer id', () => {
    for (const name of ['logical', 'physical', '.x', '.erd-studio', 'Gold', 'GOLD', 'sales area', 'gold.old', '2gold', '-gold', '_gold', '', 'a/b', 'a\\b', 'a\u0000b']) {
      expect(isDbmlLayerName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe('dbmlTreePathOf', () => {
  const rows: Array<[string, ReturnType<typeof dbmlTreePathOf>]> = [
    ['gold/diagrams/sales.dbml', { kind: 'diagram', layer: 'gold', name: 'sales' }],
    ['gold/relationships/gold.dbml', { kind: 'relationships', layer: 'gold', name: 'gold' }],
    ['silver/relationships/calendar.dbml', { kind: 'relationships', layer: 'silver', name: 'calendar' }],
    ['gold/tables/sales/fct_order.dbml', { kind: 'table', layer: 'gold', schema: 'sales', name: 'fct_order' }],
    ['gold/tables/SAP FI/afih.dbml', { kind: 'table', layer: 'gold', schema: 'SAP FI', name: 'afih' }],
    ['gold/tables/relationships/x.dbml', { kind: 'table', layer: 'gold', schema: 'relationships', name: 'x' }],
    ['gold/tables/diagrams/x.dbml', { kind: 'table', layer: 'gold', schema: 'diagrams', name: 'x' }],
    ['diagrams/diagrams/x.dbml', { kind: 'diagram', layer: 'diagrams', name: 'x' }],
    ['relationships/relationships/relationships.dbml', { kind: 'relationships', layer: 'relationships', name: 'relationships' }],
    ['gold/./diagrams/sales.dbml', { kind: 'diagram', layer: 'gold', name: 'sales' }],
    // Not the tree.
    ['gold/Diagrams/x.dbml', undefined],
    ['gold/diagrams/x.DBML', undefined],
    ['gold/diagrams/x.json', undefined],
    ['gold/diagrams/.x.dbml', undefined],
    ['gold/diagrams/sub/x.dbml', undefined],
    ['gold/relationships/finance/x.dbml', undefined],
    ['gold/tables/x.dbml', undefined],
    ['gold/tables/sales/sub/x.dbml', undefined],
    ['gold/tables/.hidden/x.dbml', undefined],
    ['gold/Tables/sales/x.dbml', undefined],
    ['Gold/diagrams/x.dbml', undefined],
    ['tables/diagrams/x.dbml', undefined],
    ['templates/diagrams/x.dbml', undefined],
    ['logical-models/tables/s/x.dbml', undefined],
    ['logical/diagrams/x.dbml', undefined],
    ['tables/tables/s/x.dbml', undefined],
    ['gold/sales.dbml', undefined],
    ['gold/x/y/z/w.dbml', undefined],
    ['/abs/gold/diagrams/x.dbml', undefined],
    ['../gold/diagrams/x.dbml', undefined],
    ['gold\\diagrams\\x.dbml', undefined],
    ['', undefined],
  ];
  for (const [rel, expected] of rows) {
    it(`${JSON.stringify(rel)} → ${expected ? expected.kind : 'not the tree'}`, () => {
      expect(dbmlTreePathOf(rel)).toEqual(expected);
    });
  }
});

describe('diagramPathOf', () => {
  it('takes the last three segments of any path, absolute or Windows', () => {
    const want = { layer: 'gold', dir: 'gold/diagrams', name: 'sales' };
    expect(diagramPathOf('gold/diagrams/sales.dbml')).toEqual(want);
    expect(diagramPathOf('.erd-studio/gold/diagrams/sales.dbml')).toEqual(want);
    expect(diagramPathOf('/home/me/proj/.erd-studio/gold/diagrams/sales.dbml')).toEqual(want);
    expect(diagramPathOf('C:\\proj\\.erd-studio\\gold\\diagrams\\sales.dbml')).toEqual(want);
    expect(diagramPathOf('C:\\proj/.erd-studio\\gold/diagrams\\sales.dbml')).toEqual(want);
  });

  it('is undefined for anything that is not a diagram of a DBML layer', () => {
    for (const p of [
      'gold/Diagrams/x.dbml',
      'gold/diagrams/x.DBML',
      'gold/diagrams/x.json',
      'Gold/diagrams/x.dbml',
      'tables/diagrams/x.dbml',
      'logical/diagrams/x.dbml',
      'gold/sales.dbml',
      'diagrams/x.dbml',
      'gold/tables/s/x.dbml',
      'gold/relationships/x.dbml',
      '/p/.erd-studio/gold/diagrams/.dbml',
      '',
    ]) {
      expect(diagramPathOf(p), p).toBeUndefined();
    }
  });

  it('accepts a layer called diagrams', () => {
    expect(diagramPathOf('/p/diagrams/diagrams/x.dbml')).toEqual({ layer: 'diagrams', dir: 'diagrams/diagrams', name: 'x' });
  });
});

describe('the path builders', () => {
  it('build every shape dbmlTreePathOf reads back', () => {
    expect(DIAGRAMS_DIR).toBe('diagrams');
    expect(RELATIONSHIPS_DIR).toBe('relationships');
    expect(dbmlTablePath('gold', 'sales', 'fct_order')).toBe('gold/tables/sales/fct_order.dbml');
    expect(relationshipsFilePath('gold', 'gold')).toBe('gold/relationships/gold.dbml');
    expect(diagramFilePath('gold', 'sales')).toBe('gold/diagrams/sales.dbml');
    expect(dbmlTreePathOf(dbmlTablePath('gold', 'SAP FI', 'afih'))).toEqual({ kind: 'table', layer: 'gold', schema: 'SAP FI', name: 'afih' });
    expect(dbmlTreePathOf(relationshipsFilePath('silver', 'calendar'))).toEqual({ kind: 'relationships', layer: 'silver', name: 'calendar' });
    expect(dbmlTreePathOf(diagramFilePath('gold', 'sales'))).toEqual({ kind: 'diagram', layer: 'gold', name: 'sales' });
  });

  it('are exported from the main entry', () => {
    for (const name of ['dbmlTablePath', 'relationshipsFilePath', 'diagramFilePath', 'dbmlTreePathOf', 'diagramPathOf', 'isDbmlLayerName', 'isReservedLayerName', 'legacyDbmlShapeOf', 'legacyDbmlFileMessage']) {
      expect(typeof (core as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});

describe('legacyDbmlShapeOf', () => {
  const rows: Array<[string, ReturnType<typeof legacyDbmlShapeOf>]> = [
    ['gold/sales.dbdiagram', 'layout'],
    ['sales.dbdiagram', 'layout'],
    ['gold/diagrams/sales.dbdiagram', 'layout'],
    ['tables/fct_order.dbml', 'table'],
    ['tables/gold/fct_order.dbml', 'table'],
    ['tables/_relationships.dbml', 'relationships'],
    ['tables/gold/_relationships.dbml', 'relationships'],
    ['tables/gold/_Relationships.dbml', 'relationships'],
    ['gold/sales.dbml', 'diagram'],
    ['Gold/sales.dbml', 'diagram'],
    // Not a 1.9 shape.
    ['tables/gold/sub/x.dbml', undefined],
    ['tables/.hidden/x.dbml', undefined],
    ['tables/x.yml', undefined],
    ['tables/gold/x.yml', undefined],
    ['templates/x.dbml', undefined],
    ['.hidden/x.dbml', undefined],
    ['gold/x.json', undefined],
    ['gold/diagrams/sales.dbml', undefined],
    ['gold/relationships/gold.dbml', undefined],
    ['gold/tables/sales/x.dbml', undefined],
    ['x.dbml', undefined],
    ['layers.json', undefined],
    ['/abs/gold/sales.dbml', undefined],
    ['', undefined],
  ];
  for (const [rel, expected] of rows) {
    it(`${JSON.stringify(rel)} → ${expected ?? 'none'}`, () => {
      expect(legacyDbmlShapeOf(rel)).toBe(expected);
    });
  }

  it('never calls a layer-first file legacy', () => {
    for (const rel of [dbmlTablePath('gold', 'sales', 'x'), relationshipsFilePath('gold', 'gold'), diagramFilePath('gold', 'sales')]) {
      expect(legacyDbmlShapeOf(rel), rel).toBeUndefined();
    }
  });
});

describe('legacyDbmlFileMessage', () => {
  it('names the file and points at doctor', () => {
    expect(legacyDbmlFileMessage('tables/gold/_relationships.dbml')).toBe(
      'tables/gold/_relationships.dbml was written by an ERD Studio 1.9 pre-release, whose folder layout 2.0 does not read. '
        + 'Run erd-studio doctor in the project for the steps to convert it again.',
    );
  });
});
