// launch · 3 · export — "Getting it out? One step." Getting the DDL out of where it lives is ONE
// step at schema grain (never a single-table export), shown for two sources, stacked:
//   Snowflake  a worksheet runs SELECT GET_DDL('SCHEMA', 'SHOP.SALES'); the one result cell is
//              the schema's whole DDL, saved as sales.sql.
//   PostgreSQL a terminal runs pg_dump --schema-only -d shop -f sales.sql, which writes the file
//              itself (the next scene imports that file).
// `one`: the query types and its result lands on "Snowflake"; the command types and the file
// appears on "PostgreSQL". `whole`: "whole schema" tags both (6 tables), "one .sql file" lights
// both files. The import guide (Bring In Your Data Model…) has the same routes, tool by tool.
import { appear, caret, easeOut, ICON, seg, typed } from '../../lib.js';
import { wordAt } from '../readme/story.js';
import { SALES_SQL, SNOWFLAKE_DDL } from './story.js';

const X = 64, W = 952;
const LOGO = (f) => `/social-video/player/assets/logos/${f}`;
const logoTile = (f, size = 36) => `<span style="flex:none;width:${size + 10}px;height:${size + 10}px;border-radius:10px;background:#f4f5f7;display:inline-flex;align-items:center;justify-content:center"><img src="${LOGO(f)}" width="${size}" height="${size}" style="display:block;width:${size}px;height:${size}px"></span>`;
const QUERY = "SELECT GET_DDL('SCHEMA', 'SHOP.SALES');";
const CMD = 'pg_dump --schema-only -d shop -f sales.sql';
const sqlKw = (s) => s.replace(/\b(SELECT|GET_DDL|create|or|replace|schema|TABLE|CREATE|NOT|NULL|NUMBER|VARCHAR|integer|text)\b/g, '<span class="kw">$1</span>').replace(/('[^']*')/g, '<span class="s">$1</span>');

function head(icon, title, sub) {
  return `<div class="card__head" style="height:60px;align-items:center;gap:14px;padding:0 20px;color:var(--text)">${icon}<span style="font-size:24px;font-weight:700">${title}</span><span style="font-size:21px;color:var(--text-3)">${sub}</span></div>`;
}
function fileChip(t, at, glow, sub) {
  return `<span class="pill" style="font-size:23px;padding:7px 18px;gap:10px;background:rgba(120,192,244,${(0.1 + 0.16 * glow).toFixed(3)});border:2px solid rgba(120,192,244,${(0.35 + 0.6 * glow).toFixed(3)});color:#cfe6fb;box-shadow:0 0 ${Math.round(26 * glow)}px rgba(120,192,244,${(0.45 * glow).toFixed(3)});${appear(t, at, { dy: 8 })}">${ICON.file({ size: 22 })}<span class="mono">sales.sql</span><span style="font-weight:500;color:var(--text-2)">${sub}</span></span>`;
}
function schemaTag(t, at) {
  return t >= at ? `<span class="pill" style="font-size:21px;padding:5px 14px;gap:8px;background:#13301f;color:var(--green);border:1px solid #1f6b3a;${appear(t, at, { dy: 0, dx: 8 })}">${ICON.check({ size: 18 })}whole schema · 6 tables</span>` : '';
}

export default {
  render(t, { beats, scene }) {
    const snowAt = wordAt(scene, 'one', 'Snowflake');
    const cmdAt = wordAt(scene, 'one', 'one command') - 0.5;
    const pgAt = wordAt(scene, 'one', 'PostgreSQL');
    const wholeAt = wordAt(scene, 'whole', 'whole schema');
    const fileAt = wordAt(scene, 'whole', 'one .sql');
    const glow = easeOut(seg(t, fileAt, fileAt + 0.3)) * (1 - 0.5 * seg(t, fileAt + 1.2, fileAt + 2));

    // ---- Snowflake worksheet ----
    const qAt = 0.3, qCps = 30, qEnd = qAt + QUERY.length / qCps;
    const AY = 300, AH = 380;
    let a = `<div class="abs mono" style="left:24px;right:24px;top:18px;height:40px;line-height:40px;font-size:26px;white-space:pre"><span style="color:var(--text-3);margin-right:14px">1</span>${sqlKw(typed(QUERY, t, qAt, qCps))}${t < snowAt ? caret(t, qEnd) : ''}</div>`;
    if (t >= snowAt - 0.2) {
      a += `<div class="abs" style="left:24px;right:24px;top:70px;height:150px;border-radius:10px;background:#111215;border:1px solid #2c2e34;overflow:hidden;${appear(t, snowAt - 0.2, { dy: 8 })}">
        <div style="height:34px;display:flex;align-items:center;padding:0 16px;font-size:17px;font-weight:700;letter-spacing:.06em;color:var(--text-3);border-bottom:1px solid #2c2e34">GET_DDL('SCHEMA', 'SHOP.SALES')</div>
        <div class="mono" style="padding:8px 16px;font-size:20px;line-height:1.38;white-space:pre;color:var(--text-2)">${SNOWFLAKE_DDL.slice(0, 4).map(sqlKw).join('\n')}</div></div>`;
      a += `<div class="abs" style="left:24px;right:24px;top:236px;display:flex;align-items:center;gap:14px">${fileChip(t, snowAt + 0.5, glow, 'saved from the result')}<span style="flex:1"></span>${schemaTag(t, wholeAt)}</div>`;
    }
    let html = `<div class="card" style="left:${X}px;top:${AY}px;width:${W}px;height:${AH}px;${appear(t, 0, { dy: 14 })}">${head(logoTile('snowflake.svg'), 'Snowflake', 'one query')}<div class="card__body" style="top:60px">${a}</div></div>`;

    // ---- PostgreSQL terminal ----
    const BY = AY + AH + 18, BH = 1088 - BY;
    const cCps = 34, cEnd = cmdAt + CMD.length / cCps;
    let b = '';
    if (t >= cmdAt - 0.4) {
      b += `<div class="abs mono" style="left:24px;right:24px;top:18px;height:40px;line-height:40px;font-size:26px;white-space:pre"><span style="color:var(--green);margin-right:14px">$</span>${typed(CMD, t, cmdAt, cCps)}${t < pgAt + 0.3 ? caret(t, cEnd) : ''}</div>`;
    }
    if (t >= pgAt + 0.3) {
      b += `<div class="abs" style="left:24px;right:24px;top:72px;display:flex;align-items:center;gap:14px">${fileChip(t, pgAt + 0.3, glow, 'written by pg_dump')}<span style="flex:1"></span>${schemaTag(t, wholeAt + 0.25)}</div>`;
      b += `<div class="abs mono" style="left:24px;right:24px;top:130px;padding:10px 16px;border-radius:10px;background:#111215;border:1px solid #2c2e34;font-size:20px;line-height:1.38;white-space:pre;color:var(--text-2);${appear(t, pgAt + 0.5, { dy: 8 })}">${SALES_SQL.map(sqlKw).join('\n')}</div>`;
    }
    html += `<div class="card" style="left:${X}px;top:${BY}px;width:${W}px;height:${BH}px;${appear(t, cmdAt - 0.4, { dy: 14 })}">${head(logoTile('postgresql.svg'), 'PostgreSQL', 'one command')}<div class="card__body" style="top:60px;background:#111215">${b}</div></div>`;
    return html;
  },
};
