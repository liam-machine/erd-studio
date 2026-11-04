/**
 * The ELK options of the canvas's auto layout, in one place: the toolbar's
 * Layout button, Shift+L and the first-open layout (`useFirstOpenAutoLayout`)
 * build them here from the layout popover's choices, and the draft preview
 * (`webview-draft/lib/draftLayout.ts`) builds them from the same defaults, so
 * a draft is laid out exactly as the canvas lays out the diagram Keep makes
 * when it first opens (docs/dev/draft-first.md §2.5).
 *
 * Pure: no elkjs, no React, no VS Code API.
 */

import { SPACING_PRESETS, detectLayerBound, type LayoutDirection, type PartitionStrategy, type SpacingPreset } from './elkLayout';
import type { LayoutOptions } from '../../src/types/semantic';

/** The layout popover's choices. */
export interface LayoutChoices {
  partitionStrategy: PartitionStrategy;
  /** Max tables per column (row, top to bottom); only used when the strategy is not `auto`. */
  layerBound: number;
  direction: LayoutDirection;
  spacing: SpacingPreset;
}

/**
 * The popover's starting choices, which the first-open layout always uses
 * (it runs before anyone can open the popover).
 */
export const FIRST_OPEN_LAYOUT: Readonly<LayoutChoices> = Object.freeze({
  partitionStrategy: 'auto',
  layerBound: 5,
  direction: 'RIGHT',
  spacing: 'M',
});

/**
 * The options `runElkLayout` gets: the diagram's own `viewConfig.layoutOptions`,
 * then the direction, the spacing preset and the layer bound (√n for `auto`).
 */
export function buildLayoutOptions(
  choices: LayoutChoices,
  tableCount: number,
  diagramOptions?: LayoutOptions,
): LayoutOptions {
  const bound = choices.partitionStrategy === 'auto' ? detectLayerBound(tableCount) : choices.layerBound;
  return {
    ...diagramOptions,
    'elk.direction': choices.direction,
    ...SPACING_PRESETS[choices.spacing],
    'elk.layered.layering.coffmanGraham.layerBound': String(bound),
  };
}

/** The first-open layout's options for a diagram of `tableCount` tables. */
export function firstOpenLayoutOptions(tableCount: number, diagramOptions?: LayoutOptions): LayoutOptions {
  return buildLayoutOptions(FIRST_OPEN_LAYOUT, tableCount, diagramOptions);
}
