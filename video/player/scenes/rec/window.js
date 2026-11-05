// A recorded scene's frame: the bezel the real VS Code footage plays in (record/composite.mjs lays
// build/recording.mkv over the timeline's `recording.inset`, exactly inside this bezel), plus what a
// scene's props draw right of the headline:
//   props.claims  [label, beat, seconds after it]: claim pills (the hook)
//   props.logos   [id, beat, seconds after it]: the tools a data model already lives in, each lit as
//                 the line names it (assets/logos/, LOGOS.md; SQL is a word and a database glyph)
// The footage itself is never drawn here: until composite runs, the inset is VS Code's own
// (light) editor background. The frame is light, as the window is (style.css body.rec).
import { appear, ICON } from '../../lib.js';

export const BEZEL = 6;

/** The logos the import scene may name: file (assets/logos/) or none, and the name beside it. */
export const LOGOS = {
  snowflake: { file: 'snowflake.svg', name: 'Snowflake' },
  databricks: { file: 'databricks.svg', name: 'Databricks' },
  dbt: { file: 'dbt.svg', name: 'dbt' },
  powerBi: { file: 'power-bi.svg', name: 'Power BI' },
  // Fabric is named beside the Power BI icon (Microsoft's Fabric icon set), with no mark of its own (LOGOS.md)
  powerBiFabric: { file: 'power-bi.svg', name: 'Power BI / Fabric' },
  sql: { file: null, name: 'SQL' },
  dbml: { file: null, name: 'DBML' },
};
const dbGlyph = (size) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#57606a" stroke-width="2"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/></svg>`;

export default {
  render(t, { beats, scene }) {
    const inset = globalThis.TIMELINE?.recording?.inset ?? { x: 96, y: 240, w: 1728, h: 720 };
    const b = BEZEL;
    const win = `<div class="abs" style="left:${inset.x - b}px;top:${inset.y - b}px;width:${inset.w + 2 * b}px;height:${inset.h + 2 * b}px;border-radius:14px;background:#d9dee5;box-shadow:0 0 0 1px #c3cad3,0 24px 60px rgba(31,35,40,.18)"></div>
      <div class="abs" style="left:${inset.x}px;top:${inset.y}px;width:${inset.w}px;height:${inset.h}px;background:#f8f8f8"></div>`;
    const claims = (scene.props?.claims ?? []).map(([label, beat, offset]) =>
      `<span class="pill" style="font-size:26px;padding:12px 24px;background:#e8f6ed;border:2px solid #9ad5ae;color:#14532d;${appear(t, beats[beat].t + offset, { dy: 10 })}"><span style="color:#16a34a;display:flex">${ICON.check({ size: 24 })}</span>${label}</span>`).join('');
    const pills = claims ? `<div class="abs" style="right:96px;top:150px;display:flex;gap:16px">${claims}</div>` : '';
    const logos = (scene.props?.logos ?? []).map(([id, beat, offset]) => {
      const l = LOGOS[id];
      if (!l) throw new Error(`no logo ${id}`);
      const mark = l.file ? `<img src="/video/player/assets/logos/${l.file}" width="34" height="34" style="display:block;width:34px;height:34px">` : dbGlyph(32);
      return `<span class="pill" style="font-size:24px;padding:10px 20px 10px 14px;gap:12px;background:#ffffff;border:1.5px solid #d0d7de;color:#1f2328;box-shadow:0 6px 18px rgba(31,35,40,.08);${appear(t, beats[beat].t + offset, { dy: 10 })}">${mark}${l.name}</span>`;
    }).join('');
    const row = logos ? `<div class="abs" style="right:96px;top:146px;display:flex;gap:12px">${logos}</div>` : '';
    return win + pills + row;
  },
};
