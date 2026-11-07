/**
 * How the canvas draws relationship lines: the `erdStudio.canvas.lineStyle`
 * setting, a reader's view preference (never a project file). Shared by the
 * host and the webview. `@erd-studio/renderer`'s `LineStyle` names the same
 * two styles (`test/unit/lineStyleSetting.test.ts` holds the lists equal);
 * this copy keeps the host free of the renderer.
 *
 * - `curved` (default): lines go around tables with soft curves, a halo where
 *   two cross, and a faint dashed "x-ray" where one has to pass under a table.
 * - `hops`: square lines that go around tables, with a small hop where two
 *   lines cross.
 */

export type CanvasLineStyle = 'curved' | 'hops';

/** Every style, in the toolbar's order. */
export const CANVAS_LINE_STYLES: readonly CanvasLineStyle[] = ['curved', 'hops'];

export const DEFAULT_CANVAS_LINE_STYLE: CanvasLineStyle = 'curved';

/** The setting's key under `erdStudio.` (read through `getErdStudioSetting`). */
export const LINE_STYLE_SETTING = 'canvas.lineStyle';

export function isCanvasLineStyle(value: unknown): value is CanvasLineStyle {
  return value === 'curved' || value === 'hops';
}
