/**
 * What `TreeView.reveal` needs from the sidebar trees: `getParent` and a way
 * to find a table's row. The Table Library (Reveal in Table Library) answers
 * a table's layer, or its schema folder under its layer; the Relationships
 * view (Go to Table → Show Relationships) a table row's layer. Run on the
 * `dbml-native` fixture with the real services: `gold/tables/gold/` is a
 * layer whose only schema has its own name (its tables sit right under it),
 * `silver/tables/calendar/` a schema folder under its layer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TableLibraryTreeProvider, NO_DIAGRAM_TOOLTIP } from '../../src/providers/ModelLibraryTreeProvider';
import { RelationshipsTreeProvider } from '../../src/providers/RelationshipsTreeProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { tableHomesOf } from '../../src/services/tableHomes';

const NATIVE = path.resolve(__dirname, '../fixtures/dbml-native');
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-tree-reveal-'));
  fs.cpSync(NATIVE, root, { recursive: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function services() {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return { layerService, subjectAreaService, tableLibraryService };
}

describe('TableLibraryTreeProvider: reveal', () => {
  function provider() {
    const { layerService, subjectAreaService, tableLibraryService } = services();
    return new TableLibraryTreeProvider(tableLibraryService, subjectAreaService, root, '.erd-studio', () => layerService.getAllLayers());
  }

  it('finds a table\'s row by name, ignoring case', () => {
    const p = provider();
    expect(p.findTableNode('FCT_ORDER')).toMatchObject({ type: 'model', name: 'fct_order' });
    expect(p.findTableNode('no_such_table')).toBeUndefined();
    p.dispose();
  });

  it('answers a table\'s layer when its tables sit right under it, and none for the layer', () => {
    const p = provider();
    const node = p.findTableNode('fct_order')!;
    const parent = p.getParent(node);
    expect(parent).toMatchObject({ type: 'layer', layer: 'gold', soleSchema: 'gold' });
    expect(p.getParent(parent!)).toBeUndefined();
    p.dispose();
  });

  it('answers a schema folder for a table in one, and its layer for the folder', () => {
    const p = provider();
    const node = p.findTableNode('dim_date')!;
    const folder = p.getParent(node);
    expect(folder).toMatchObject({ type: 'folder', folder: 'calendar', layer: 'silver' });
    expect(p.getParent(folder!)).toMatchObject({ type: 'layer', layer: 'silver' });
    // The parent is a row of the listing VS Code was given, so the reveal resolves.
    expect((p.getChildren(p.getParent(folder!)) ?? []).some((c) => c.type === 'folder' && c.folder === 'calendar')).toBe(true);
    p.dispose();
  });

  it('lists afresh when asked before any listing', () => {
    const p = provider();
    const node = { type: 'model' as const, name: 'dim_date', filePath: path.join(root, '.erd-studio/silver/tables/calendar/dim_date.dbml'), referencingDomains: [] };
    expect(p.getParent(node)).toMatchObject({ type: 'folder', folder: 'calendar' });
    p.dispose();
  });

  it('names Add to Diagram… on a table that no diagram shows', () => {
    expect(NO_DIAGRAM_TOOLTIP).toBe('On no diagram yet. **Add to Diagram…** puts it on one.');
    const p = provider();
    const node = p.findTableNode('customer_profile')!;
    // customer_profile is on sales; the tooltip of one on no diagram carries the text.
    const item = p.getTreeItem({ ...node, referencingDomains: [], referencingLabels: [] });
    expect((item.tooltip as { value: string }).value).toContain(NO_DIAGRAM_TOOLTIP);
    p.dispose();
  });
});

describe('RelationshipsTreeProvider: reveal', () => {
  function provider() {
    const { layerService, subjectAreaService, tableLibraryService } = services();
    return new RelationshipsTreeProvider(
      tableLibraryService,
      subjectAreaService,
      root,
      '.erd-studio',
      undefined,
      () => tableHomesOf(tableLibraryService.listTableFiles()),
      () => layerService.getAllLayers(),
    );
  }

  it('finds a table row under its layer, and answers that layer as its parent', async () => {
    const p = provider();
    const node = await p.findTableNode('FCT_ORDER');
    expect(node).toMatchObject({ type: 'table', group: { table: 'fct_order' } });
    const parent = p.getParent(node!);
    expect(parent).toMatchObject({ type: 'layer', layer: 'gold' });
    expect(p.getParent(parent!)).toBeUndefined();
    p.dispose();
  });

  it('finds nothing for a table with no relationships, or while grouped by file', async () => {
    const p = provider();
    expect(await p.findTableNode('bridge_empty')).toBeUndefined();
    p.setGrouping('file');
    expect(await p.findTableNode('fct_order')).toBeUndefined();
    p.dispose();
  });
});
