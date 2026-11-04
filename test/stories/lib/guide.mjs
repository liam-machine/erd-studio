// The onboarding guide's coach marks (Show Me Around) for the stories that walk
// through it (28–30): the callout on show, its buttons, and a check that it
// sits beside what it points at without covering it.
// See src/types/onboardingGuide.ts and webview/components/Guide/CoachMark.tsx.

/** The coach mark on show: `{ title, text, progress, side, buttons, box, ring }`, or null. */
export const MARK = `(() => { const m=doc.querySelector('.guide-mark'); if (!m) return null;
  const rect = (el) => { if (!el || el.hidden) return null; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; };
  return { title: m.querySelector('.guide-mark__title')?.textContent.trim(), text: m.querySelector('.guide-mark__text')?.textContent.trim(),
    progress: m.querySelector('.guide-mark__progress')?.textContent.trim(), side: m.getAttribute('data-side'),
    buttons: [...m.querySelectorAll('button')].map(b => b.textContent.trim()),
    box: rect(m), ring: rect(doc.querySelector('.guide-ring')), page: { width: innerWidth, height: innerHeight } }; })()`;

/** A control a step points at, by its `data-guide` id (`GUIDE_TARGETS`: draft-keep, draft-more, canvas-stages, …). */
export const GUIDE_TARGET = (id) => `doc.querySelector('[data-guide=${JSON.stringify(id)}]')`;

/** A button of the coach mark, by its label. */
export const markButton = (label) => `[...doc.querySelectorAll('.guide-mark button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;

const overlaps = (a, b) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

/**
 * Wait for the coach mark titled `title` on `page` (a draft or the canvas)
 * and check it is legible where it is: wholly on the page, and (anchored)
 * clear of the ring around what it points at. Resolves its state.
 */
export async function waitForMark(s, page, title, { progress } = {}) {
  // Wait for the callout to settle (it re-anchors every frame): the same box twice.
  let last;
  const mark = await s.eventually(async () => {
    const m = await page.ev(`(() => { const m=${MARK}; return m && m.title === ${JSON.stringify(title)} ? m : null; })()`);
    if (!m || !m.box) { last = undefined; return null; }
    const same = last && JSON.stringify(last.box) === JSON.stringify(m.box) && JSON.stringify(last.ring) === JSON.stringify(m.ring);
    last = m;
    return same ? m : null;
  }, { timeout: 20000, interval: 200, message: `the "${title}" coach mark never showed (and settled)` });
  const { box, ring, page: vp } = mark;
  s.expect(box.left >= 0 && box.top >= 0 && box.left + box.width <= vp.width + 1 && box.top + box.height <= vp.height + 1,
    `the "${title}" callout should be wholly on the page: ${JSON.stringify(box)} in ${vp.width}×${vp.height}`);
  if (mark.side !== 'centre' && ring) {
    s.expect(!overlaps(box, ring), `the "${title}" callout (${mark.side}) covers what it points at: ${JSON.stringify(box)} over ${JSON.stringify(ring)}`);
  }
  if (progress !== undefined) s.assert.equal(mark.progress, progress, `the "${title}" step's progress`);
  return mark;
}

/**
 * Rest the cursor on an empty patch of the canvas (no table, line, callout or
 * toolbar under it). When the finish closes, the cursor left on Star on
 * GitHub lands on a table's column and opens its hover card (dimming the rest);
 * a move within the canvas clears it (nudged again until it has).
 */
export async function restOnEmptyCanvas(s, page) {
  const PANE = `doc.querySelector('.react-flow__pane')`;
  const spot = await page.ev(`(() => { const pane=${PANE}; if (!pane) return null; const r=pane.getBoundingClientRect();
    for (let fy = 0.15; fy < 0.95; fy += 0.08) for (let fx = 0.04; fx < 0.9; fx += 0.06) {
      const x = r.left + r.width * fx, y = r.top + r.height * fy; const el = doc.elementFromPoint(x, y);
      if (el && !el.closest('.react-flow__node, .react-flow__edge, .react-flow__minimap, .react-flow__panel, .guide-mark, .toolbar-container, .toolbar__corner, button')) return { dx: x - r.left, dy: y - r.top };
    }
    return null; })()`);
  const pane = spot && await page.rect(PANE);
  if (!pane) return;
  const p = { x: pane.x + spot.dx, y: pane.y + spot.dy };
  await s.wb.moveToPoint(p);
  // A move into the webview (an out-of-process frame) is sometimes lost, as a click is: nudge until the hover has cleared.
  const hovered = `!!doc.querySelector('.erd-flow--hover-focus, [class*="model-node--focus-"], .column-tooltip--visible')`;
  for (let i = 1; i <= 8 && await page.ev(hovered).catch(() => false); i++) {
    await s.wb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + i * 3, y: p.y + i * 2 });
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Press a coach mark button and wait for the next callout. The cursor then
 * rests on the new callout's title, as the eye follows it: left where the
 * old Next was, it could sit over a table and open its column hover card.
 */
export async function nextMark(s, page, title, { button = 'Next', progress } = {}) {
  await page.click(markButton(button));
  const mark = await waitForMark(s, page, title, { progress });
  const p = await page.center(`doc.querySelector('.guide-mark__title')`);
  if (p) await s.wb.moveToPoint(p);
  return mark;
}
