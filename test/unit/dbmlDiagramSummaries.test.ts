/**
 * Diagram summaries and the settle rule (ERD Studio 2.0, §2.1 and §2.6 of
 * the design): what a layer-first diagram imports, read with a parse
 * alone; the memo that never re-reads an unchanged closed diagram; and the
 * `needsSettle` truth table.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { diagramSummaryDbml } from '@erd-studio/core/dbml';
import {
  clearDiagramSummaries,
  diagramSummaryForFile,
  diagramSummaryMemoSize,
  diagramSummaryOf,
  needsSettle,
  type DiagramSummary,
  type SettleSignals,
} from '../../src/services/dbmlDiagramSummaries';
import { pairKey } from '../../src/services/dbmlRelationshipsIndex';

const SALES = `// The sales star
use { table fct_order } from '../tables/sales/fct_order.dbml'
use { table crm.dim_customer } from '../../silver/tables/crm/dim_customer.dbml'
use * from '../tables/sales/dim_date'
use * from '../relationships/gold.dbml'
use * from '../../silver/relationships/silver.dbml'
use * from '../relationships/gold.dbml'
use * from '../relationships/finance/x.dbml'
use * from '../../shared/enums.dbml'
use * from '../relationships/dim_store.dbml'
use { enum status } from '../../shared/enums.dbml'
use { table legacy_x } from '../legacy_x.dbml'

Note "n1" [linked_table: 'fct_order'] {
  'Check the grain'
}

Project sales {
  erd_schema_version: '7'
  erd_unlinked_tables: 'gld_fct_child, fct_order'
  erd_layout: '''
    fct_order 10 20
  '''
}
`;

describe('diagramSummaryDbml / diagramSummaryOf', () => {
  it('reads members, relationships imports, other imports and unlinked tables', () => {
    const summary = diagramSummaryOf('gold/diagrams/sales.dbml', SALES);
    expect(summary).toEqual({
      rel: 'gold/diagrams/sales.dbml',
      layer: 'gold',
      members: ['fct_order', 'dim_customer', 'dim_date', 'legacy_x'],
      memberPaths: [
        'gold/tables/sales/fct_order.dbml',
        'silver/tables/crm/dim_customer.dbml',
        'gold/tables/sales/dim_date.dbml',
        'gold/legacy_x.dbml',
      ],
      relationshipsUses: ['gold/relationships/gold.dbml', 'silver/relationships/silver.dbml', 'gold/relationships/dim_store.dbml'],
      otherUses: ['gold/relationships/finance/x.dbml', 'shared/enums.dbml'],
      unlinked: ['gld_fct_child'],
    });
  });

  it('never makes a relationships file named like a table a member', () => {
    const summary = diagramSummaryOf('gold/diagrams/x.dbml', "use * from '../relationships/fct_order.dbml'\n");
    expect(summary?.members).toEqual([]);
    expect(summary?.relationshipsUses).toEqual(['gold/relationships/fct_order.dbml']);
  });

  it('keeps the lines of each member use', () => {
    const summary = diagramSummaryDbml(SALES, '/p/.erd-studio/gold/diagrams/sales.dbml');
    expect(summary?.memberUses[0]).toEqual({ name: 'fct_order', path: '../tables/sales/fct_order.dbml', resolved: 'gold/tables/sales/fct_order.dbml', line: 2 });
    expect(summary?.memberUses.map((u) => u.line)).toEqual([2, 3, 4, 12]);
  });

  it('reads a Windows path and a byte-order mark', () => {
    const summary = diagramSummaryDbml(`\uFEFF${SALES}`, 'C:\\p\\.erd-studio\\gold\\diagrams\\sales.dbml');
    expect(summary?.members).toEqual(['fct_order', 'dim_customer', 'dim_date', 'legacy_x']);
  });

  it('is null on a syntax error or a path that is not a diagram', () => {
    expect(diagramSummaryOf('gold/diagrams/x.dbml', 'use { table x } from')).toBeNull();
    expect(diagramSummaryOf('gold/x.dbml', SALES)).toBeNull();
    expect(diagramSummaryOf('gold/Diagrams/x.dbml', SALES)).toBeNull();
  });

  it('reads a diagram with a binding error (an import of a missing file) as written', () => {
    const summary = diagramSummaryOf('gold/diagrams/x.dbml', "use { table gone } from '../tables/s/gone.dbml'\nRef: gone.a > nowhere.b\n");
    expect(summary?.members).toEqual(['gone']);
  });
});

describe('diagramSummaryForFile', () => {
  let root: string;
  const rel = 'gold/diagrams/sales.dbml';
  let file: string;

  beforeEach(() => {
    clearDiagramSummaries();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-summaries-'));
    file = path.join(root, 'gold', 'diagrams', 'sales.dbml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, SALES);
  });

  afterEach(() => {
    clearDiagramSummaries();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not read an unchanged closed file again (its signature is the key)', () => {
    const mtime = new Date(Date.UTC(2026, 0, 1));
    fs.utimesSync(file, mtime, mtime);
    const first = diagramSummaryForFile(rel, file);
    expect(first).not.toBe('unreadable');
    expect((first as DiagramSummary).members).toContain('fct_order');
    // Same size, same mtime, other bytes: a hit never reads the file.
    fs.writeFileSync(file, SALES.replaceAll('fct_order', 'fct_xxxxx'));
    fs.utimesSync(file, mtime, mtime);
    expect(diagramSummaryForFile(rel, file)).toBe(first);
    // A new mtime is a miss.
    const later = new Date(mtime.getTime() + 5000);
    fs.utimesSync(file, later, later);
    expect((diagramSummaryForFile(rel, file) as DiagramSummary).members).toContain('fct_xxxxx');
  });

  it('holds one entry per diagram, whether it was read from disk or from an open document', () => {
    diagramSummaryForFile(rel, file);
    diagramSummaryForFile(rel, file, SALES.replaceAll('fct_order', 'fct_open'));
    expect(diagramSummaryMemoSize()).toBe(1);
    const open = diagramSummaryForFile(rel, file, SALES.replaceAll('fct_order', 'fct_open')) as DiagramSummary;
    expect(open.members).toContain('fct_open');
    expect((diagramSummaryForFile(rel, file) as DiagramSummary).members).toContain('fct_order');
    expect(diagramSummaryMemoSize()).toBe(1);
    diagramSummaryForFile('gold/diagrams/other.dbml', path.join(root, 'gold', 'diagrams', 'other.dbml'), SALES);
    expect(diagramSummaryMemoSize()).toBe(2);
  });

  it('is unreadable for a missing file, and forgets it', () => {
    diagramSummaryForFile(rel, file);
    fs.rmSync(file);
    expect(diagramSummaryForFile(rel, file)).toBe('unreadable');
    expect(diagramSummaryMemoSize()).toBe(0);
  });

  it('is null for a closed file with a syntax error', () => {
    fs.writeFileSync(file, 'use { table x } from');
    expect(diagramSummaryForFile(rel, file)).toBeNull();
  });
});

describe('needsSettle', () => {
  const summary: DiagramSummary = {
    rel: 'gold/diagrams/sales.dbml',
    layer: 'gold',
    members: ['fct_order', 'Dim_Customer'],
    memberPaths: ['gold/tables/sales/fct_order.dbml', 'gold/tables/crm/Dim_Customer.dbml'],
    relationshipsUses: ['gold/relationships/gold.dbml'],
    otherUses: [],
    unlinked: ['gld_child'],
  };
  const none = new Set<string>();
  const signals = (over: Partial<SettleSignals> = {}): SettleSignals => ({
    pathChanged: none,
    createdTables: none,
    requalified: none,
    changedPairs: none,
    importsFor: (_members, current) => [...current],
    ...over,
  });

  const rows: Array<[string, Partial<SettleSignals>, boolean]> = [
    ['nothing changes', {}, false],
    ['a member is renamed, moved or deleted', { pathChanged: new Set(['fct_order']) }, true],
    ['a member is matched without case', { pathChanged: new Set(['dim_customer']) }, true],
    ['an unlinked table is created', { createdTables: new Set(['gld_child']) }, true],
    ['a member is re-qualified', { requalified: new Set(['dim_customer']) }, true],
    ['another table changes', { pathChanged: new Set(['dim_store']), createdTables: new Set(['x']), requalified: new Set(['y']) }, false],
    ['a pair among the members moves and the imports differ', {
      changedPairs: new Set([pairKey('fct_order', 'dim_customer')]),
      importsFor: () => ['gold/relationships/gold.dbml', 'gold/relationships/b.dbml'],
    }, true],
    ['a self-pair of a member moves and the imports differ', {
      changedPairs: new Set([pairKey('fct_order', 'fct_order')]),
      importsFor: () => [],
    }, true],
    ['a pair among the members moves but the imports are the same set', {
      changedPairs: new Set([pairKey('fct_order', 'dim_customer')]),
      importsFor: () => ['gold/relationships/gold.dbml'],
    }, false],
    ['the imports would differ but no changed pair is among the members', {
      changedPairs: new Set([pairKey('fct_order', 'dim_store')]),
      importsFor: () => [],
    }, false],
    // A pending line to an unlinked table brings an import too (§2.4), so its pair counts.
    ['a pair with an unlinked table changes and the imports differ', {
      changedPairs: new Set([pairKey('fct_order', 'gld_child')]),
      importsFor: () => [],
    }, true],
    ['a pair with an unlinked table changes but the imports are the same set', {
      changedPairs: new Set([pairKey('fct_order', 'gld_child')]),
    }, false],
    ['a pair with a table the diagram does not draw changes', {
      changedPairs: new Set([pairKey('gld_child', 'dim_store')]),
      importsFor: () => [],
    }, false],
  ];
  for (const [label, over, expected] of rows) {
    it(`${label} → ${expected}`, () => {
      expect(needsSettle(summary, signals(over))).toBe(expected);
    });
  }

  it('asks importsFor with the members, the current imports and the unlinked tables', () => {
    const calls: Array<[readonly string[], readonly string[], readonly string[] | undefined]> = [];
    needsSettle(summary, signals({
      changedPairs: new Set([pairKey('fct_order', 'dim_customer')]),
      importsFor: (members, current, unlinked) => {
        calls.push([members, current, unlinked]);
        return [...current];
      },
    }));
    expect(calls).toEqual([[summary.members, summary.relationshipsUses, summary.unlinked]]);
  });
});
