// launch · 2 · wall — "Bring it in from what you use." Every source the import reads, as its
// official logo (assets/logos/, LOGOS.md → "Compatibility wall"), all the same size in one grid,
// in Liam's order: dbt, Databricks, Snowflake, Power BI, Fabric (row 1: the platforms), then the
// SQL dialects PostgreSQL … SQLite and DBML (a text badge: DBML has no mark of its own).
// `have`: the grid is there from the start as dim grey silhouettes. `list`: each tile lights in
// its own colours as its name is said (wordAt). After the last one (DBML) nothing moves: the
// wall is held still through `same` (≥ 4 s) so a viewer can pause on it, and it is the poster
// frame (props.poster → thumb.mjs).
import { easeOut, lerp, seg } from '../../lib.js';
import { wordAt } from '../readme/story.js';

const LOGO = (f) => `/social-video/player/assets/logos/${f}`;
export const WALL = [
  ['dbt.svg', 'dbt'], ['databricks.svg', 'Databricks'], ['snowflake.svg', 'Snowflake'], ['power-bi.svg', 'Power BI'], ['fabric.svg', 'Fabric'],
  ['postgresql.svg', 'PostgreSQL'], ['sql-server.svg', 'SQL Server'], ['mysql.svg', 'MySQL'], ['oracle.svg', 'Oracle'], ['bigquery.svg', 'BigQuery'],
  ['redshift.svg', 'Redshift'], ['mariadb.svg', 'MariaDB'], ['sqlite.svg', 'SQLite'], [null, 'DBML'],
];
const COLS = 5, GAP = 18, TW = Math.floor((952 - (COLS - 1) * GAP) / COLS), TH = 214, LOGO_PX = 96;
const ROWS = Math.ceil(WALL.length / COLS);
const TOP = 300 + Math.round((790 - (ROWS * TH + (ROWS - 1) * GAP)) / 2);

function tileXY(i) {
  const r = Math.floor(i / COLS), c = i % COLS;
  const inRow = Math.min(COLS, WALL.length - r * COLS);
  const rowW = inRow * TW + (inRow - 1) * GAP;
  return { x: 64 + Math.round((952 - rowW) / 2) + c * (TW + GAP), y: TOP + r * (TH + GAP) };
}

const dbmlMark = `<span style="width:${LOGO_PX}px;height:${LOGO_PX}px;display:flex;align-items:center;justify-content:center;border-radius:18px;border:3px solid #e8a24a;font:800 25px/1 Inter;letter-spacing:.01em;color:#b06a12">DBML</span>`;

export function wallHtml(t, ats) {
  return WALL.map(([f, name], i) => {
    const { x, y } = tileXY(i);
    const p = easeOut(seg(t, ats[i], ats[i] + 0.3));
    // Before its name: the tile waits as a dim, grey silhouette (the grid reads from the start);
    // on its name it lights in its own colours with a small pop.
    const mark = f ? `<img src="${LOGO(f)}" width="${LOGO_PX}" height="${LOGO_PX}" style="display:block;width:${LOGO_PX}px;height:${LOGO_PX}px;object-fit:contain">` : dbmlMark;
    const pop = 1 + 0.06 * Math.sin(Math.PI * p);
    return `<div class="abs" style="left:${x}px;top:${y}px;width:${TW}px;height:${TH}px;border-radius:22px;background:#f4f5f7;box-shadow:${p > 0 ? `0 16px 40px rgba(0,0,0,${(0.53 * p).toFixed(3)}),` : ''}0 0 0 1px #ffffff26;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;opacity:${lerp(0.16, 1, p).toFixed(3)};filter:grayscale(${(1 - p).toFixed(3)});transform:scale(${(lerp(0.94, 1, p) * pop).toFixed(3)})">
      ${mark}<span style="font-size:25px;font-weight:700;letter-spacing:-.01em;color:#22262e;white-space:nowrap">${name}</span></div>`;
  }).join('');
}

export default {
  render(t, { scene }) {
    // Each tile a beat before its word (−0.15 s), so it is on screen as the name is heard.
    const ats = WALL.map(([, name]) => wordAt(scene, 'list', name) - 0.15);
    return wallHtml(t, ats);
  },
};
