// 4 · Flip it. A two-slot priority stack ("who the model is built for") physically swaps:
// developers (+ their AI) move to slot 1, business users drop to slot 2 as "sees a rendered
// view". Then a VS Code-style explorer: the dbt repo, and the .erd-studio model files slide in
// right next to the SQL, bracketed "same repo · same PR".
import { appear, card, clamp, easeInOut, easeOut, ICON, lerp, seg } from '../lib.js';

const L = 64, R = 1016, W = R - L;

// ---- local icons (the font subsets have no glyphs for these) ----
const personIcon = (size, col) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${col}"><circle cx="12" cy="8" r="4.2"/><path d="M3.8 21c.6-4.6 4-7.2 8.2-7.2s7.6 2.6 8.2 7.2z"/></svg>`;
const codeIcon = (size, col) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4.5l-3 15"/></svg>`;

// ---- priority stack geometry ----
const LABEL_Y = 480;
const SLOT_Y = [530, 730];          // slot 1, slot 2 (row tops)
const ROW_H = 172, ROW_X = 166, ROW_W = R - ROW_X;

function slotBadge(n, y, green) {
  const bg = green ? '#13301f' : '#24262c', fg = green ? 'var(--green)' : 'var(--text-2)', bd = green ? 'var(--green)' : '#3a3d45';
  return `<div class="abs" style="left:${L}px;top:${y + ROW_H / 2 - 38}px;width:76px;height:76px;border-radius:50%;background:${bg};border:3px solid ${bd};color:${fg};display:flex;align-items:center;justify-content:center;font-size:40px;font-weight:800">${n}</div>`;
}

function stackRow({ y, scale, z, border, bg, icon, iconBg, title, extra = '', subA, subB, subP, op = 1 }) {
  const sub = (s, o) => `<div class="abs" style="left:0;top:0;white-space:nowrap;opacity:${o.toFixed(3)}">${s}</div>`;
  return `<div class="abs" style="left:${ROW_X}px;top:${y.toFixed(1)}px;width:${ROW_W}px;height:${ROW_H}px;border-radius:22px;background:${bg};border:3px solid ${border};box-shadow:0 24px 60px #000a;transform:scale(${scale.toFixed(4)});transform-origin:50% 50%;z-index:${z};opacity:${op.toFixed(3)}">
    <div class="abs" style="left:28px;top:${(ROW_H - 6 - 96) / 2}px;width:96px;height:96px;border-radius:20px;background:${iconBg};display:flex;align-items:center;justify-content:center">${icon}</div>
    <div class="abs" style="left:150px;top:30px;display:flex;align-items:center;gap:18px;font-size:44px;font-weight:800;letter-spacing:-.015em;white-space:nowrap">${title}${extra}</div>
    <div class="abs" style="left:150px;top:100px;width:${ROW_W - 180}px;height:40px;font-size:28px;color:var(--text-2)">${sub(subA, 1 - subP)}${sub(subB, subP)}</div>
  </div>`;
}

// ---- explorer tree ----
const TREE_X = L, TREE_Y = 376, TREE_H = 700;
const PITCH = 55;
const BX = 712;                     // bracket x
const HL_W = BX - 36 - TREE_X;
const ROWS_TOP = TREE_Y + 64 + 18;
const YML = '#d9b35a', JSON_C = 'var(--syn-val)', SQL = '#78c0f4';
// Final tree order (VS Code sorts dot-folders first). `at` = insertion time for the new rows.
const TREE = [
  { d: 0, name: '.erd-studio', dir: true, isNew: true, k: 0 },
  { d: 1, name: 'logical-models', dir: true, isNew: true, k: 1 },
  { d: 2, name: 'dim_customer.yml', col: YML, isNew: true, k: 2 },
  { d: 2, name: 'fct_order.yml', col: YML, isNew: true, k: 3 },
  { d: 1, name: 'silver', dir: true, isNew: true, k: 4 },
  { d: 2, name: 'orders.json', col: JSON_C, isNew: true, k: 5 },
  { d: 0, name: 'models', dir: true },
  { d: 1, name: 'marts', dir: true },
  { d: 2, name: 'dim_customer.sql', col: SQL },
  { d: 2, name: 'fct_order.sql', col: SQL },
  { d: 0, name: 'dbt_project.yml', col: YML },
];

export default {
  render(t, { beats }) {
    const f = beats.flip.t, r = beats.repo.t;
    // flip beat: "So flip it" (+0.0..0.8) -> the rows swap; "developers first" (~+2.1) -> green.
    const swapAt = f + 0.5, swapEnd = swapAt + 0.95;
    const p = easeInOut(seg(t, swapAt, swapEnd));
    const bump = Math.sin(Math.PI * p);
    const devOn = seg(t, f + 1.9, f + 2.3);          // "…for developers first"
    const aiAt = f + 2.35;
    // repo beat: stack gives way to the explorer; model files slide in on "…in the repo" (~+0.9).
    const outAt = r - 0.15;
    const stackOp = 1 - seg(t, outAt, outAt + 0.35);
    const stackDy = -40 * easeOut(seg(t, outAt, outAt + 0.35));
    const insertAt = r + 0.45;
    const bracketAt = r + 1.45;                      // "…right next to the SQL"

    let html = '';

    // ---------------- priority stack ----------------
    if (stackOp > 0) {
      let s = `<div class="abs" style="left:${L}px;top:${LABEL_Y - 30}px;font-size:24px;font-weight:800;letter-spacing:.16em;color:var(--text-3);white-space:nowrap;${appear(t, 0.1)}">WHO THE MODEL IS BUILT FOR</div>`;
      s += slotBadge(1, SLOT_Y[0], devOn > 0.5);
      s += slotBadge(2, SLOT_Y[1], false);
      const busY = lerp(SLOT_Y[0], SLOT_Y[1], p), devY = lerp(SLOT_Y[1], SLOT_Y[0], p);
      const subP = seg(t, swapAt + 0.55, swapAt + 0.95);
      s += stackRow({
        y: busY, scale: 1 - 0.05 * bump, z: 1, op: 1 - 0.3 * bump,
        border: '#34363d', bg: '#191a1e',
        icon: personIcon(56, '#9aa0aa'), iconBg: '#262830',
        title: 'Business users',
        subA: 'Owns the diagram, in a separate tool', subB: 'Sees a rendered view of the same files', subP,
      });
      const g = devOn;
      const devBorder = g > 0 ? `rgba(34,197,94,${(0.35 + 0.65 * g).toFixed(3)})` : '#34363d';
      s += stackRow({
        y: devY, scale: 1 + 0.05 * bump, z: 2,
        border: devBorder, bg: g > 0 ? `rgba(19,48,31,${(0.55 * g).toFixed(3)})` : '#191a1e',
        icon: codeIcon(58, g > 0.5 ? '#22c55e' : '#9aa0aa'), iconBg: g > 0.5 ? '#13301f' : '#262830',
        title: 'Developers',
        extra: t >= aiAt ? `<span class="pill" style="background:#1b2a40;color:#cfe3ff;font-size:26px;padding:8px 18px;${appear(t, aiAt, { dy: 0, dx: -10 })}">${ICON.sparkle({ size: 24 })}and their AI</span>` : '',
        subA: 'Work backwards from the picture', subB: 'Own the model as files, next to the SQL', subP,
      });
      html += `<div class="abs" style="left:0;top:0;width:1080px;height:1350px;opacity:${stackOp.toFixed(3)};transform:translateY(${stackDy.toFixed(1)}px)">${s}</div>`;
    }

    // ---------------- repo explorer ----------------
    if (t >= r - 0.1) {
      // Compact reminder of the flip, above the explorer.
      html += `<div class="abs" style="left:${L}px;top:300px;height:56px;display:flex;align-items:center;gap:16px;white-space:nowrap;${appear(t, r)}">
        <span style="width:48px;height:48px;border-radius:50%;background:#13301f;border:3px solid var(--green);color:var(--green);display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800">1</span>
        <span style="font-size:32px;font-weight:800">Developers first</span>
        <span style="font-size:26px;color:var(--text-2)">· the business sees a rendered view</span></div>`;

      html += card({
        x: TREE_X, y: TREE_Y, w: W, h: TREE_H,
        tabs: [{ label: 'Explorer', on: true, icon: `<span style="color:#7f8792">${ICON.folder({ size: 24 })}</span>` }],
        crumb: 'acme-analytics · main', headStyle: 'font-size:24px', style: appear(t, r - 0.1, { dy: 24 }),
      });

      let y = ROWS_TOP;
      let rows = '';
      let firstNewY = null, lastSqlY = null;
      for (const row of TREE) {
        const q = row.isNew ? easeOut(seg(t, insertAt + row.k * 0.13, insertAt + row.k * 0.13 + 0.32)) : 1;
        if (q <= 0) continue;
        const h = PITCH * q;
        if (row.isNew && firstNewY === null) firstNewY = y;
        if (row.name.endsWith('.sql')) lastSqlY = y + h;
        const indent = TREE_X + 26 + row.d * 38;
        const glow = row.isNew ? 1 - 0.45 * seg(t, bracketAt + 0.6, bracketAt + 1.4) : 0;
        const hl = row.isNew
          ? `<div class="abs" style="left:${TREE_X + 2}px;top:${(y + 3).toFixed(1)}px;width:${HL_W}px;height:${(h - 6).toFixed(1)}px;background:rgba(34,197,94,${(0.13 * glow).toFixed(3)});border-left:5px solid rgba(34,197,94,${(0.95 * glow).toFixed(3)});opacity:${q.toFixed(3)}"></div>`
          : '';
        const icon = row.dir
          ? `<span style="color:var(--text-3)">${ICON.chevDown({ size: 20, sw: 2.6 })}</span><span style="color:${row.isNew ? 'var(--green)' : '#7f8792'}">${ICON.folder({ size: 28 })}</span>`
          : `<span style="display:inline-block;width:20px"></span><span style="color:${row.col}">${ICON.file({ size: 26 })}</span>`;
        const label = row.dir
          ? `<span style="font-size:27px;font-weight:600;color:${row.isNew ? '#d9fbe5' : 'var(--text)'}">${row.name}</span>`
          : `<span class="mono" style="font-size:26px;color:${row.isNew ? '#d9fbe5' : 'var(--text)'}">${row.name}</span>`;
        const tag = row.isNew && !row.dir
          ? `<span class="pill" style="margin-left:6px;background:#13301f;color:var(--green);font-size:24px;padding:3px 14px">${ICON.plus({ size: 18 })}new</span>`
          : '';
        // Each row is clipped to its (growing) height, so an inserting row unrolls instead of overlapping.
        rows += hl + `<div class="abs" style="left:${indent}px;top:${y.toFixed(1)}px;width:${BX - 40 - indent}px;height:${h.toFixed(1)}px;overflow:hidden"><div class="abs" style="left:0;top:${(PITCH - 44) / 2}px;height:44px;display:flex;align-items:center;gap:12px;white-space:nowrap;opacity:${q.toFixed(3)};transform:translateX(${(-14 * (1 - q)).toFixed(1)}px)">${icon}${label}${tag}</div></div>`;
        y += h;
      }
      // Rows are clipped by the card body box so the push-down never spills past the card.
      html += `<div class="abs" style="left:${TREE_X}px;top:${TREE_Y + 65}px;width:${W}px;height:${TREE_H - 66}px;overflow:hidden;border-radius:0 0 20px 20px;${appear(t, r - 0.1, { dy: 24 })}"><div class="abs" style="left:${-TREE_X}px;top:${-(TREE_Y + 65)}px;width:1080px;height:1350px">${rows}</div></div>`;

      // Bracket: model files + SQL, "same repo · same PR".
      if (t >= bracketAt && firstNewY !== null && lastSqlY !== null) {
        const bp = easeOut(seg(t, bracketAt, bracketAt + 0.45));
        const top = firstNewY + 8, bot = lastSqlY - 8;
        const mid = (top + bot) / 2;
        const t0 = lerp(mid, top, bp), b0 = lerp(mid, bot, bp);
        const bx = BX;
        html += `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1"><path d="M${bx - 22} ${t0} H${bx} V${b0} H${bx - 22} M${bx} ${mid} H${bx + 22}" fill="none" stroke="#22c55e" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        html += `<div class="abs" style="left:${bx + 40}px;top:${mid - 74}px;white-space:nowrap;${appear(t, bracketAt + 0.2, { dy: 0, dx: -12 })}">
          <div style="font-size:38px;font-weight:800;color:var(--green);line-height:1.15">same repo</div>
          <div style="font-size:38px;font-weight:800;color:var(--green);line-height:1.15">same PR</div>
          <div style="margin-top:8px;font-size:26px;color:var(--text-2)">design next to SQL</div></div>`;
      }
    }
    return html;
  },
};
