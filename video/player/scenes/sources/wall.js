// Where a data model already lives: every source the import reads, all at once, as one wall of
// same-size tiles (the official mark, unaltered, above its name, and how ERD Studio reads it). The
// tiles land together in the first second, then the wall holds perfectly still for the rest of the
// scene, so a viewer can pause on it and read every name. HTML, not filmed: it stands where the
// window is (the footage fades out before it and back in after it, record/composite.mjs runsOf).
//
//   props.sources  the tiles, in order (ids of SOURCES); the logical cut's list has no dbt tile
//
// Marks: assets/logos/ (LOGOS.md: where each came from and its terms). DBML has no mark of its own:
// its tile is a text badge.
import { appear, esc } from '../../lib.js';
import { insetOf } from '../rec/window.js';

/** Each source: its mark (assets/logos/; null: the DBML text badge), its name, and how the import reads it. */
export const SOURCES = {
  dbt: { file: 'dbt.svg', name: 'dbt', via: 'dbt project' },
  databricks: { file: 'databricks.svg', name: 'Databricks', via: 'SQL DDL' },
  snowflake: { file: 'snowflake.svg', name: 'Snowflake', via: 'SQL DDL' },
  powerBi: { file: 'power-bi.svg', name: 'Power BI', via: 'semantic model' },
  fabric: { file: 'fabric.svg', name: 'Microsoft Fabric', via: 'semantic model' },
  postgresql: { file: 'postgresql.svg', name: 'PostgreSQL', via: 'SQL DDL' },
  sqlServer: { file: 'sql-server.svg', name: 'SQL Server', via: 'SQL DDL' },
  mysql: { file: 'mysql.svg', name: 'MySQL', via: 'SQL DDL' },
  oracle: { file: 'oracle.svg', name: 'Oracle', via: 'SQL DDL' },
  bigquery: { file: 'bigquery.svg', name: 'BigQuery', via: 'SQL DDL' },
  redshift: { file: 'redshift.svg', name: 'Redshift', via: 'SQL DDL' },
  mariadb: { file: 'mariadb.svg', name: 'MariaDB', via: 'SQL DDL' },
  sqlite: { file: 'sqlite.svg', name: 'SQLite', via: 'SQL DDL' },
  dbml: { file: null, name: 'DBML', via: 'any DBML file' },
};

/** Tiles per row, the tile's size and the mark's (frame px at 1920x1080). */
export const WALL = { perRow: 7, tileW: 216, tileH: 256, gap: 20, mark: 96 };

const C = { card: '#ffffff', border: '#d0d7de', tile: '#f6f8fa', tileBorder: '#e1e5ea', text: '#1f2328', text2: '#57606a', text3: '#8c959f' };

/** DBML's tile: no mark of its own, so the word in a badge the marks' size. */
const dbmlBadge = (size) => `<div style="width:${size}px;height:${size}px;border-radius:18px;background:#1f2328;display:flex;align-items:center;justify-content:center">
  <span class="mono" style="font-size:${Math.round(size * 0.27)}px;font-weight:700;letter-spacing:.02em;color:#ffffff">DBML</span></div>`;

function tile(src, t, i) {
  const mark = src.file
    ? `<img src="/video/player/assets/logos/${src.file}" width="${WALL.mark}" height="${WALL.mark}" style="display:block;width:${WALL.mark}px;height:${WALL.mark}px;object-fit:contain">`
    : dbmlBadge(WALL.mark);
  // all land within the first second, a few hundredths apart, then nothing moves
  return `<div style="width:${WALL.tileW}px;height:${WALL.tileH}px;flex:none;box-sizing:border-box;border-radius:18px;background:${C.tile};border:1.5px solid ${C.tileBorder};
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;${appear(t, 0.2 + i * 0.035, { dy: 12, dur: 0.4 })}">
    ${mark}
    <div style="display:flex;flex-direction:column;align-items:center;gap:5px">
      <span style="font-size:${src.name.length > 12 ? 23 : 26}px;font-weight:700;color:${C.text};white-space:nowrap;letter-spacing:-.01em">${esc(src.name)}</span>
      <span style="font-size:17px;font-weight:500;color:${C.text3};white-space:nowrap">${esc(src.via)}</span>
    </div></div>`;
}

export default {
  render(t, { scene }) {
    const inset = insetOf();
    const ids = scene.props?.sources ?? [];
    const list = ids.map((id) => {
      const s = SOURCES[id];
      if (!s) throw new Error(`sources/wall: no source ${id}`);
      return s;
    });
    const rows = [];
    for (let i = 0; i < list.length; i += WALL.perRow) rows.push(list.slice(i, i + WALL.perRow));
    const body = rows.map((row, r) => `<div style="display:flex;justify-content:center;gap:${WALL.gap}px">${row.map((s, k) => tile(s, t, r * WALL.perRow + k)).join('')}</div>`).join('');
    return `<div class="abs" style="left:${inset.x}px;top:${inset.y}px;width:${inset.w}px;height:${inset.h}px;box-sizing:border-box;border-radius:14px;background:${C.card};border:1.5px solid ${C.border};box-shadow:0 24px 60px rgba(31,35,40,.12);
        display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${WALL.gap + 4}px">
      <div style="font-size:22px;font-weight:700;letter-spacing:.08em;color:${C.text2};text-transform:uppercase;margin-bottom:6px;${appear(t, 0.1, { dy: 8 })}">Import from</div>
      ${body}
    </div>`;
  },
};
