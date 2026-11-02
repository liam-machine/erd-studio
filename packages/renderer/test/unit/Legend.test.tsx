// @vitest-environment jsdom
/**
 * Legend — the panel that decodes the canvas.
 *
 * The legend's whole job is to stay true to what the canvas draws, and it is
 * the file nobody remembers to edit when a badge changes. These tests pin it to
 * `lib/badgeLabels`, the maps TableNode renders from, so a new provenance
 * source or a renamed chip fails here rather than shipping a legend that
 * quietly explains the wrong thing.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type React from 'react';

vi.mock('@xyflow/react', () => ({
  Panel: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

const mockStoreState: Record<string, unknown> = {
  legendOpen: true,
  setLegendOpen: vi.fn(),
};

vi.mock('../../src/store/editorStore', () => ({
  useEditorStore: (selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

import { Legend } from '../../src/components/Legend/Legend';
import {
  SOURCE_LABEL,
  SOURCE_LEGEND_DESC,
  SOURCE_ORDER,
  SCD_BADGE,
  SCD_TITLE,
  ADDITIVE_BADGE,
  ADDITIVE_TITLE,
} from '../../src/lib/badgeLabels';

describe('Legend — physical provenance chips', () => {
  it('lists every provenance source, so WH and YML are no longer unexplained', () => {
    const { container } = render(<Legend />);
    const rows = container.querySelectorAll('.legend__items--sources .legend__item');

    expect(rows.length).toBe(SOURCE_ORDER.length);
    SOURCE_ORDER.forEach((source, i) => {
      const row = rows[i] as HTMLElement;
      expect(within(row).getByText(SOURCE_LABEL[source])).toBeTruthy();
      expect(row.textContent).toContain(SOURCE_LEGEND_DESC[source]);
    });
  });

  it('covers every source the label map defines — a new one cannot be forgotten', () => {
    expect([...SOURCE_ORDER].sort()).toEqual(Object.keys(SOURCE_LABEL).sort());
  });

  it('gives the warehouse chip the same colour modifier the node gives it', () => {
    const { container } = render(<Legend />);
    const wh = screen.getAllByText(SOURCE_LABEL.catalog)[0];
    expect(wh.className).toContain('legend__badge--source-catalog');

    // ...and the declared-by-hand sources do not get it.
    const yml = container.querySelector('.legend__badge--source-yml')!;
    expect(yml.className).not.toContain('legend__badge--source-catalog');
  });

  it('explains the layer badge and the schema prefix that share the header row', () => {
    const { container } = render(<Legend />);
    const section = container.querySelector('.legend__section:has(.legend__items--sources)')!;
    expect(section.textContent).toContain('The layer the table lives in');
    expect(section.textContent).not.toContain('Database schema');
    expect(section.querySelector('.legend__schema-sample')!.textContent).toBe('sales.');
  });
});

describe('Legend — column symbols', () => {
  it('shows all three SCD badges, each hoverable with its own meaning', () => {
    const { container } = render(<Legend />);
    const symbols = container.querySelectorAll('.legend__symbols--scd > span');

    expect(Array.from(symbols).map((s) => s.textContent)).toEqual([
      SCD_BADGE[0], SCD_BADGE[1], SCD_BADGE[2],
    ]);
    expect(Array.from(symbols).map((s) => s.getAttribute('title'))).toEqual([
      SCD_TITLE[0], SCD_TITLE[1], SCD_TITLE[2],
    ]);
  });

  it('shows every additive symbol with its own meaning', () => {
    const { container } = render(<Legend />);
    const symbols = container.querySelectorAll('.legend__symbols--additive > span');
    const keys = Object.keys(ADDITIVE_BADGE);

    expect(symbols.length).toBe(keys.length);
    expect(Array.from(symbols).map((s) => s.textContent)).toEqual(keys.map((k) => ADDITIVE_BADGE[k]));
    expect(Array.from(symbols).map((s) => s.getAttribute('title'))).toEqual(keys.map((k) => ADDITIVE_TITLE[k]));
  });

  it('keeps the key badges it already explained', () => {
    const { container } = render(<Legend />);
    const text = container.querySelector('.legend__content')!.textContent!;
    for (const label of ['PK', 'FK', 'NK', 'Logical', 'Physical', 'Ghost', 'Many-to-one']) {
      expect(text).toContain(label);
    }
  });
});

describe('Legend — stages, cardinality and comparison', () => {
  it('tells the two ghosts apart, as the canvas does with dashed vs dotted', () => {
    const { container } = render(<Legend />);

    expect(container.querySelector('.legend__model-card--ghost-disabled')).not.toBeNull();
    const text = container.querySelector('.legend__content')!.textContent!;
    expect(text).toContain('Not found in your dbt project');
    expect(text).toContain('Disabled in dbt');
  });

  it('covers all four cardinalities the canvas can draw, including one-to-many', () => {
    const { container } = render(<Legend />);
    const rows = container.querySelectorAll('.legend__items--cardinality .legend__item');

    expect(Array.from(rows).map((r) => r.querySelector('.legend__item-desc')!.textContent)).toEqual([
      'Many-to-one', 'One-to-one', 'One-to-many', 'Many-to-many',
    ]);
  });

  it('samples the line colour for both stages, not just the logical blue', () => {
    const { container } = render(<Legend />);
    const section = container.querySelector('.legend__section:has(.legend__items--cardinality)')!;

    expect(section.querySelector('.legend__edge--physical')).not.toBeNull();
    expect(section.querySelector('.legend__edge--logical')).not.toBeNull();
  });

  it('names the comparison controls as the toolbar labels them (there is no "Diff" button any more)', () => {
    const { container } = render(<Legend />);
    const text = container.querySelector('.legend__content')!.textContent!;
    expect(text).toContain('Shown while a comparison is open (Compare with dbt or Compare with design).');
    expect(text).not.toContain('(Diff)');
  });

  it('explains the comparison colours, which had no entry at all', () => {
    const { container } = render(<Legend />);
    const section = container.querySelector('.legend__section:has(.legend__swatch)')!;

    expect(section.querySelector('.legend__swatch--extra')).not.toBeNull();
    expect(section.querySelector('.legend__swatch--mismatch')).not.toBeNull();
    expect(section.querySelector('.legend__swatch--missing')).not.toBeNull();
    expect(section.querySelectorAll('.legend__edge--disc-extra, .legend__edge--disc-missing, .legend__edge--disc-mismatch').length).toBe(3);
  });
});

describe('Legend — relationship flow', () => {
  it('explains the moving arrows with the canvas\'s own glyphs: one-way, many-to-many, one-to-one', () => {
    const { container } = render(<Legend />);
    const rows = container.querySelectorAll('.legend__items--flow .legend__item');
    expect(Array.from(rows).map((r) => r.querySelector('.legend__item-desc')!.textContent)).toEqual([
      'Arrows run 1 → *',
      'Both ways: many-to-many',
      'Dots meet: one-to-one',
    ]);
    // Each sample sits between the same 1 / * end labels as the cardinality rows.
    expect(Array.from(rows).map((r) => Array.from(r.querySelectorAll('.legend__cardinality-label')).map((l) => l.textContent).join(' ')))
      .toEqual(['1 *', '* *', '1 1']);
    for (const row of rows) expect(row.querySelector('.fk-edge__flow')).not.toBeNull();
    expect(rows[2].querySelectorAll('.fk-edge__flow-dot')).toHaveLength(2);
    expect(container.querySelector('.legend__items--flow [repeatCount="indefinite"]')).not.toBeNull();
  });

  it('stands the arrows still under the reduce-motion setting', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'), media: query,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    try {
      const { container } = render(<Legend />);
      const flows = container.querySelectorAll('.legend__items--flow .fk-edge__flow');
      expect(flows).toHaveLength(3);
      expect(container.querySelector('[repeatCount="indefinite"]')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Legend — collapsed', () => {
  it('renders only the toggle when closed', () => {
    mockStoreState.legendOpen = false;
    const { container } = render(<Legend />);
    expect(container.querySelector('.legend__content')).toBeNull();
    expect(container.querySelector('.legend-toggle__button')).not.toBeNull();
    mockStoreState.legendOpen = true;
  });
});

describe('Legend — notes', () => {
  it('calls them notes, as the toolbar and context menu do', () => {
    const { container } = render(<Legend />);
    const text = container.querySelector('.legend__content')!.textContent!;
    expect(text).toContain('Notes');
    expect(text).not.toContain('Build Note');
    expect(text).not.toContain('Annotations');
  });
});

describe('Legend — a project without dbt (logicalOnly)', () => {
  function renderLogicalOnly() {
    mockStoreState.logicalOnly = true;
    try {
      return render(<Legend />);
    } finally {
      mockStoreState.logicalOnly = undefined;
    }
  }

  it('leaves out the Physical stage, the ghosts, the provenance chips and the comparison colours', () => {
    const { container } = renderLogicalOnly();
    const text = container.querySelector('.legend__content')!.textContent!;

    expect(text).toContain('Logical');
    expect(container.querySelector('.legend__model-card--physical')).toBeNull();
    expect(container.querySelector('.legend__model-card--ghost')).toBeNull();
    expect(container.querySelector('.legend__items--sources')).toBeNull();
    expect(container.querySelector('.legend__edge--physical')).toBeNull();
    expect(container.querySelector('.legend__swatch')).toBeNull();
    expect(text).not.toContain('dbt');
  });

  it('still explains the layer badge, the cardinalities and the column badges', () => {
    const { container } = renderLogicalOnly();
    const text = container.querySelector('.legend__content')!.textContent!;
    expect(text).toContain('The layer the table lives in');
    expect(container.querySelectorAll('.legend__items--cardinality .legend__item')).toHaveLength(4);
    for (const label of ['PK', 'FK', 'NK']) expect(text).toContain(label);
  });

  it('keeps every entry with dbt, as before', () => {
    const { container } = render(<Legend />);
    expect(container.querySelector('.legend__model-card--physical')).not.toBeNull();
    expect(container.querySelector('.legend__items--sources')).not.toBeNull();
    expect(container.querySelector('.legend__swatch')).not.toBeNull();
  });
});

describe('Legend — a single-layer project', () => {
  const ONLY = { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', order: 0, creatable: true };

  it('leaves out the layer badge the canvas does not draw, and keeps the schema prefix', () => {
    mockStoreState.domain = { layer: 'silver', layerConfigs: [ONLY], models: [{ name: 'a', layer: 'silver' }] };
    try {
      const { container } = render(<Legend />);
      expect(container.querySelector('.legend__badge--layer')).toBeNull();
      expect(container.querySelector('.legend__schema-sample')).not.toBeNull();
    } finally {
      mockStoreState.domain = undefined;
    }
  });

  it('shows the layer badge when the domain lists no layers (an older core)', () => {
    mockStoreState.domain = { layer: 'silver', models: [{ name: 'a' }] };
    try {
      const { container } = render(<Legend />);
      expect(container.querySelector('.legend__badge--layer')).not.toBeNull();
    } finally {
      mockStoreState.domain = undefined;
    }
  });
});
