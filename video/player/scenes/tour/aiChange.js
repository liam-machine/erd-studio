// The AI change, held: "Here's the change: a new table file, and the line that links it to the orders
// table. On the canvas, the new table and its relationship." Both cuts'.
//
// Where the recording was, a still of its last frame (the aiRun take's, `props.still`:
// assets/still-<scene>.jpg, written by `npm run still`, with the drawn pointer's place on it in
// still-<scene>.json): composite.mjs cuts from the footage to it with no fade, and main.js keeps the
// window's frame still, so the hold reads as the same window. Over it:
//   files   a card over the terminal: the lines Claude Code wrote, word for word (CHANGE: its own
//           edits, as record/takes.json's terminal rows and record/fixtures.erd.mjs hold them); the new
//           table file lights with its table on the canvas, the Ref line (under the `use` line it
//           needs) with the line it draws
//   canvas  the card leaves and the canvas punches in on the new table and its relationship, ringed,
//           with "Added by your AI"
// The geometry (NEW_TABLE, LINK, FK_ROW) is measured on the still, in inset px: a new take of aiRun
// moves the tables, so check these against the new still.
import { appear, easeInOut, easeOut, esc, fadeOut, ICON, lerp, seg } from '../../lib.js';
import { phraseAt } from './confluence.js';
import { bezel, insetOf } from '../rec/window.js';

/** What Claude Code wrote (its edits in the take): the new table's file, whole, and the two lines it added to the relationships file (the `use` line its Ref needs, then the Ref). */
export const CHANGE = {
  table: {
    path: '.erd-studio/main/tables/main/dim_customer.dbml',
    lines: ['Table main.dim_customer {', '  customer_id   "NUMBER(38,0)" [pk]', '  customer_name "VARCHAR(100)"', '  email         "VARCHAR(150)"', '  city          "VARCHAR(60)"', '  region        "VARCHAR(30)"', '}'],
  },
  ref: {
    path: '.erd-studio/main/relationships/main.dbml',
    use: "use { table main.dim_customer } from '../tables/main/dim_customer.dbml'",
    line: 'Ref: main.fct_order.customer_id >? main.dim_customer.customer_id',
  },
  /** The two smaller edits that go with them: the key column on the fact table, the table on the diagram. */
  also: [['fct_order.dbml', '+ customer_id'], ['sales.dbml', '+ dim_customer']],
};

/** On the still (inset px): the new table's card, the relationship's line from fct_order to it, and fct_order's new key column's row. */
export const NEW_TABLE = { x: 783, y: 337, w: 149, h: 112 };
export const LINK = [[428, 416], [605, 416], [605, 392], [783, 392]];
export const FK_ROW = { x: 281, y: 364, w: 145, h: 14 };
/** The punch-in: about this point (inset px), to this scale, the point ending at the inset's centre-left. */
const ZOOM = { focus: [606, 380], scale: 1.5, to: [850, 372] };

// The pointer composite drew on the footage's last frame, so the still shows it too, then moves it
// off the window's right edge (absent in the pipeline test, which renders without a server).
const stills = {};
if (typeof fetch === 'function' && globalThis.TIMELINE) {
  for (const s of globalThis.TIMELINE.scenes.filter((x) => x.props?.still)) {
    try { stills[s.props.still] = await (await fetch(`/video/player/assets/still-${s.props.still}.json`, { cache: 'no-store' })).json(); } catch { /* no pointer */ }
  }
}
const ARROW = '<path d="M4 2l15 11.5-6.6 1.1 3.9 7.2-2.9 1.5-3.9-7.3L4 21z" fill="#fff" stroke="#000" stroke-width="1.4"/>';

// GitHub's light diff colours: an added line and its gutter
const ADD = { bg: '#e6ffec', gutter: '#ccffd8', sign: '#1a7f37', hl: '#abf2bc' };
const GREEN = '#16a34a';

export default {
  render(t, { scene, dur }) {
    const inset = insetOf();
    const name = scene.props.still;
    const tableAt = phraseAt(scene, 'files', 'a new table');
    const refAt = phraseAt(scene, 'files', 'the line that links');
    const canvasAt = scene.beats.canvas.t - 0.25;
    // the punch-in, about ZOOM.focus: screen = (p - f)·s + f + (C - f)·k
    const k = easeInOut(seg(t, canvasAt, canvasAt + 1.1));
    const s = lerp(1, ZOOM.scale, k);
    const [fx, fy] = ZOOM.focus;
    const tx = (fx + (ZOOM.to[0] - fx) * k) - fx * s, ty = (fy + (ZOOM.to[1] - fy) * k) - fy * s;
    const scr = (x, y) => [x * s + tx, y * s + ty];

    // on the canvas: the new table ringed (from "a new table"), its line traced (from "the line that links"), the key row lit
    const ring = easeOut(seg(t, tableAt, tableAt + 0.4));
    const trace = easeOut(seg(t, refAt, refAt + 0.7));
    const pathD = `M${LINK.map(([x, y]) => `${x} ${y}`).join(' L')}`;
    const len = LINK.slice(1).reduce((n, [x, y], i) => n + Math.abs(x - LINK[i][0]) + Math.abs(y - LINK[i][1]), 0);
    const pad = 6;
    const marks = `<svg class="abs" style="left:0;top:0;overflow:visible" width="${inset.w}" height="${inset.h}">
      <rect x="${NEW_TABLE.x - pad}" y="${NEW_TABLE.y - pad}" width="${NEW_TABLE.w + 2 * pad}" height="${NEW_TABLE.h + 2 * pad}" rx="9" fill="rgba(22,163,74,${(0.06 * ring).toFixed(3)})" stroke="${GREEN}" stroke-width="3" vector-effect="non-scaling-stroke" opacity="${ring.toFixed(3)}"/>
      <rect x="${FK_ROW.x}" y="${FK_ROW.y}" width="${FK_ROW.w}" height="${FK_ROW.h}" rx="3" fill="rgba(22,163,74,.18)" opacity="${trace.toFixed(3)}"/>
      <path d="${pathD}" fill="none" stroke="${GREEN}" stroke-width="3.5" stroke-linejoin="round" vector-effect="non-scaling-stroke" stroke-dasharray="${len}" stroke-dashoffset="${(len * (1 - trace)).toFixed(1)}" opacity="${trace > 0 ? 1 : 0}"/></svg>`;
    let html = bezel(inset) + `<div class="abs" style="left:${inset.x}px;top:${inset.y}px;width:${inset.w}px;height:${inset.h}px;overflow:hidden;background:#f8f8f8">
      <div class="abs" style="left:0;top:0;width:${inset.w}px;height:${inset.h}px;transform-origin:0 0;transform:translate(${tx.toFixed(2)}px,${ty.toFixed(2)}px) scale(${s.toFixed(4)})">
        <img src="/video/player/assets/still-${name}.jpg" width="${inset.w}" height="${inset.h}" style="display:block;width:${inset.w}px;height:${inset.h}px">${marks}</div>`;
    // everything below is drawn inside the window (inset px), clipped to it

    // the pointer where the footage left it, gliding off the window's right edge
    const p = stills[name]?.pointer;
    if (p) {
      const g = easeInOut(seg(t, 0.25, 1.05));
      const [px, py] = scr(p.x, p.y);
      const x = lerp(px, inset.w + 40, g), y = lerp(py, py - 60, g), z = inset.w / 1440;
      html += `<svg class="abs" style="left:${(x - 4 * z).toFixed(1)}px;top:${(y - 2 * z).toFixed(1)}px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))" width="${24 * z}" height="${24 * z}" viewBox="0 0 24 24">${ARROW}</svg>`;
    }

    // "Added by your AI", over the new table once the canvas is punched in
    if (t >= canvasAt + 0.7) {
      const [lx, ly] = scr(NEW_TABLE.x + NEW_TABLE.w / 2, NEW_TABLE.y - pad);
      html += `<div class="abs" style="left:${lx.toFixed(1)}px;top:${(ly - 14).toFixed(1)}px;transform:translate(-50%,-100%)"><span class="pill" style="font-size:24px;padding:9px 18px 9px 14px;gap:9px;background:${GREEN};color:#fff;box-shadow:0 8px 22px rgba(22,163,74,.35);${appear(t, canvasAt + 0.7, { dy: 8 })}">${ICON.sparkle({ size: 22 })}Added by your AI</span></div>`;
    }

    // the card: what it wrote (over the terminal), leaving as the canvas punches in
    const cardOp = Math.min(easeOut(seg(t, scene.beats.files.t - 0.05, scene.beats.files.t + 0.35)), fadeOut(t, canvasAt, 0.35));
    if (cardOp > 0) {
      const CX = 962, CY = 34, CW = 746;   // left of the terminal's edge enough for the `use` line; clear of the new table (x ≤ 938)
      const row = (sign, text, lit, extra = '') => `<div style="display:flex;height:27px;align-items:center;white-space:pre;background:${lit ? `rgba(171,242,188,${lit.toFixed(3)})` : ADD.bg};${extra}">
          <span style="width:30px;flex:none;align-self:stretch;display:flex;align-items:center;justify-content:center;background:${ADD.gutter};color:${ADD.sign}">${sign}</span><span style="padding-left:10px">${esc(text)}</span></div>`;
      const head = (path, badge, lit) => `<div style="display:flex;align-items:center;gap:10px;height:40px;padding:0 14px;background:#f6f8fa;border-bottom:1px solid #d0d7de;font-size:17px;color:#1f2328;white-space:nowrap">
          <span style="color:#57606a;display:flex">${ICON.file({ size: 18 })}</span><span class="mono" style="font-size:16px;font-weight:600">${path}</span><span style="flex:1"></span>
          <span class="pill" style="font-size:15px;padding:3px 10px;background:${lit > 0.5 ? ADD.hl : '#eaeef2'};color:${ADD.sign};font-weight:700">${badge}</span></div>`;
      const litTable = easeOut(seg(t, tableAt, tableAt + 0.4));
      const litRef = easeOut(seg(t, refAt, refAt + 0.4));
      const pulse = (at) => 0.55 * Math.sin(Math.PI * seg(t, at, at + 0.9));
      html += `<div class="abs" style="left:${CX}px;top:${CY}px;width:${CW}px;border-radius:12px;background:#fff;border:1px solid #d0d7de;overflow:hidden;box-shadow:0 18px 50px rgba(31,35,40,.22);opacity:${cardOp.toFixed(3)};transform:translateY(${lerp(10, 0, Math.min(1, cardOp * 1.2)).toFixed(1)}px)">
        <div style="display:flex;align-items:center;gap:10px;height:50px;padding:0 16px;border-bottom:1px solid #d0d7de;font-size:20px;font-weight:700;color:#1f2328">
          <span style="color:${GREEN};display:flex">${ICON.sparkle({ size: 22 })}</span>What Claude Code changed</div>
        <div style="margin:12px;border:1.5px solid ${litTable > 0 ? `rgba(22,163,74,${(0.4 + 0.6 * litTable).toFixed(3)})` : '#d0d7de'};border-radius:8px;overflow:hidden">
          ${head(CHANGE.table.path, 'new file · +7', litTable)}
          <div class="mono" style="font-size:16px;color:#1f2328;padding:4px 0">${CHANGE.table.lines.map((l) => row('+', l, pulse(tableAt))).join('')}</div></div>
        <div style="margin:0 12px 12px;border:1.5px solid ${litRef > 0 ? `rgba(22,163,74,${(0.4 + 0.6 * litRef).toFixed(3)})` : '#d0d7de'};border-radius:8px;overflow:hidden">
          ${head(CHANGE.ref.path, '+2', litRef)}
          <div class="mono" style="font-size:15px;color:#1f2328;padding:4px 0">${row('+', CHANGE.ref.use, pulse(refAt))}${row('+', CHANGE.ref.line, pulse(refAt), 'font-weight:600')}</div></div>
        <div style="display:flex;gap:10px;padding:0 14px 14px;font-size:16px;color:#57606a;white-space:nowrap;${appear(t, refAt + 0.4, { dy: 4 })}">
          ${CHANGE.also.map(([f, what]) => `<span class="pill" style="font-size:15px;padding:4px 12px;gap:8px;background:#f6f8fa;border:1px solid #d0d7de;color:#57606a"><span class="mono">${f}</span><span style="color:${ADD.sign};font-weight:700">${what}</span></span>`).join('')}</div>
      </div>`;
    }
    return html + '</div>';
  },
};
