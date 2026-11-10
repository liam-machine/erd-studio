// launch · 5 · scale — "Built for big models." A REAL take, not a mock: @erd-studio/renderer's
// ErdCanvas drawing a 2,000-table diagram (2,719 relationships), recorded in real time by
// scale-clip.mjs into build-launch/clip/ (numbered JPEG frames + meta.json). The scene only
// places those frames on its clock and adds what a screen recording cannot carry:
//   - the routing chip: "Routing lines in the background" from the canvas's first draw
//     (meta.clipAt) until the routed pass lands in that take (meta.routedSec), then "Lines routed
//     in the background" — the lines visibly jump from the straight fallback under the tables to
//     the routed curves around them at that moment. No seconds on screen: the time depends on
//     the machine (Liam, 2026-11-10); meta.json keeps the measurement;
//   - the pointer (screenshots have no cursor): meta.pointer, per frame, in box pixels.
// `big`: overview of all 2,000 tables, the zoom into the sales corner while the lines are still
// routing, then they settle. `hover`: the pointer rests on sales.dim_store, the rest of the
// diagram fades and the arrows flow along its lines from the 1 end to the * end (EdgeFlow).
// No drags. Re-shoot: VARIANT=launch node scale-clip.mjs.
import { appear, easeOut, ICON, pointer, seg, spinner } from '../../lib.js';
import { FILE_COL } from '../readme/story.js';

const META = await (await fetch('/social-video/build-launch/clip/meta.json', { cache: 'no-store' })).json();
const X = 64, W = 952, Y = 300, HEAD = 52;
const BOX = META.box;                                   // the clip's size in frame pixels (952 x 690)
const CY = Y + HEAD;
const frameSrc = (k) => `/social-video/build-launch/clip/f${String(k).padStart(4, '0')}.jpg`;
const n = (v) => v.toLocaleString('en-US');

export default {
  render(t) {
    const ct = t - META.clipAt;                          // seconds since the canvas first drew
    const k = Math.max(0, Math.min(META.frames - 1, Math.floor(ct * META.fps)));
    let html = `<div class="card" style="left:${X}px;top:${Y}px;width:${W}px;height:${HEAD + BOX.h}px;${appear(t, 0, { dy: 14 })}">
      <div class="card__head" style="height:${HEAD}px"><div class="card__tab card__tab--on"><span style="color:${FILE_COL.dbml};display:flex">${ICON.file({ size: 20 })}</span>enterprise_warehouse.dbml</div><div class="card__crumb">.erd-studio › gold › diagrams</div></div>
      <div class="abs" style="left:0;top:${HEAD}px;width:${BOX.w}px;height:${BOX.h}px;background:#16171b;overflow:hidden">
        ${ct >= 0 ? `<img src="${frameSrc(k)}" width="${BOX.w}" height="${BOX.h}" style="display:block;width:${BOX.w}px;height:${BOX.h}px">` : ''}</div></div>`;

    // The pointer, where the take put it.
    const pt = ct >= 0 ? META.pointer[k] : null;
    if (pt) html += pointer(X + pt.x, CY + pt.y);

    // Stats and the routing chip, over the canvas's empty top-left.
    const routed = ct >= META.routedSec;
    const land = easeOut(seg(ct, META.routedSec, META.routedSec + 0.3));
    const chip = (inner, extra = '') => `<span class="pill" style="font-size:24px;padding:8px 18px;gap:10px;background:#0b0c0fe6;border:1px solid #3a3d45;color:var(--text);box-shadow:0 10px 30px #000a;${extra}">${inner}</span>`;
    html += `<div class="abs" style="left:${X + 18}px;top:${CY + 16}px;display:flex;flex-direction:column;align-items:flex-start;gap:10px;${appear(t, META.clipAt, { dy: 8 })}">
      ${chip(`${ICON.table({ size: 22 })}<span><b>${n(META.tables)}</b> tables <span style="color:var(--text-3)">·</span> <b>${n(META.relationships)}</b> relationships</span>`)}
      ${ct >= 0 ? chip(routed
        ? `<span style="color:var(--green);display:flex">${ICON.check({ size: 22 })}</span><span>Lines routed in the background</span>`
        : `${spinner(t, 22, 'var(--blue)')}<span>Routing lines in the background</span>`,
        routed ? `border-color:rgba(34,197,94,${(0.3 + 0.6 * land).toFixed(3)});transform:scale(${(1 + 0.06 * Math.sin(Math.PI * land)).toFixed(3)});transform-origin:0 50%` : '') : ''}</div>`;
    return html;
  },
};
