/**
 * Both sidebar trees driven by the real services over a project on disk:
 * the Subject Areas tree counts a diagram's tables from the file alone and
 * gets the same number a full `getSubjectArea` resolves (JSON v4 / v5 / v6,
 * a missing table, a DBML diagram), listing the subject areas once per
 * render; the Table Library reads each diagram's members once per version,
 * shows a large library before reading every table file (marking a broken
 * one a moment later), and says when it is loading (`erdStudio.tablesLoading`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SubjectAreaTreeProvider, type TreeElement } from '../../src/providers/DomainTreeProvider';
import { TableLibraryTreeProvider, type TableLibraryNode, type TableLibraryTableNode } from '../../src/providers/ModelLibraryTreeProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';

let root: string;
let semantic: string;

function write(rel: string, text: string): string {
  const file = path.join(semantic, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const dbmlTable = (name: string): string => `Table ${name} {\n  id INT [pk]\n}\n`;
const yamlTable = (name: string): string => `name: ${name}\ncolumns:\n  - name: id\n    dataType: INT\n`;

function services() {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return { layerService, subjectAreaService, tableLibraryService };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-trees-'));
  semantic = path.join(root, '.erd-studio');
  write('layers.json', JSON.stringify({
    version: 1,
    layers: [
      { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', creatable: true, order: 0 },
      { id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 1 },
    ],
  }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Subject Areas tree: counts from the diagram file, as getSubjectArea resolves them', () => {
  beforeEach(() => {
    write('logical-models/dim_customer.yml', yamlTable('dim_customer'));
    write('logical-models/fct_order.yml', yamlTable('fct_order'));
    write('silver/v5.json', JSON.stringify({ schemaVersion: 5, domain: 'v5', layer: 'silver', logical: { models: ['dim_customer', 'fct_order', 'not_in_library'], relationships: [] } }));
    write('silver/v6.json', JSON.stringify({ schemaVersion: 6, subjectArea: 'v6', layer: 'silver', logical: { tables: ['dim_customer'], relationships: [] } }));
    write('silver/v4.json', JSON.stringify({ schemaVersion: 4, domain: 'v4', layer: 'silver', logical: { models: [{ name: 'a', columns: [] }, { name: 'b', columns: [] }], relationships: [] } }));
    write('silver/empty.json', JSON.stringify({ schemaVersion: 5, domain: 'empty', layer: 'silver', logical: { models: [], relationships: [] } }));
    write('gold/broken.json', '{ "schemaVersion": 5, ');
    write('gold/future.json', JSON.stringify({ schemaVersion: 99, domain: 'future', layer: 'gold', logical: { models: ['x'] } }));
    write('tables/gold/fct_sale.dbml', dbmlTable('fct_sale'));
    write('tables/gold/dim_date.dbml', dbmlTable('dim_date'));
    write('gold/sales.dbml', "Project sales {\n  erd_schema_version: '7'\n}\n\nuse { table fct_sale } from '../tables/gold/fct_sale.dbml'\nuse { table dim_date } from '../tables/gold/dim_date.dbml'\nuse { table gone } from '../tables/gold/gone.dbml'\n");
  });

  function counts(provider: SubjectAreaTreeProvider): Map<string, number> {
    const out = new Map<string, number>();
    for (const layer of provider.getChildren() ?? []) {
      for (const child of provider.getChildren(layer) ?? []) {
        if (child.type === 'domain') out.set(child.summary.domain, child.modelCount);
      }
    }
    return out;
  }

  it('gives every diagram the count a full load gives, and 0 for one that does not load', () => {
    const { layerService, subjectAreaService } = services();
    const provider = new SubjectAreaTreeProvider(subjectAreaService, layerService, root);
    const resolve = vi.spyOn(subjectAreaService, 'getSubjectArea');
    const shown = counts(provider);
    expect(resolve).not.toHaveBeenCalled();
    resolve.mockRestore();

    for (const summary of subjectAreaService.listSubjectAreas(root)) {
      let expected = 0;
      try {
        expected = subjectAreaService.getSubjectArea(summary.filePath).logical.models.length;
      } catch {
        expected = 0;
      }
      expect(shown.get(summary.domain), summary.domain).toBe(expected);
    }
    expect(shown.get('v5')).toBe(3);
    expect(shown.get('v6')).toBe(1);
    expect(shown.get('v4')).toBe(2);
    expect(shown.get('sales')).toBe(3);
    expect(shown.get('broken')).toBe(0);
    expect(shown.get('future')).toBe(0);
  });

  it('lists the subject areas once per render, not once per layer', () => {
    const { layerService, subjectAreaService } = services();
    const provider = new SubjectAreaTreeProvider(subjectAreaService, layerService, root);
    const listing = vi.spyOn(subjectAreaService, 'listSubjectAreas');
    counts(provider);
    expect(listing).toHaveBeenCalledTimes(1);
    // A layer asked for again later (expanded after being collapsed) lists afresh: never stale.
    write('silver/late.json', JSON.stringify({ schemaVersion: 5, domain: 'late', layer: 'silver', logical: { models: ['fct_order'], relationships: [] } }));
    const silver = provider.getChildren({ type: 'layer', layer: 'silver' }) as TreeElement[];
    expect(silver.some((c) => c.type === 'domain' && c.summary.domain === 'late')).toBe(true);
    provider.refresh();
    listing.mockClear();
    counts(provider);
    expect(listing).toHaveBeenCalledTimes(1);
  });
});

describe('Table Library tree with the real library', () => {
  beforeEach(() => {
    for (let i = 0; i < 20; i++) write(`tables/gold/t${i}.dbml`, dbmlTable(`t${i}`));
    write('tables/gold/broken.dbml', 'Table broken {\n  id INT [pk\n');
    write('gold/sales.dbml', "Project sales {\n  erd_schema_version: '7'\n}\n\nuse { table t1 } from '../tables/gold/t1.dbml'\n");
    write('gold/other.dbml', "Project other {\n  erd_schema_version: '7'\n}\n\nuse { table t2 } from '../tables/gold/t2.dbml'\n");
  });

  const nodes = (provider: TableLibraryTreeProvider): TableLibraryTableNode[] =>
    (provider.getChildren() as TableLibraryNode[]).flatMap((n) => (n.type === 'folder' ? n.children : [n]));

  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
  }

  it('shows every table before reading the files, then marks the broken one', async () => {
    const { subjectAreaService, tableLibraryService } = services();
    const provider = new TableLibraryTreeProvider(tableLibraryService, subjectAreaService, root, '.erd-studio');
    const refreshed = vi.fn();
    provider.onDidChangeTreeData(refreshed);
    const read = vi.spyOn(tableLibraryService, 'getTableFileError');

    const first = nodes(provider);
    expect(first).toHaveLength(21);
    expect(read).not.toHaveBeenCalled();
    expect(first.find((n) => n.name === 'broken')?.fileError).toBeUndefined();
    expect(first.find((n) => n.name === 't1')?.referencingDomains).toEqual(['sales']);

    await settle();
    expect(read).toHaveBeenCalledTimes(21);
    expect(refreshed).toHaveBeenCalledTimes(1);
    const second = nodes(provider);
    expect(second.find((n) => n.name === 'broken')?.fileError?.kind).toMatch(/^dbml/);
    expect(second.find((n) => n.name === 't3')?.fileError).toBeUndefined();
    provider.dispose();
  });

  it('validates the library index once per render (and once per background slice), not once per row', async () => {
    const { subjectAreaService, tableLibraryService } = services();
    const provider = new TableLibraryTreeProvider(tableLibraryService, subjectAreaService, root, '.erd-studio');
    // Just written, so every build is racy: an index used outside a snapshot is listed again on each lookup.
    const before = tableLibraryService.indexBuilds;
    nodes(provider);
    expect(tableLibraryService.indexBuilds - before).toBe(1);
    await settle();
    // The background read of the 21 unread files is one slice here, and the broken file re-renders the tree once.
    expect(tableLibraryService.indexBuilds - before).toBeLessThanOrEqual(3);
    provider.dispose();
  });

  it('renders nothing again when every file it had not read is fine', async () => {
    fs.rmSync(path.join(semantic, 'tables/gold/broken.dbml'));
    const { subjectAreaService, tableLibraryService } = services();
    const provider = new TableLibraryTreeProvider(tableLibraryService, subjectAreaService, root, '.erd-studio');
    const refreshed = vi.fn();
    provider.onDidChangeTreeData(refreshed);
    nodes(provider);
    await settle();
    expect(refreshed).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('reads a diagram\'s members once per version of the file', () => {
    const { subjectAreaService, tableLibraryService } = services();
    const provider = new TableLibraryTreeProvider(tableLibraryService, subjectAreaService, root, '.erd-studio');
    const cache = (provider as unknown as { membersCache: Map<string, unknown> }).membersCache;
    const sales = path.join(semantic, 'gold/sales.dbml');
    const other = path.join(semantic, 'gold/other.dbml');
    nodes(provider);
    const salesEntry = cache.get(sales);
    const otherEntry = cache.get(other);
    expect(salesEntry).toBeDefined();
    nodes(provider);
    // The very same entries: neither diagram was read again.
    expect(cache.get(sales)).toBe(salesEntry);
    expect(cache.get(other)).toBe(otherEntry);
    fs.writeFileSync(sales, "Project sales {\n  erd_schema_version: '7'\n}\n\nuse { table t1 } from '../tables/gold/t1.dbml'\nuse { table t3 } from '../tables/gold/t3.dbml'\n");
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(sales, later, later);
    const after = nodes(provider);
    expect(cache.get(sales)).not.toBe(salesEntry);
    expect(cache.get(other)).toBe(otherEntry);
    expect(after.find((n) => n.name === 't3')?.referencingDomains).toEqual(['sales']);
    // A diagram that is gone leaves the cache.
    fs.rmSync(other);
    nodes(provider);
    expect(cache.has(other)).toBe(false);
    provider.dispose();
  });

  it('never clears tablesLoading for a listing with rows (VS Code applies the key before it draws the rows, so "No tables yet" flashed)', () => {
    const { subjectAreaService, tableLibraryService } = services();
    const loading = vi.fn();
    const provider = new TableLibraryTreeProvider(tableLibraryService, subjectAreaService, root, '.erd-studio', () => [], loading);
    expect(provider.isLoading()).toBe(true);
    expect(nodes(provider).length).toBeGreaterThan(0);
    expect(provider.isLoading()).toBe(true);
    // A bulk change drops the index: the full rebuild lists rows again, and the key never drops.
    tableLibraryService.invalidateCache();
    nodes(provider);
    expect(loading.mock.calls).toEqual([]);
    provider.dispose();
  });

  it('clears it once a listing finds no tables, so the empty state shows, and sets it again when tables appear', () => {
    fs.rmSync(path.join(semantic, 'tables'), { recursive: true });
    const { subjectAreaService, tableLibraryService } = services();
    const loading = vi.fn();
    const provider = new TableLibraryTreeProvider(tableLibraryService, subjectAreaService, root, '.erd-studio', () => [], loading);
    expect(provider.getChildren()).toEqual([]);
    expect(loading.mock.calls).toEqual([[false]]);
    write('tables/gold/fct_sale.dbml', dbmlTable('fct_sale'));
    tableLibraryService.invalidateCache();
    expect((provider.getChildren() ?? []).length).toBeGreaterThan(0);
    expect(loading.mock.calls).toEqual([[false], [true]]);
    provider.dispose();
  });

  it('the Subject Areas tree clears diagramsLoading only for a listing with no rows', () => {
    const { subjectAreaService, layerService } = services();
    const loading = vi.fn();
    const provider = new SubjectAreaTreeProvider(subjectAreaService, layerService, root, '.erd-studio', loading);
    expect((provider.getChildren() ?? []).length).toBeGreaterThan(0);
    expect(provider.isLoading()).toBe(true);
    expect(loading.mock.calls).toEqual([]);
    fs.rmSync(semantic, { recursive: true });
    expect(provider.getChildren()).toEqual([]);
    expect(loading.mock.calls).toEqual([[false]]);
    provider.dispose();
  });
});

describe('both trees log how long a render took (debug, in the ERD Studio log)', () => {
  it('the Subject Areas root and each layer, and the Table Library root (marked when read from scratch)', async () => {
    const { setLogSink } = await import('../../src/services/logger');
    const lines: string[] = [];
    const at = (level: string) => (message: string | Error) => { lines.push(`${level} ${String(message)}`); };
    setLogSink({ trace: at('trace'), debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') });
    try {
      write('tables/gold/fct_sale.dbml', dbmlTable('fct_sale'));
      write('gold/sales.dbml', "Project sales {\n  erd_schema_version: '7'\n}\n\nuse { table fct_sale } from '../tables/gold/fct_sale.dbml'\n");
      const { layerService, subjectAreaService, tableLibraryService } = services();
      const areas = new SubjectAreaTreeProvider(subjectAreaService, layerService, root);
      for (const layer of areas.getChildren() ?? []) areas.getChildren(layer);
      const library = new TableLibraryTreeProvider(tableLibraryService, subjectAreaService, root, '.erd-studio', () => layerService.getAllLayers());
      library.getChildren();
      library.getChildren();

      expect(lines).toContainEqual(expect.stringMatching(/^debug \[Subject Areas\] Listed 2 layers in \d+ ms$/));
      expect(lines).toContainEqual(expect.stringMatching(/^debug \[Subject Areas\] Layer gold listed 1 diagram in \d+ ms$/));
      const libraryLines = lines.filter((l) => l.startsWith('debug [Table Library] Listed'));
      expect(libraryLines).toHaveLength(2);
      expect(libraryLines[0]).toMatch(/Listed 1 row in \d+ ms \(library read from scratch\)$/);
      // The second render may read from scratch again: files written this instant are not trusted yet.
      expect(libraryLines[1]).toMatch(/listed 1 row in \d+ ms/i);
      expect(lines).toContainEqual(expect.stringMatching(/^debug \[Table Library\] Library index built: 1 table file\(s\)/));
    } finally {
      setLogSink(undefined);
    }
  });
});
