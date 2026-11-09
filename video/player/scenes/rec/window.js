// A recorded scene's frame: the bezel the real VS Code footage plays in (record/composite.mjs lays
// build/recording.mkv over the timeline's `recording.inset`, exactly inside this bezel), plus what a
// scene's props draw right of the headline:
//   props.claims  [label, beat, seconds after it]: claim pills (the hook)
//   props.stats   [label, beat, seconds after it]: the scale scene's figures, as plain pills
//   props.query   { beat, offset, logo, name, sql, note }: another tool's one-step export, a card
//                 (the export scene: Snowflake's GET_DDL beside the pg_dump the window films)
//   props.assistants  [beat, seconds after it, names]: the assistants Set Up My AI Helper sets up
//                 (src/types/aiAssistants.ts), one after another (aiSetup)
// The footage itself is never drawn here: until composite runs, the inset is VS Code's own
// (light) editor background. The frame is light, as the window is (style.css body.rec).
import { appear, esc, fadeOut, ICON } from '../../lib.js';

export const BEZEL = 6;

/** The inset the footage plays in (the timeline's recording.inset). */
export const insetOf = () => globalThis.TIMELINE?.recording?.inset ?? { x: 96, y: 240, w: 1728, h: 720 };
/** The window's bezel around the inset: the same for the footage and for a still of it (tour/aiChange). */
export const bezel = (inset = insetOf()) => `<div class="abs" style="left:${inset.x - BEZEL}px;top:${inset.y - BEZEL}px;width:${inset.w + 2 * BEZEL}px;height:${inset.h + 2 * BEZEL}px;border-radius:14px;background:#d9dee5;box-shadow:0 0 0 1px #c3cad3,0 24px 60px rgba(31,35,40,.18)"></div>`;

export default {
  render(t, { beats, scene, dur }) {
    const inset = insetOf();
    const win = `${bezel(inset)}
      <div class="abs" style="left:${inset.x}px;top:${inset.y}px;width:${inset.w}px;height:${inset.h}px;background:#f8f8f8"></div>`;
    const claims = (scene.props?.claims ?? []).map(([label, beat, offset]) =>
      `<span class="pill" style="font-size:26px;padding:12px 24px;background:#e8f6ed;border:2px solid #9ad5ae;color:#14532d;${appear(t, beats[beat].t + offset, { dy: 10 })}"><span style="color:#16a34a;display:flex">${ICON.check({ size: 24 })}</span>${label}</span>`).join('');
    const pills = claims ? `<div class="abs" style="right:96px;top:150px;display:flex;gap:16px">${claims}</div>` : '';
    // the scale scene's figures: plain pills, the number in bold
    const stats = (scene.props?.stats ?? []).map(([label, beat, offset]) => {
      // the figure in bold (2,000 · 2,700 · ~5 s), the words around it quieter
      const html = esc(label).replace(/(~?\d[\d,.]*(?: s\b)?)/, '<b style="font-weight:800;color:#1f2328">$1</b>');
      return `<span class="pill" style="font-size:25px;padding:11px 22px;background:#ffffff;border:1.5px solid #d0d7de;color:#57606a;font-weight:600;white-space:nowrap;box-shadow:0 6px 18px rgba(31,35,40,.08);${appear(t, beats[beat].t + offset, { dy: 10 })}"><span>${html}</span></span>`;
    }).join('');
    const statRow = stats ? `<div class="abs" style="right:96px;top:150px;display:flex;gap:14px">${stats}</div>` : '';
    // another tool's one-step export: a card right of the headline (the window films the other one)
    const q = scene.props?.query;
    const query = q ? `<div class="abs" style="right:96px;top:122px;display:flex;align-items:center;gap:20px;padding:16px 26px 16px 20px;border-radius:16px;background:#ffffff;border:1.5px solid #d0d7de;box-shadow:0 10px 28px rgba(31,35,40,.10);${appear(t, beats[q.beat].t + q.offset, { dy: 10 })}">
      <img src="/video/player/assets/logos/${q.logo}.svg" width="52" height="52" style="display:block;width:52px;height:52px">
      <div style="display:flex;flex-direction:column;gap:8px">
        <div style="font-size:20px;font-weight:700;color:#57606a;white-space:nowrap">${esc(q.name)} <span style="font-weight:500;color:#8c959f">· one query, ${esc(q.note)}</span></div>
        <div class="mono" style="font-size:25px;font-weight:600;color:#1f2328;white-space:nowrap">${esc(q.sql)}</div></div></div>` : '';
    const [aBeat, aOffset, names] = scene.props?.assistants ?? [];
    // it leaves with its scene (the next one's headline takes the space)
    const out = dur ? fadeOut(t, dur - 0.35, 0.3) : 1;
    const assistants = names ? `<div class="abs" style="right:96px;top:150px;display:flex;align-items:center;gap:10px;opacity:${out.toFixed(3)}">
      <span style="font-size:22px;font-weight:600;color:#57606a;margin-right:4px;${appear(t, beats[aBeat].t + aOffset, { dy: 8 })}">Works with</span>
      ${names.map((n, i) => `<span class="pill" style="font-size:22px;padding:9px 18px;background:#ffffff;border:1.5px solid #d0d7de;color:#1f2328;box-shadow:0 6px 18px rgba(31,35,40,.08);${appear(t, beats[aBeat].t + aOffset + 0.15 + i * 0.12, { dy: 8 })}">${n}</span>`).join('')}</div>` : '';
    return win + pills + statRow + query + assistants;
  },
};
