// launch · 2 · wall — "Bring it in from what you use." Every source the import reads, as its
// official logo (assets/logos/, LOGOS.md → "Compatibility wall"), all the same size in one grid,
// in Liam's order: dbt, Databricks, Snowflake, Power BI, Fabric (row 1: the platforms), then the
// SQL dialects PostgreSQL … SQLite and DBML (a text badge: DBML has no mark of its own).
// `list`: the grid is there from the start as dim grey silhouettes; each tile lights in its own
// colours as the line plays (the named ones on their words, the SQL databases in a quick cascade). After the last one nothing moves for the
// scene's last second (viewers can pause), and it is the secondary still (props.poster → thumb.mjs
// --scene wall).
import { appear, easeOut, lerp, seg } from '../../lib.js';
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
    // The line names a few sources (dbt, Databricks, Snowflake, Power BI): each lights a beat
    // before its word (−0.15 s), Fabric just after Power BI. The rest — the SQL databases and
    // DBML — light in a quick cascade on "SQL databases".
    const caption = scene.lines.find((l) => l.beat === 'list')?.caption ?? '';
    const pbiAt = wordAt(scene, 'list', 'Power BI');
    const sqlAt = wordAt(scene, 'list', 'SQL databases') - 0.3;
    let k = 0;
    const ats = WALL.map(([, name]) => {
      if (caption.includes(name)) return wordAt(scene, 'list', name) - 0.15;
      if (name === 'Fabric') return pbiAt + 0.2;
      return sqlAt + 0.09 * k++;
    });
    // The opener ("Everyone's reverse-engineering apps with AI"): the story everyone saw in October
    // 2026, in words only (no third-party logos): Adobe's apps on the left, an AI pass, ArtCraft's
    // open-source rebuilds on the right. On "so start with yours" it gives way to the wall.
    const revAt = Math.min(0.3, wordAt(scene, 'list', 'Everyone') - 0.1);   // from the scene's start: no empty frame under "Already have a model?"
    const yoursAt = wordAt(scene, 'list', 'yours') - 0.35;
    const out = 1 - seg(t, yoursAt, yoursAt + 0.35);
    const wallIn = easeOut(seg(t, yoursAt + 0.1, yoursAt + 0.5));
    let html = `<div class="abs" style="left:0;top:0;opacity:${wallIn.toFixed(3)}">${wallHtml(t, ats)}</div>`;
    if (t >= revAt && out > 0) {
      const PAIRS = [['Photoshop', 'PhotoCraft'], ['Premiere', 'FilmCraft'], ['Lightroom', 'LightCraft']];
      const CX = 64, CW = 952, CY = 380, RH = 150;
      const chip = (label, x, bg, border, color, style) => `<div class="abs" style="left:${x}px;width:330px;height:96px;border-radius:20px;background:${bg};border:2px solid ${border};color:${color};font-size:36px;font-weight:800;letter-spacing:-.01em;display:flex;align-items:center;justify-content:center;white-space:nowrap;${style}">${label}</div>`;
      let rows = `<div class="abs" style="left:${CX}px;top:${CY - 70}px;width:330px;text-align:center;font-size:24px;font-weight:700;letter-spacing:.08em;color:var(--text-3);${appear(t, revAt)}">ADOBE'S APPS</div>
        <div class="abs" style="left:${CX + CW - 330}px;top:${CY - 70}px;width:330px;text-align:center;font-size:21px;font-weight:700;letter-spacing:.06em;white-space:nowrap;color:var(--green);${appear(t, revAt + 0.5)}">ARTCRAFT · OPEN SOURCE</div>`;
      PAIRS.forEach(([a, b], i) => {
        const at = revAt + 0.15 + 0.45 * i, y = CY + i * RH;
        const fly = easeOut(seg(t, at + 0.3, at + 0.95));
        rows += `<div class="abs" style="left:0;top:${y}px">${chip(a, CX, '#1b2130', '#3a4356', 'var(--text-2)', appear(t, at, { dy: 10 }))}
          <div class="abs" style="left:${CX + 330 + 14}px;top:46px;width:${Math.round((CW - 660 - 28) * fly)}px;height:4px;border-radius:2px;background:linear-gradient(90deg,#f4b42c,#22c55e)"></div>
          <div class="abs" style="left:${CX + 330 + 14 + Math.round((CW - 660 - 28) * fly) - 30}px;top:20px;font-size:22px;font-weight:800;color:#f4b42c;white-space:nowrap;opacity:${(Math.sin(Math.PI * fly)).toFixed(3)}">AI</div>
          ${chip(b, CX + CW - 330, 'rgba(34,197,94,.12)', '#22c55e', 'var(--green)', `opacity:${easeOut(seg(t, at + 0.85, at + 1.15)).toFixed(3)};transform:scale(${(0.92 + 0.08 * easeOut(seg(t, at + 0.85, at + 1.15))).toFixed(3)})`)}</div>`;
      });
      rows += `<div class="abs" style="left:${CX}px;top:${CY + 3 * RH + 6}px;width:${CW}px;text-align:center;font-size:22px;color:var(--text-3);${appear(t, revAt + 1.2, { dy: 6 })}">Rebuilt with AI · reported October 2026</div>`;
      html += `<div class="abs" style="left:0;top:0;opacity:${out.toFixed(3)}">${rows}</div>`;
    }
    return html;
  },
};
