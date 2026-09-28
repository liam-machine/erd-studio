// simple/catch — the real ERD Studio canvas and its real toolbar, explained in plain words.
// Plain callouts hang off the real tabs: "Logical" is "the map", "Physical" is "what's actually
// built". On "really built" the canvas flips to Physical (green, read-only); on "stops matching"
// the built side renames `total` to `order_amount`; on "lights up" a click turns Diff amber and
// the node shows the difference exactly the way the real ModelNode draws it (amber "ONLY HERE"
// row, dashed "ONLY IN LOGICAL" separator, struck ghost row "LOGICAL ONLY"), labelled in plain
// words ("in the code" / "on the map"). Then a green "caught early" note.
import { COLORS, ICON, SIMPLE, appIcon, appear, card, easeInOut, easeOut, lerp, node, path, pointer, seg, toolbar } from '../../lib.js';

// Canvas card.
const CX = 64, CY = 300, CW = 952, CH = 700;          // y 300..1000
// The real toolbar, scaled up for the phone (origin top-left).
const TBS = 1.2, TBX = CX + 28, TBY = CY + 64 + 18;
// Tab / button centres in frame px (measured from the rendered toolbar at TBS).
const TAB_LOG = 360, TAB_PHY = 519, DIFF_BTN = { x: 687, y: 421 };
const TB_BOTTOM = 462;
// The orders node.
const NX = 84, NY = 618, NW = 560, NS = 1.1;           // drawn at 1.1x from (NX, NY)
const ROW0 = 62 + 42;                                 // first row top in node px (after head + grain)
const NRIGHT = NX + NW * NS;

const D = SIMPLE.drift;
const hump = (t, a, up, down) => (t < a ? 0 : t < a + up ? seg(t, a, a + up) : 1 - seg(t, a + up, a + up + down));

/** A plain-language callout chip hanging under a toolbar tab by a thin leader line. */
function tabCallout({ x, side, y, label, color, bg, border, t, at }) {
  const p = easeOut(seg(t, at, at + 0.35));
  if (p <= 0) return '';
  const lineH = (y - TB_BOTTOM - 6) * p;
  const chip = side === 'left'
    ? `right:${1080 - x - 36}px;` : `left:${x - 36}px;`;
  return `<div class="abs" style="left:${x - 1.5}px;top:${TB_BOTTOM + 6}px;width:3px;height:${lineH.toFixed(1)}px;background:${color};border-radius:2px;opacity:${p.toFixed(3)}"></div>
    <div class="abs" style="left:${x - 6}px;top:${TB_BOTTOM + 2}px;width:12px;height:12px;border-radius:50%;background:${color};opacity:${p.toFixed(3)}"></div>
    <div class="abs" style="${chip}top:${y}px;${appear(t, at + 0.12, { dy: 10 })}">
      <span class="pill" style="font-size:30px;padding:10px 24px;background:${bg};border:2px solid ${border};color:${color};font-weight:800">${label}</span></div>`;
}

/** Plain side label with a leader pointing left at a node row. */
function rowLabel({ y, label, sub, color, bg, border, t, at }) {
  const p = easeOut(seg(t, at, at + 0.35));
  if (p <= 0) return '';
  const x0 = NRIGHT + 8, x1 = NRIGHT + 44;
  return `<div class="abs" style="left:${x0}px;top:${y - 1.5}px;width:${((x1 - x0) * p).toFixed(1)}px;height:3px;background:${color};border-radius:2px;opacity:${p.toFixed(3)}"></div>
    <div class="abs" style="left:${x1}px;top:${y - 36}px;height:72px;display:flex;align-items:center;gap:14px;padding:0 22px;border-radius:16px;background:${bg};border:2px solid ${border};white-space:nowrap;${appear(t, at + 0.05, { dx: -14, dy: 0 })}">
      <div style="display:flex;flex-direction:column;line-height:1.1"><span style="font-size:30px;font-weight:800;color:${color}">${label}</span>${sub ? `<span style="font-size:22px;color:var(--text-2);margin-top:3px">${sub}</span>` : ''}</div></div>`;
}

export default {
  render(t, { beats }) {
    const S = beats.stops.t, L = beats.lights.t;
    const mapAt = 0.2;               // the scene opens on the map: "Logical" → "the map"
    const builtAt = S + 0.55;        // clip 0.6–1.0 s → "…really built"
    const flip = S + 0.75;           // the canvas flips to Physical on "built"
    const renameAt = S + 1.15;       // clip 1.07 s → "stops matching the map"
    const click = L + 0.08;          // clip 0.0–0.47 s → "it lights up"
    const diffOn = t >= click;
    const lit = L + 0.15;            // difference rows light up
    const labelsAt = L + 0.6;        // clip 0.54 s → "the difference"
    const earlyAt = L + 1.4;         // clip 1.35 s → "before it causes problems"

    const p = easeInOut(seg(t, flip, flip + 0.55));   // logical → physical blend
    const physical = t >= flip + 0.1;

    let html = card({ x: CX, y: CY, w: CW, h: CH, tabs: [{ label: 'ERD Studio', on: true, icon: appIcon(30, 'box-shadow:none;border-radius:7px') }], bodyCls: 'grid-bg' });   // same window as simple/picture
    html += `<div class="abs" style="left:0;top:0;transform-origin:${TBX}px ${TBY}px;transform:scale(${TBS})">${toolbar({ x: TBX, y: TBY, domain: 'orders', layer: 'SLV', stage: physical ? 'physical' : 'logical', diff: diffOn ? 'amber' : 'off' })}</div>`;
    // Diff button pulse as it turns amber.
    const dp = hump(t, click, 0.15, 0.6);
    if (dp > 0) {
      html += `<div class="abs" style="left:${DIFF_BTN.x - 68 - 14 * dp}px;top:${DIFF_BTN.y - 33 - 10 * dp}px;width:${136 + 28 * dp}px;height:${66 + 20 * dp}px;border-radius:16px;border:3px solid rgba(244,180,44,${(0.8 * dp).toFixed(2)})"></div>`;
    }

    // "1 difference" count, right of the toolbar.
    if (t >= lit) {
      const pop = 1 + 0.08 * hump(t, lit, 0.12, 0.3);
      html += `<span class="abs pill" style="left:778px;top:${TBY + 15}px;font-size:26px;padding:9px 16px;background:var(--amber-row);color:var(--amber);border:2px solid #6b5420;transform:scale(${pop.toFixed(3)});transform-origin:0 50%;${appear(t, lit, { dy: 6 })}">${ICON.warn({ size: 24 })}1 difference</span>`;
    }

    // Plain callouts on the real tabs.
    html += tabCallout({ x: TAB_LOG, side: 'left', y: 505, label: 'the map', color: COLORS.logical, bg: '#1b2a40', border: '#2d4a70', t, at: mapAt });
    html += tabCallout({ x: TAB_PHY, side: 'right', y: 505, label: "what's actually built", color: COLORS.green, bg: '#13301f', border: '#1f5a35', t, at: builtAt });

    // ---- the orders node ----
    const renP = easeOut(seg(t, renameAt, renameAt + 0.4));
    const renFlash = hump(t, renameAt, 0.1, 0.6);
    const litP = easeOut(seg(t, lit, lit + 0.35));
    const glow = hump(t, lit, 0.2, 0.9);
    const cols = [
      { name: 'order_id', type: 'INT' },
      { name: 'customer_id', type: 'INT' },
    ];
    if (t < renameAt) {
      cols.push({ name: D.map, type: 'DECIMAL(12,2)' });
    } else {
      // The built side renames the field; before Diff it is just a quiet change.
      const bg = diffOn
        ? `background:rgba(${Math.round(lerp(56, 96, glow))},${Math.round(lerp(46, 74, glow))},${Math.round(lerp(22, 26, glow))},${litP.toFixed(3)});box-shadow:inset 5px 0 0 rgba(244,180,44,${litP.toFixed(3)});`
        : `background:rgba(255,255,255,${(0.08 * renFlash).toFixed(3)});`;
      cols.push({
        name: `<span style="opacity:${lerp(0.2, 1, renP).toFixed(3)}">${D.built}</span>`, type: 'DECIMAL(12,2)', rowStyle: bg,
        pill: diffOn ? `<span style="font-size:16px;font-weight:700;letter-spacing:.04em;padding:3px 8px;border-radius:5px;background:rgba(245,158,11,.22);color:var(--amber);${appear(t, lit + 0.05, { dy: 0, dx: 8 })}">ONLY HERE</span>` : '',
      });
    }
    // Diff overlay below the rows: the dashed separator and the struck ghost row, like ModelNode.
    const grow = easeOut(seg(t, lit, lit + 0.4));
    if (diffOn) {
      cols.push({
        name: `<span style="font-size:16px;font-weight:700;letter-spacing:.06em;color:#9ca3af">ONLY IN LOGICAL</span>`, type: '',
        rowStyle: `height:${(34 * grow).toFixed(1)}px;overflow:hidden;border-top:1px dashed #9ca3af;border-bottom:1px dashed #9ca3af;background:rgba(156,163,175,.06);opacity:${grow.toFixed(3)}`,
      });
      cols.push({
        name: `<span style="text-decoration:line-through;color:#9ca3af;font-style:italic">${D.map}</span>`, type: 'DECIMAL(12,2)',
        rowStyle: `height:${(46 * grow).toFixed(1)}px;overflow:hidden;opacity:${(0.7 * grow).toFixed(3)}`,
        pill: `<span style="font-size:16px;font-weight:700;letter-spacing:.04em;padding:3px 8px;border-radius:5px;background:rgba(156,163,175,.2);color:#9ca3af">LOGICAL ONLY</span>`,
      });
    }
    html += `<div class="abs" style="left:0;top:0;width:1080px;height:1350px;white-space:nowrap;transform-origin:${NX}px ${NY}px;transform:scale(${NS})">${node({ x: NX, y: NY, w: NW, name: 'orders', layer: 'SLV', grain: SIMPLE.orders.grain, cols, stage: p, lock: p >= 0.5 })}</div>`;

    // Plain labels on the two rows.
    const builtRowY = NY + NS * (ROW0 + 2 * 46 + 23);
    const mapRowY = NY + NS * (ROW0 + 3 * 46 + 34 + 23);
    html += rowLabel({ y: builtRowY, label: 'in the code', sub: 'renamed', color: COLORS.amber, bg: 'var(--amber-row)', border: '#6b5420', t, at: labelsAt });
    html += rowLabel({ y: mapRowY, label: 'on the map', sub: 'the old name', color: COLORS.logical, bg: '#1b2a40', border: '#2d4a70', t, at: labelsAt + 0.25 });

    // "Caught early" note, under the canvas.
    html += `<div class="abs" style="left:${CX}px;width:${CW}px;top:${CY + CH + 18}px;display:flex;justify-content:center;${appear(t, earlyAt, { dy: 12 })}">
      <div style="display:flex;align-items:center;gap:16px;padding:10px 30px 10px 14px;border-radius:999px;border:2px solid #1f5a35;background:#132a1c;white-space:nowrap">
        <span class="tick tick--ok" style="width:46px;height:46px">${ICON.check({ size: 28 })}</span>
        <span style="font-size:32px;font-weight:800;color:var(--text)">Caught <span style="color:var(--green)">early</span></span></div></div>`;

    // The pointer drifts in on "stops matching" and clicks Diff on "lights".
    const pIn = S + 1.5;
    if (t >= pIn && t < click + 1.2) {
      const pt = path(t, [{ t: pIn, x: 900, y: 760 }, { t: click - 0.1, x: DIFF_BTN.x + 6, y: DIFF_BTN.y + 4 }, { t: click + 0.5, x: DIFF_BTN.x + 6, y: DIFF_BTN.y + 4 }, { t: click + 1.2, x: DIFF_BTN.x + 120, y: DIFF_BTN.y + 200 }]);
      const op = Math.min(seg(t, pIn, pIn + 0.3), 1 - seg(t, click + 0.6, click + 1.2));
      html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, seg(t, click, click + 0.4))}</div>`;
    }
    return html;
  },
};
