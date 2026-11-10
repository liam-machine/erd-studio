import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';

import { EXPLORER_MARKS, SemanticFileDecorationProvider, type ExplorerFactsSource } from '../../src/providers/SemanticFileDecorationProvider';
import type { LayerService } from '../../src/services/layerService';
import type { TableFileEntry } from '../../src/services/logicalModelService';

const LAYERS = [
  { id: 'bronze', label: 'Bronze', color: '#cd7f32' },
  { id: 'silver', label: 'Silver', color: '#ccc' },
  { id: 'gold', label: 'Gold', color: '#d4a800' },
];

function fakeLayerService(options: { layers?: typeof LAYERS; listed?: boolean } = {}): LayerService {
  const layers = options.layers ?? [LAYERS[1]];
  return {
    getLayer: (id: string) => layers.find((l) => l.id === id),
    getAllLayers: () => layers,
    configFileExists: () => options.listed ?? true,
  } as unknown as LayerService;
}

const uri = (p: string) => vscode.Uri.file(p) as unknown as vscode.Uri;
const tooltip = (provider: SemanticFileDecorationProvider, p: string) => provider.provideFileDecoration(uri(p))?.tooltip;

describe('SemanticFileDecorationProvider (H30 semanticDir)', () => {
  it('decorates diagram files under the default .erd-studio directory', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService());
    expect(tooltip(provider, '/proj/.erd-studio/silver/customer.json')).toBe('A diagram in the Silver layer');
  });

  it('decorates diagram files under a custom semanticDir', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService(), '.erd');
    expect(tooltip(provider, '/proj/.erd/silver/customer.json')).toBe('A diagram in the Silver layer');
    expect(tooltip(provider, '/proj/.erd/silver')).toBe('Layer 1 of 1: Silver — its tables, relationships and diagrams');
  });

  it('supports a nested semanticDir and tolerates ./ and trailing slashes', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService(), './docs/erd/');
    expect(tooltip(provider, '/proj/docs/erd/silver/customer.json')).toBe('A diagram in the Silver layer');
  });

  it('does not decorate the default directory when a custom semanticDir is configured', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService(), '.erd');
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/silver/customer.json'))).toBeUndefined();
  });

  it('ignores files outside the semantic dir and unknown layers', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService());
    expect(provider.provideFileDecoration(uri('/proj/models/silver/customer.json'))).toBeUndefined();
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/unknown/customer.json'))).toBeUndefined();
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/silver/customer.yml'))).toBeUndefined();
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/layers.json'))).toBeUndefined();
  });

  it('decorates each kind of .dbml file by its path, but never a 1.9 pre-release file', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService());
    expect(tooltip(provider, '/proj/.erd-studio/silver/diagrams/customer.dbml')).toBe('A diagram in the Silver layer');
    // The layer is the first segment: an unknown layer is not decorated.
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/gold/diagrams/customer.dbml'))).toBeUndefined();
    expect(tooltip(provider, '/proj/.erd-studio/silver/tables/sales/customer.dbml')).toBe('sales.customer');
    expect(tooltip(provider, '/proj/.erd-studio/silver/relationships/silver.dbml')).toBe('Relationships of the Silver layer');
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/silver/Diagrams/customer.dbml'))).toBeUndefined();
    // The 1.9 pre-release tree.
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/silver/customer.dbml'))).toBeUndefined();
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/silver/customer.dbdiagram'))).toBeUndefined();
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/silver/_relationships.dbml'))).toBeUndefined();
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/tables/silver.dbml'))).toBeUndefined();
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/tables/silver/customer.dbml'))).toBeUndefined();
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/tables/silver/_relationships.dbml'))).toBeUndefined();
  });

  it('decorates a .dbml diagram under a custom semanticDir', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService(), '.erd');
    expect(tooltip(provider, '/proj/.erd/silver/diagrams/customer.dbml')).toBe('A diagram in the Silver layer');
  });
});

describe('SemanticFileDecorationProvider: layer folders and the folders in them', () => {
  it('badges each layer folder with its stage in layers.json order and the layer mark, with no colour', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService({ layers: LAYERS }), '.erd-studio', undefined, { semanticRoot: '/proj/.erd-studio' });
    const silver = provider.provideFileDecoration(uri('/proj/.erd-studio/silver'));
    expect(silver).toEqual({ badge: '2≡', tooltip: 'Layer 2 of 3: Silver — its tables, relationships and diagrams' });
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/bronze'))?.badge).toBe('1≡');
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/gold'))?.badge).toBe('3≡');
    expect(silver?.color).toBeUndefined();
  });

  it('keeps a layer badge to two characters: the number alone from stage 10, the mark alone past 99', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ id: `l${i + 1}`, label: `L${i + 1}`, color: '#888' }));
    const provider = new SemanticFileDecorationProvider(fakeLayerService({ layers: many }), '.erd-studio', undefined, { semanticRoot: '/proj/.erd-studio' });
    const badge = (id: string) => provider.provideFileDecoration(uri(`/proj/.erd-studio/${id}`))?.badge;
    expect(badge('l9')).toBe('9≡');
    expect(badge('l10')).toBe('10');
    expect(badge('l99')).toBe('99');
    expect(badge('l100')).toBe('≡');
  });

  it('marks every part of the layer-first tree with a symbol, never a letter git also uses', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService({ layers: LAYERS }), '.erd-studio', undefined, { semanticRoot: '/proj/.erd-studio' });
    const badge = (p: string) => provider.provideFileDecoration(uri(`/proj/.erd-studio/${p}`))?.badge;
    expect(badge('gold/tables')).toBe(EXPLORER_MARKS.table);
    expect(badge('gold/tables/sales')).toBe(EXPLORER_MARKS.schema);
    // A table file has no mark: the Table Library's rows point at it, so the badge would show there too.
    expect(badge('gold/tables/sales/fct_order.dbml')).toBeUndefined();
    expect(badge('gold/relationships')).toBe(EXPLORER_MARKS.relationships);
    expect(badge('gold/relationships/gold.dbml')).toBe(EXPLORER_MARKS.relationships);
    expect(badge('gold/diagrams')).toBe(EXPLORER_MARKS.diagram);
    expect(badge('gold/diagrams/sales.dbml')).toBe(EXPLORER_MARKS.diagram);
    expect(badge('gold/sales.json')).toBe(EXPLORER_MARKS.diagram);
    // Not part of the tree: no mark.
    expect(badge('gold/notes')).toBeUndefined();
    expect(badge('layers.json')).toBeUndefined();
    // VS Code refuses a badge longer than two characters; every mark is one, and none is a letter.
    for (const mark of Object.values(EXPLORER_MARKS)) {
      expect([...mark]).toHaveLength(1);
      expect(mark).not.toMatch(/[A-Za-z0-9]/);
    }
  });

  it('decorates only the project\'s own semantic dir: never a same-named folder in another project or a fixture', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService({ layers: LAYERS }), '.erd-studio', undefined, { semanticRoot: '/proj/.erd-studio/' });
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/gold'))?.badge).toBe('3≡');
    expect(tooltip(provider, '/proj/.erd-studio/gold/diagrams/sales.dbml')).toBe('A diagram in the Gold layer');
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio'))).toBeUndefined();
    expect(provider.provideFileDecoration(uri('/other/.erd-studio/gold'))).toBeUndefined();
    expect(provider.provideFileDecoration(uri('/proj/test/fixtures/dbt-project/.erd-studio/gold'))).toBeUndefined();
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio-old/gold'))).toBeUndefined();
  });

  it('gives a layer folder its mark but no stage number when it cannot tell which semantic dir is the project\'s', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService({ layers: LAYERS }));
    expect(provider.provideFileDecoration(uri('/any/.erd-studio/silver'))).toEqual({
      badge: '≡',
      tooltip: 'Layer 2 of 3: Silver — its tables, relationships and diagrams',
    });
  });

  it('names a diagram in a layer called tables when tables/ is a layer, not the YAML library', () => {
    const layers = [...LAYERS, { id: 'tables', label: 'Tables', color: '#888' }];
    let isLayer = true;
    const provider = new SemanticFileDecorationProvider(fakeLayerService({ layers }), '.erd-studio', undefined, {
      semanticRoot: '/proj/.erd-studio',
      tablesDirIsLayer: () => isLayer,
    });
    expect(tooltip(provider, '/proj/.erd-studio/tables/orders.json')).toBe('A diagram in the Tables layer');
    isLayer = false;
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/tables/orders.json'))).toBeUndefined();
  });

  it('gives no stage number without a layers.json (the layers are not listed anywhere)', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService({ layers: LAYERS, listed: false }));
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/silver'))).toEqual({
      badge: '≡',
      tooltip: 'The Silver layer — its tables, relationships and diagrams',
    });
  });

  it('explains the tables, schema, relationships and diagrams folders in the sidebar\'s words', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService({ layers: LAYERS }));
    expect(tooltip(provider, '/proj/.erd-studio/gold/tables')).toBe('Tables of the Gold layer, one folder per schema');
    expect(tooltip(provider, '/proj/.erd-studio/gold/tables/sales')).toBe('Schema sales in the Gold layer: each table is declared Table sales.<name>');
    expect(tooltip(provider, '/proj/.erd-studio/gold/relationships')).toBe('Relationships of the Gold layer: each is stored once, with its foreign-key table');
    expect(tooltip(provider, '/proj/.erd-studio/gold/diagrams')).toBe('Diagrams of the Gold layer');
    // Not part of the tree.
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/gold/notes'))).toBeUndefined();
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/templates'))).toBeUndefined();
  });

  it('decorates only files on disk (file: URIs)', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService({ layers: LAYERS }));
    const other = { ...vscode.Uri.file('/proj/.erd-studio/gold'), scheme: 'git' } as unknown as vscode.Uri;
    expect(provider.provideFileDecoration(other)).toBeUndefined();
  });
});

describe('SemanticFileDecorationProvider: counts, read in the background', () => {
  const S = '/proj/.erd-studio';
  const entries: TableFileEntry[] = [
    { name: 'fct_order', folder: 'sales', layer: 'gold', filePath: `${S}/gold/tables/sales/fct_order.dbml`, storage: 'dbml' },
    { name: 'dim_customer', folder: 'crm', layer: 'silver', filePath: `${S}/silver/tables/crm/dim_customer.dbml`, storage: 'dbml' },
    { name: 'dim_date', folder: 'gold', layer: 'gold', filePath: `${S}/gold/tables/gold/dim_date.dbml`, storage: 'dbml' },
    { name: 'stg_order', folder: 'sales', layer: 'gold', filePath: `${S}/gold/tables/sales/stg_order.dbml`, storage: 'dbml' },
  ];
  const MEMBERS: Record<string, string[]> = {
    [`${S}/gold/diagrams/sales.dbml`]: ['fct_order', 'dim_customer', 'dim_date', 'FCT_ORDER'],
    [`${S}/gold/diagrams/finance.dbml`]: ['fct_order'],
  };

  function source(overrides: Partial<ExplorerFactsSource> = {}): ExplorerFactsSource {
    return {
      listTableFiles: () => entries,
      peekAlias: (name) => (name === 'fct_order' ? 'orders' : undefined),
      listDiagrams: () => [
        { filePath: `${S}/gold/diagrams/sales.dbml`, layer: 'gold' },
        { filePath: `${S}/gold/diagrams/finance.dbml`, layer: 'gold' },
        { filePath: `${S}/gold/diagrams/broken.dbml`, layer: 'gold' },
      ],
      diagramMembers: vi.fn((filePath: string) => {
        if (filePath.endsWith('broken.dbml')) throw new Error('unreadable');
        return MEMBERS[filePath] ?? null;
      }),
      listRelationshipsFiles: () => [`${S}/gold/relationships/gold.dbml`],
      relationshipsCount: () => 7,
      ...overrides,
    };
  }

  async function settled(provider: SemanticFileDecorationProvider): Promise<void> {
    await new Promise<void>((resolve) => {
      const sub = provider.onDidChangeFileDecorations(() => { sub.dispose(); resolve(); });
    });
  }

  it('names a table first, then fills in its warehouse name and diagrams once they are read', async () => {
    const src = source();
    const provider = new SemanticFileDecorationProvider(fakeLayerService({ layers: LAYERS }), '.erd-studio', src);
    // Nothing read while VS Code asks: the path alone.
    expect(tooltip(provider, `${S}/gold/tables/sales/fct_order.dbml`)).toBe('sales.fct_order');
    expect(src.diagramMembers).not.toHaveBeenCalled();
    await settled(provider);
    expect(tooltip(provider, `${S}/gold/tables/sales/fct_order.dbml`)).toBe('sales.fct_order (warehouse table orders) — on 2 diagrams');
    expect(tooltip(provider, `${S}/gold/tables/gold/dim_date.dbml`)).toBe('gold.dim_date — on 1 diagram');
    expect(tooltip(provider, `${S}/gold/tables/sales/stg_order.dbml`)).toBe('sales.stg_order — on no diagram');
    provider.dispose();
  });

  it('counts a diagram\'s tables and those from other layers, and a relationships file\'s Refs', async () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService({ layers: LAYERS }), '.erd-studio', source());
    tooltip(provider, `${S}/gold/diagrams/sales.dbml`);
    await settled(provider);
    expect(tooltip(provider, `${S}/gold/diagrams/sales.dbml`)).toBe('A diagram in the Gold layer: 3 tables, 1 from Silver');
    expect(tooltip(provider, `${S}/gold/diagrams/finance.dbml`)).toBe('A diagram in the Gold layer: 1 table');
    // A diagram that cannot be read keeps the plain words.
    expect(tooltip(provider, `${S}/gold/diagrams/broken.dbml`)).toBe('A diagram in the Gold layer');
    expect(tooltip(provider, `${S}/gold/relationships/gold.dbml`)).toBe('Relationships of the Gold layer (7)');
    provider.dispose();
  });

  it('reads the counts again after a refresh, keeping the last ones meanwhile', async () => {
    vi.useFakeTimers();
    try {
      let count = 7;
      const provider = new SemanticFileDecorationProvider(fakeLayerService({ layers: LAYERS }), '.erd-studio', source({ relationshipsCount: () => count }));
      const fired = vi.fn();
      provider.onDidChangeFileDecorations(fired);
      tooltip(provider, `${S}/gold/relationships/gold.dbml`);
      await vi.runAllTimersAsync();
      expect(tooltip(provider, `${S}/gold/relationships/gold.dbml`)).toBe('Relationships of the Gold layer (7)');
      fired.mockClear();

      count = 8;
      provider.refreshFacts();
      // Until the next read is in, the last count stays.
      expect(tooltip(provider, `${S}/gold/relationships/gold.dbml`)).toBe('Relationships of the Gold layer (7)');
      await vi.runAllTimersAsync();
      expect(tooltip(provider, `${S}/gold/relationships/gold.dbml`)).toBe('Relationships of the Gold layer (8)');
      expect(fired).toHaveBeenCalledTimes(1);
      provider.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('yields between tables, so a large library never holds the extension host in one run', async () => {
    vi.useFakeTimers();
    try {
      const many: TableFileEntry[] = Array.from({ length: 50 }, (_, i) => ({
        name: `t${i}`, folder: 'sales', layer: 'gold', filePath: `${S}/gold/tables/sales/t${i}.dbml`, storage: 'dbml' as const,
      }));
      let now = 0;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      // Each table costs 10 ms: a 30 ms slice reads about three before it yields.
      const asked: string[] = [];
      const provider = new SemanticFileDecorationProvider(fakeLayerService({ layers: LAYERS }), '.erd-studio', source({
        listTableFiles: () => many,
        listDiagrams: () => [],
        listRelationshipsFiles: () => [],
        peekAlias: (name) => { asked.push(name); now += 10; return undefined; },
      }));
      tooltip(provider, `${S}/gold/tables/sales/t0.dbml`);
      await vi.advanceTimersByTimeAsync(0);
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.length).toBeLessThan(many.length);
      await vi.runAllTimersAsync();
      expect(asked.length).toBe(many.length);
      clock.mockRestore();
      provider.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads nothing until a decoration needs a count', async () => {
    vi.useFakeTimers();
    try {
      const src = source();
      const provider = new SemanticFileDecorationProvider(fakeLayerService({ layers: LAYERS }), '.erd-studio', src);
      provider.refresh();
      tooltip(provider, `${S}/gold`);
      tooltip(provider, `${S}/gold/tables`);
      await vi.runAllTimersAsync();
      expect(src.diagramMembers).not.toHaveBeenCalled();
      provider.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
