/**
 * How wide the search box may grow when it opens, on a narrow editor.
 *
 * The toolbar row is centred, so when the search input widens by `d` the row's
 * left edge moves `d / 2` left and its right edge `d / 2` right. The input may
 * therefore grow by twice the smaller of the two clearances: to the corner pill
 * on the right and to the editor's left edge. The answer is the same whatever
 * width the input has right now (its growth is already counted in both
 * clearances), so measuring it again after it is applied gives the same value
 * and cannot oscillate.
 */
export interface SearchRoomGeometry {
  /** The search input's current width. */
  inputWidth: number;
  /** The toolbar row's left and right edges. */
  rowLeft: number;
  rowRight: number;
  /** The corner pill's left edge, or the editor width when there is none. */
  rightLimit: number;
  /** Clearance kept from the corner pill and the left edge. */
  gap: number;
}

/** The narrowest open search box that is still worth typing into. */
export const SEARCH_MIN_OPEN_WIDTH = 96;

export function searchRoom(g: SearchRoomGeometry): number {
  const right = g.rightLimit - g.gap - g.rowRight;
  const left = g.rowLeft - g.gap;
  return Math.max(SEARCH_MIN_OPEN_WIDTH, Math.floor(g.inputWidth + 2 * Math.min(right, left)));
}
