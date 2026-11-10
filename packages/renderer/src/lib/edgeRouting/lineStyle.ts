/**
 * Edge routing — the two line styles a reader chooses between. Type imports
 * only, so the store entry (`@erd-studio/renderer/store`) can name them
 * without loading the router.
 */

import type { LineStyleOptions } from './types';

/** The reader's choice of line style (the editor's toolbar, `ErdCanvas`'s `lineStyle` prop). */
export type LineStyle = 'curved' | 'hops';

/** Every line style, in toolbar order. */
export const LINE_STYLES: readonly LineStyle[] = ['curved', 'hops'];

export const DEFAULT_LINE_STYLE: LineStyle = 'curved';

export function isLineStyle(value: unknown): value is LineStyle {
  return value === 'curved' || value === 'hops';
}

/** What each line style draws. Internal: readers pick a style, never these knobs. */
export const LINE_STYLE_OPTIONS: Readonly<Record<LineStyle, LineStyleOptions>> = {
  curved: { crossings: 'halo', underTables: 'xray', corners: 'curved' },
  hops: { crossings: 'hops', underTables: 'hidden', corners: 'rounded' },
};

/** The options of a style; anything that is not a style reads as the default. */
export function lineStyleOptions(style: unknown): LineStyleOptions {
  return LINE_STYLE_OPTIONS[isLineStyle(style) ? style : DEFAULT_LINE_STYLE];
}
