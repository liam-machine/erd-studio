/**
 * Where a coach mark's callout goes (pure): beside its anchor, on the first
 * side it fits, clamped into the page; a centred card when there is no
 * anchor, or the anchor is out of view. Shared by the canvas's guide and the
 * draft page's (`webview-draft/` imports it).
 */

export interface GuideRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GuideSize {
  width: number;
  height: number;
}

export type CalloutSide = 'below' | 'above' | 'right' | 'left' | 'centre';

export interface CalloutPlacement {
  side: CalloutSide;
  /** The callout's top-left corner (CSS pixels, viewport). */
  x: number;
  y: number;
  /** Where the arrow sits along the callout's edge facing the anchor (px from its start). */
  arrow: number;
  /** The highlight ring around the anchor; absent for a centred card. */
  ring?: GuideRect;
}

export interface PlaceOptions {
  /** Space between the anchor and the callout. */
  gap?: number;
  /** Space kept from the page's edges. */
  margin?: number;
  /** Try this side first (the sidebar step points left from the canvas's edge: `right`). */
  prefer?: Exclude<CalloutSide, 'centre'>;
  /**
   * Areas the callout must not cover (the draft's banner, the canvas's
   * toolbar): a side that would is moved clear of them, and counts as fitting
   * only if it still fits the page.
   */
  avoid?: readonly GuideRect[];
}

function overlaps(a: GuideRect, b: GuideRect): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

const RING_PAD = 4;
const ARROW_INSET = 16;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));

/** A rect that draws nothing, or lies wholly outside the page, is no anchor. */
export function isUsableAnchor(rect: GuideRect | null | undefined, viewport: GuideSize): rect is GuideRect {
  if (!rect) return false;
  if (rect.width <= 0 && rect.height <= 0) return false;
  return rect.left + rect.width > 0 && rect.top + rect.height > 0 && rect.left < viewport.width && rect.top < viewport.height;
}

/**
 * The anchor among a step's targets (their rects, in the step's order): the
 * first one in view, so a control scrolled or clipped out of a narrow editor
 * (the toolbar's + Add) gives way to the next (Layout) rather than turning
 * the callout into a centred card; else the first that draws anything (the
 * caller centres it); else null.
 */
export function pickAnchor(rects: ReadonlyArray<GuideRect | null | undefined>, viewport: GuideSize): GuideRect | null {
  const drawn = rects.filter((r): r is GuideRect => !!r && (r.width > 0 || r.height > 0));
  return drawn.find((r) => isUsableAnchor(r, viewport)) ?? drawn[0] ?? null;
}

export function placeCallout(anchor: GuideRect | null | undefined, size: GuideSize, viewport: GuideSize, options: PlaceOptions = {}): CalloutPlacement {
  const gap = options.gap ?? 12;
  const margin = options.margin ?? 8;
  const maxX = viewport.width - size.width - margin;
  const maxY = viewport.height - size.height - margin;
  if (!isUsableAnchor(anchor, viewport)) {
    return {
      side: 'centre',
      x: Math.max(margin, Math.round((viewport.width - size.width) / 2)),
      y: Math.max(margin, Math.round((viewport.height - size.height) / 2)),
      arrow: 0,
    };
  }
  const a = anchor;
  const cx = a.left + a.width / 2;
  const cy = a.top + a.height / 2;
  const candidates: Record<Exclude<CalloutSide, 'centre'>, { x: number; y: number; fits: boolean }> = {
    below: { x: cx - size.width / 2, y: a.top + a.height + gap, fits: a.top + a.height + gap + size.height <= viewport.height - margin },
    above: { x: cx - size.width / 2, y: a.top - gap - size.height, fits: a.top - gap - size.height >= margin },
    right: { x: a.left + a.width + gap, y: cy - size.height / 2, fits: a.left + a.width + gap + size.width <= viewport.width - margin },
    left: { x: a.left - gap - size.width, y: cy - size.height / 2, fits: a.left - gap - size.width >= margin },
  };
  const order: Array<Exclude<CalloutSide, 'centre'>> = options.prefer === 'right'
    ? ['right', 'below', 'above', 'left']
    : options.prefer === 'left'
      ? ['left', 'below', 'above', 'right']
      : options.prefer === 'above'
        ? ['above', 'below', 'right', 'left']
        : ['below', 'above', 'right', 'left'];
  // Move each side clear of the areas to avoid, then check it still fits the page.
  for (const s of order) {
    const c = candidates[s];
    for (const area of options.avoid ?? []) {
      const box = { left: c.x, top: c.y, width: size.width, height: size.height };
      if (!overlaps(box, area)) continue;
      if (s === 'below') c.y = Math.max(c.y, area.top + area.height + gap);
      else if (s === 'above') c.y = Math.min(c.y, area.top - gap - size.height);
      else if (s === 'right') c.x = Math.max(c.x, area.left + area.width + gap);
      else c.x = Math.min(c.x, area.left - gap - size.width);
    }
    // Fits along its own axis (the other is clamped below), and clear of every area once clamped.
    const alongAxis = s === 'below' || s === 'above'
      ? c.y >= margin && c.y + size.height <= viewport.height - margin
      : c.x >= margin && c.x + size.width <= viewport.width - margin;
    const clamped = { left: clamp(c.x, margin, maxX), top: clamp(c.y, margin, maxY), width: size.width, height: size.height };
    c.fits = c.fits && alongAxis && !(options.avoid ?? []).some((area) => overlaps(clamped, area));
  }
  const side = order.find((s) => candidates[s].fits) ?? order[0];
  const x = Math.round(clamp(candidates[side].x, margin, maxX));
  const y = Math.round(clamp(candidates[side].y, margin, maxY));
  const arrow = side === 'below' || side === 'above'
    ? Math.round(clamp(cx - x, ARROW_INSET, size.width - ARROW_INSET))
    : Math.round(clamp(cy - y, ARROW_INSET, size.height - ARROW_INSET));
  return {
    side,
    x,
    y,
    arrow,
    ring: { left: a.left - RING_PAD, top: a.top - RING_PAD, width: a.width + RING_PAD * 2, height: a.height + RING_PAD * 2 },
  };
}
