// readme · 3 · flip — "Keep it as DBML, next to the code." The repo's Explorer: the code is there
// (sql/, README.md); on "DBML" the .erd-studio folder slides in at the top (VS Code sorts dot
// folders first), green, and on "right next to the code" a bracket spans the model and the SQL:
// same repo, same pull request. The card is where tree.js picks up, so the cut is seamless.
import { appear, appearFade, card, easeOut, ICON, lerp, seg } from '../../lib.js';
import { explorerRows, FILE_COL, R, wordAt } from './story.js';

const X = 64, Y = 300, W = 952, H = 790;
const ROWS_TOP = Y + 64 + 18;
const BX = 700;                      // bracket x
const GREEN = '34,197,94';

export default {
  render(t, { scene }) {
    const insertAt = wordAt(scene, 'repo', 'DBML') - 0.25;
    const bracketAt = wordAt(scene, 'repo', 'next');
    const ins = (k) => easeOut(seg(t, insertAt + k * 0.12, insertAt + k * 0.12 + 0.32));
    const glow = 1 - 0.4 * seg(t, bracketAt + 0.8, bracketAt + 1.6);
    const newRow = (k, row) => ({ ...row, q: ins(k), hl: GREEN, hlA: glow, fg: '#d9fbe5' });
    const rows = [
      newRow(0, { d: 0, name: '.erd-studio', dir: true, col: 'var(--green)' }),
      newRow(1, { d: 1, name: R.layer, dir: true, open: false, col: 'var(--green)' }),
      newRow(2, { d: 1, name: 'layers.json', col: FILE_COL.json }),
      newRow(3, { d: 1, name: 'README.md', col: FILE_COL.md }),
      { d: 0, name: 'sql', dir: true },
      { d: 1, name: 'customers.sql', col: FILE_COL.sql },
      { d: 1, name: 'orders.sql', col: FILE_COL.sql },
      { d: 0, name: 'README.md', col: FILE_COL.md },
    ];
    let html = card({
      x: X, y: Y, w: W, h: H,
      tabs: [{ label: 'Explorer', on: true, icon: `<span style="color:#7f8792">${ICON.folder({ size: 24 })}</span>` }],
      crumb: `${R.repo} · main`, headStyle: 'font-size:24px',
    });
    const { html: rh, ys } = explorerRows(rows, { x: X, y: ROWS_TOP, w: W, hlW: BX - 36 - X });
    html += rh;
    // "new" pill beside the folder while it lands
    if (t >= insertAt + 0.2) {
      html += `<div class="abs" style="left:${X + 300}px;top:${ys[0] + 11}px;${appearFade(t, insertAt + 0.2, 1 - seg(t, bracketAt, bracketAt + 0.3), { dy: 0, dx: -8 })}"><span class="pill" style="background:#13301f;color:var(--green);font-size:22px;padding:3px 14px">${ICON.plus({ size: 18 })}your data model</span></div>`;
    }
    // Bracket over the model and the SQL.
    if (t >= bracketAt) {
      const bp = easeOut(seg(t, bracketAt, bracketAt + 0.45));
      const top = ys[0] + 8, bot = ys[7] - 8, mid = (top + bot) / 2;
      const t0 = lerp(mid, top, bp), b0 = lerp(mid, bot, bp);
      html += `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1"><path d="M${BX - 22} ${t0} H${BX} V${b0} H${BX - 22} M${BX} ${mid} H${BX + 22}" fill="none" stroke="#22c55e" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      html += `<div class="abs" style="left:${BX + 40}px;top:${mid - 74}px;white-space:nowrap;${appear(t, bracketAt + 0.2, { dy: 0, dx: -12 })}">
        <div style="font-size:38px;font-weight:800;color:var(--green);line-height:1.15">same repo</div>
        <div style="font-size:38px;font-weight:800;color:var(--green);line-height:1.15">same PR</div>
        <div style="margin-top:8px;font-size:26px;color:var(--text-2)">model next to code</div></div>`;
    }
    return html;
  },
};
