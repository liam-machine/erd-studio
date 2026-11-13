/**
 * The open search box on a narrow editor grows only as far as the centred
 * toolbar row has room for (glass QA: at 786px a focused search pushed the
 * row under the corner pill; at 749px off the left edge).
 */
import { describe, it, expect } from 'vitest';
import { searchRoom, SEARCH_MIN_OPEN_WIDTH } from '../../webview/components/Toolbar/searchRoom';

describe('searchRoom', () => {
  it('grows by twice the right-hand clearance when that is the tighter side', () => {
    // 823px editor: folded 28px search, row 105..718, corner pill at 774.
    expect(searchRoom({ inputWidth: 28, rowLeft: 105, rowRight: 718, rightLimit: 774, gap: 8 })).toBe(28 + 2 * 48);
  });

  it('grows by twice the left-hand clearance when that is the tighter side', () => {
    expect(searchRoom({ inputWidth: 28, rowLeft: 60, rowRight: 500, rightLimit: 900, gap: 8 })).toBe(28 + 2 * 52);
  });

  it('gives the same answer whatever width the input has now, so re-measuring cannot oscillate', () => {
    const folded = searchRoom({ inputWidth: 28, rowLeft: 105, rowRight: 718, rightLimit: 774, gap: 8 });
    // The same row with the input open at that width: each edge moved by half the growth.
    const grow = folded - 28;
    const open = searchRoom({ inputWidth: folded, rowLeft: 105 - grow / 2, rowRight: 718 + grow / 2, rightLimit: 774, gap: 8 });
    expect(open).toBe(folded);
  });

  it('never goes below a width worth typing into', () => {
    expect(searchRoom({ inputWidth: 28, rowLeft: 50, rowRight: 662, rightLimit: 663, gap: 8 })).toBe(SEARCH_MIN_OPEN_WIDTH);
  });
});
