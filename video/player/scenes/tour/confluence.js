// The default cut's Confluence scene: "Your repo is the single source of truth: just DBML files, no
// modelling database. ERD Studio for Confluence reads them from GitHub, and shows the diagram to
// business users." ERD Studio for Confluence (the Atlassian Marketplace app, docs/dev/compatibility.md)
// is a read-only viewer: a macro that reads the committed .erd-studio files straight from the
// team's GitHub repo and draws the diagram on a Confluence page. Nothing here claims more: no
// editing in Confluence, no sync back, no price, never "free".
//
// Left: the repo (the GitHub mark, its .erd-studio files beside the code). Right: a light Confluence
// page (the official Confluence icon, assets/logos/, LOGOS.md) carrying a real render of the tour's
// diagram as the macro draws it (assets/confluence-sales.png; re-shoot with
// `node confluence-shot.mjs`). Between them, the line the files travel along.
import { appear, appIcon, easeOut, ICON, lerp, seg } from '../../lib.js';

/** When a phrase of a line is spoken: its share of the caption's characters, along the line's real duration. */
export function phraseAt(scene, beat, phrase) {
  const line = scene.lines.find((l) => l.beat === beat);
  const at = line.caption.indexOf(phrase);
  if (at < 0) throw new Error(`"${phrase}" is not in line ${line.id}`);
  return line.t + ((line.end - line.t) * at) / line.caption.length;
}

/** The files the repo card lists: the diagram, its tables, and the code beside them. */
export const REPO = {
  name: 'shop-analytics',
  /** Under .erd-studio/main/. */
  files: [
    ['diagrams/', 'sales.dbml'],
    ['tables/main/', 'fct_order.dbml'],
    ['tables/main/', 'dim_customer.dbml'],
    ['tables/main/', 'dim_store.dbml'],
    ['relationships/', 'main.dbml'],
  ],
  code: ['pipelines/', 'sales.sql'],
};

// The Confluence page's own light tokens (Atlassian's), not the frame's.
const L = { page: '#ffffff', bar: '#f7f8f9', line: '#dfe1e6', text: '#172b4d', text2: '#44546f', text3: '#626f86', blue: '#1868db' };
const LOGO = (f) => `/video/player/assets/logos/${f}`;
const SHOT = { w: 1200, h: 560 };   // confluence-shot.mjs SHOT (at 2x)

const RX = 96, RW = 540, RY = 292, RH = 540;          // the repo card
const PX = 744, PW = 1080, PY = 248, PH = 700;         // the Confluence page
const BAR = 56;
const MHEAD = 50;                                       // the macro's own header: its name, Read-only
const MX = PX + 28, MY = PY + BAR + 100, MW = PW - 56, MH = Math.round(MW * SHOT.h / SHOT.w);   // the macro's render

const avatar = (letter, bg, size = 30) =>
  `<span style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};color:#fff;font-size:${Math.round(size * 0.46)}px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;flex:none">${letter}</span>`;
const dbIcon = (size = 22) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/></svg>`;

export default {
  render(t, { scene }) {
    const filesAt = phraseAt(scene, 'truth', 'just DBML');
    const noDbAt = phraseAt(scene, 'truth', 'no modelling');
    const appAt = phraseAt(scene, 'confluence', 'ERD Studio for');
    const ghAt = phraseAt(scene, 'confluence', 'from GitHub');
    // the business-users pill lands soon after the page does (not on its words, at the line's end), so it holds before the end card
    const bizAt = Math.min(phraseAt(scene, 'confluence', 'business users'), phraseAt(scene, 'confluence', 'ERD Studio for') + 1.4);

    // ---- the repo ----
    const lit = easeOut(seg(t, filesAt, filesAt + 0.35));
    const fileRow = ([dir, f], i) => `<div style="display:flex;align-items:center;gap:10px;height:46px;padding:0 14px 0 34px;border-radius:9px;white-space:nowrap;
        background:rgba(37,99,235,${(0.1 * lit).toFixed(3)});border:1.5px solid rgba(37,99,235,${(0.45 * lit).toFixed(3)});${appear(t, 0.25 + i * 0.06, { dy: 6 })}">
        <span style="color:#b45309;display:flex">${ICON.file({ size: 20 })}</span><span class="mono" style="font-size:18px;color:var(--text-3)">${dir}</span><span class="mono" style="font-size:19px;color:var(--text);font-weight:600;margin-left:-10px">${f}</span></div>`;
    const codeRow = (f, i) => `<div style="display:flex;align-items:center;gap:10px;height:40px;padding:0 14px;white-space:nowrap;color:var(--text-2);${appear(t, 0.6 + i * 0.06, { dy: 6 })}">
        <span style="display:flex">${f.endsWith('/') ? ICON.folder({ size: 20 }) : ICON.file({ size: 20 })}</span><span class="mono" style="font-size:18px">${f}</span></div>`;
    let html = `<div class="card" style="left:${RX}px;top:${RY}px;width:${RW}px;height:${RH}px;box-shadow:0 24px 60px rgba(31,35,40,.14);${appear(t, 0.05, { dy: 14 })}">
      <div class="card__head" style="height:60px;font-size:22px"><div class="card__tab card__tab--on"><img src="${LOGO('github.svg')}" width="28" height="28" style="display:block;width:28px;height:28px">${REPO.name}</div><div class="card__crumb">main</div></div>
      <div class="card__body" style="padding:18px 16px;display:flex;flex-direction:column;gap:8px">
        <div class="mono" style="font-size:18px;color:var(--text-2);padding:0 14px;height:30px;display:flex;align-items:center;gap:8px;${appear(t, 0.2, { dy: 6 })}"><span style="display:flex">${ICON.folder({ size: 20 })}</span>.erd-studio/main/</div>
        ${REPO.files.map(fileRow).join('')}
        <div style="height:10px"></div>
        ${REPO.code.map(codeRow).join('')}
      </div></div>`;
    // "single source of truth" on the repo; "no modelling database" beside it
    html += `<div class="abs" style="left:${RX}px;top:${RY - 2}px;transform:translateY(-100%);display:flex;gap:10px">
      ${t >= 0.4 ? `<span class="pill" style="font-size:22px;padding:7px 16px;gap:8px;background:#e8f6ed;color:#14532d;border:1.5px solid #9ad5ae;${appear(t, 0.4, { dy: 6 })}">${ICON.check({ size: 18 })}single source of truth</span>` : ''}
      ${t >= noDbAt ? `<span class="pill" style="font-size:22px;padding:7px 16px;gap:8px;background:#fff;color:var(--text-2);border:1.5px solid #d0d7de;${appear(t, noDbAt, { dy: 6 })}">${dbIcon(19)}<s>modelling database</s></span>` : ''}</div>`;

    // ---- the Confluence page ----
    if (t >= appAt - 0.3) {
      const a0 = appAt - 0.3;
      html += `<div class="abs" style="left:${PX}px;top:${PY}px;width:${PW}px;height:${PH}px;border-radius:16px;background:${L.page};overflow:hidden;box-shadow:0 24px 60px rgba(31,35,40,.18),0 0 0 1px ${L.line};${appear(t, a0, { dy: 16, dur: 0.4 })}">
        <div class="abs" style="left:0;right:0;top:0;height:${BAR}px;background:${L.bar};border-bottom:1px solid ${L.line};display:flex;align-items:center;gap:12px;padding:0 22px;font-size:21px;color:${L.text2};white-space:nowrap">
          <img src="${LOGO('confluence.svg')}" width="30" height="30" style="display:block;width:30px;height:30px">
          <span style="font-weight:700;color:${L.text}">Confluence</span>
          <span style="color:${L.text3};margin-left:8px">${ICON.chevRight({ size: 18, sw: 2.6 })}</span>Data team
          <span style="color:${L.text3}">${ICON.chevRight({ size: 18, sw: 2.6 })}</span>Data models</div>
        <div class="abs" style="left:28px;top:${BAR + 18}px;display:flex;align-items:baseline;gap:18px;white-space:nowrap">
          <span style="font-size:38px;font-weight:800;letter-spacing:-.02em;color:${L.text}">Sales data model</span>
          <span style="display:flex;align-items:center;gap:10px;font-size:20px;color:${L.text2}">${avatar('D', L.blue, 26)}Data team</span></div>
      </div>`;
      // the macro: its header (name, Read-only), the real render, its source underneath
      const mp = easeOut(seg(t, a0 + 0.25, a0 + 0.7));
      const ih = MH - MHEAD;
      html += `<div class="abs" style="left:${MX}px;top:${MY}px;width:${MW}px;height:${MH}px;border-radius:10px;overflow:hidden;border:1px solid ${L.line};background:#fff;opacity:${mp.toFixed(3)};transform:translateY(${lerp(10, 0, mp).toFixed(1)}px)">
        <div style="height:${MHEAD}px;display:flex;align-items:center;gap:10px;padding:0 10px;background:${L.bar};border-bottom:1px solid ${L.line}">
          <span class="pill" style="font-size:20px;padding:5px 14px 5px 6px;gap:9px;background:#0b1422;color:#fff">${appIcon(26, 'box-shadow:none;border-radius:6px')}ERD Studio for Confluence</span>
          <span style="flex:1"></span>
          <span class="pill" style="font-size:18px;padding:4px 12px;gap:7px;background:#fff;color:${L.text2};border:1px solid ${L.line}">${ICON.lock({ size: 15 })}Read-only</span></div>
        <div style="height:${ih}px;display:flex;justify-content:center;overflow:hidden"><img src="/video/player/assets/confluence-sales.png" height="${ih}" width="${Math.round(ih * SHOT.w / SHOT.h)}" style="display:block;height:${ih}px;width:${Math.round(ih * SHOT.w / SHOT.h)}px"></div></div>`;
      const gh = Math.sin(Math.PI * seg(t, ghAt, ghAt + 0.6));
      html += `<div class="abs" style="left:${MX}px;top:${MY + MH + 12}px;display:flex;align-items:center;gap:10px;font-size:19px;color:${L.text3};white-space:nowrap;${appear(t, a0 + 0.6, { dy: 4 })}">
        <img src="${LOGO('github.svg')}" width="22" height="22" style="display:block;width:22px;height:22px;transform:scale(${(1 + 0.3 * gh).toFixed(3)})">
        <span>${REPO.name} · main ·</span><span class="mono" style="font-size:17px">.erd-studio/main/diagrams/sales.dbml</span></div>`;
      if (t >= bizAt) {
        const p = easeOut(seg(t, bizAt, bizAt + 0.4));
        html += `<div class="abs" style="right:${1920 - (PX + PW) + 28}px;top:${PY + BAR + 22}px;opacity:${p.toFixed(3)};transform:scale(${lerp(0.9, 1, p).toFixed(3)});transform-origin:100% 50%">
          <span class="pill" style="font-size:21px;padding:7px 16px;gap:9px;background:#dcfff1;border:2px solid #4bce97;color:#216e4e">${ICON.check({ size: 19 })}For business users: no VS Code needed</span></div>`;
      }
    }

    // ---- the line from the repo to the page, the files travelling along it ----
    if (t >= ghAt - 0.4) {
      const x0 = RX + RW + 10, x1 = PX - 10, y = PY + 300;
      const grow = easeOut(seg(t, ghAt - 0.4, ghAt + 0.2));
      let sv = `<path d="M${x0} ${y} H${lerp(x0, x1, grow)}" stroke="#2563eb" stroke-width="4" fill="none" stroke-linecap="round"/>`;
      if (grow >= 1) for (let k = 0; k < 2; k++) { const q = (t * 0.8 + k * 0.5) % 1; sv += `<circle cx="${lerp(x0, x1, q)}" cy="${y}" r="6" fill="#60a5fa"/>`; }
      sv += `<path d="M${x1 - 12} ${y - 9} L${x1} ${y} L${x1 - 12} ${y + 9}" stroke="#2563eb" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${grow >= 1 ? 1 : 0}"/>`;
      html += `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1">${sv}</svg>`;
      html += `<div class="abs" style="left:${x0}px;width:${x1 - x0}px;top:${y + 14}px;text-align:center;font-size:18px;line-height:1.3;color:var(--text-2);${appear(t, ghAt, { dy: 0 })}">reads the<br>committed files</div>`;
    }
    return html;
  },
};
