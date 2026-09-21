// @vitest-environment jsdom
/**
 * Legend — the panel that decodes the canvas.
 *
 * The legend's whole job is to stay true to what the canvas draws, and it is
 * the file nobody remembers to edit when a badge changes. These tests pin it to
 * `lib/badgeLabels`, the maps ModelNode renders from, so a new provenance
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

vi.mock('../../webview/store/editorStore', () => ({
  useEditorStore: (selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

import { Legend } from '../../webview/components/Legend/Legend';
import {
  SOURCE_LABEL,
  SOURCE_LEGEND_DESC,
  SOURCE_ORDER,
  SCD_BADGE,
  SCD_TITLE,
  ADDITIVE_BADGE,
  ADDITIVE_TITLE,
} from '../../webview/lib/badgeLabels';

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

  it('explains the schema abbreviation that shares the header row', () => {
    const { container } = render(<Legend />);
    const section = container.querySelector('.legend__section:has(.legend__items--sources)')!;
    expect(section.textContent).toContain('Database schema');
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

  it('explains the comparison colours, which had no entry at all', () => {
    const { container } = render(<Legend />);
    const section = container.querySelector('.legend__section:has(.legend__swatch)')!;

    expect(section.querySelector('.legend__swatch--extra')).not.toBeNull();
    expect(section.querySelector('.legend__swatch--mismatch')).not.toBeNull();
    expect(section.querySelector('.legend__swatch--missing')).not.toBeNull();
    expect(section.querySelectorAll('.legend__edge--disc-extra, .legend__edge--disc-missing, .legend__edge--disc-mismatch').length).toBe(3);
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
