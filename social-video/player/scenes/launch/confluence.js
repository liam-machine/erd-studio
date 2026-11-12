// launch · 7 · confluence — "For the business: view it in Confluence." ERD Studio for Confluence
// (the Atlassian Marketplace app, docs/dev/compatibility.md): a Confluence macro that reads the
// committed `.erd-studio/` DBML straight from the team's GitHub repo and draws it, read-only, on a
// page. Nothing claims more: no editing in Confluence, no price, never "free". Trimmed from
// readme/confluence.js: the repo card on top, the Confluence page under it carrying a REAL render
// of a diagram as the macro draws it (@erd-studio/renderer's ErdCanvas in viewer mode,
// assets/<shot>.png from confluence-shot.mjs), and the macro's source line.
// `app`: the macro is named on "ERD Studio for Confluence"; on "reads" the repo's line draws down
// into the page; "GitHub" pulses the mark. `view`: "business users" adds the page's viewers,
// "view the data model" glows the macro (Read-only), "no VS Code" lands the pill.
import { appear, appIcon, easeOut, ICON, lerp, seg } from '../../lib.js';
import { wordAt } from '../readme/story.js';

// The README cut's real render of the same sales diagram the fix act edits (fct_order with status).
const SHOT = { file: 'confluence-sales.png', w: 1760, h: 1110 };
const PX = 64, PW = 952;
const RY = 300, RH = 128;
const PY = 470, PH = 1090 - PY;
const BAR = 56;
const IN = PX + 32;
const SRC = 44;
const MY = PY + BAR + 70, MH = 1086 - SRC - MY, MW = Math.round(MH * SHOT.w / SHOT.h), MX = PX + Math.round((PW - MW) / 2);
const REPO = 'acme-analytics';
const L = { page: '#ffffff', bar: '#f7f8f9', line: '#dfe1e6', text: '#172b4d', text2: '#44546f', text3: '#626f86', blue: '#1868db' };
const LOGO = (f) => `/social-video/player/assets/logos/${f}`;
const FOLDERS = ['gold/tables/', 'gold/relationships/', 'gold/diagrams/'];
const avatar = (letter, bg, size = 34) =>
  `<span style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};color:#fff;font-size:${Math.round(size * 0.46)}px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;flex:none;box-shadow:0 0 0 3px #fff">${letter}</span>`;

export default {
  render(t, { scene }) {
    const nameAt = wordAt(scene, 'app', 'ERD Studio for');
    const readsAt = wordAt(scene, 'app', 'reads') - 0.1;
    const dbmlAt = wordAt(scene, 'app', 'DBML');
    const ghAt = wordAt(scene, 'app', 'GitHub');
    const usersAt = wordAt(scene, 'view', 'business') - 0.1;
    const viewAt = wordAt(scene, 'view', 'view the');
    const noAt = wordAt(scene, 'view', 'no VS Code') - 0.15;

    // ---- the page ----
    const viewers = easeOut(seg(t, usersAt, usersAt + 0.35));
    let html = `<div class="abs" style="left:${PX}px;top:${PY}px;width:${PW}px;height:${PH}px;border-radius:20px;background:${L.page};overflow:hidden;box-shadow:0 30px 80px #000c, 0 0 0 1px #ffffff1a;${appear(t, 0)}">
      <div class="abs" style="left:0;right:0;top:0;height:${BAR}px;background:${L.bar};border-bottom:1px solid ${L.line};display:flex;align-items:center;gap:12px;padding:0 20px;font-size:22px;color:${L.text2};white-space:nowrap">
        <img src="${LOGO('confluence.svg')}" width="32" height="32" style="display:block;width:32px;height:32px">
        <span style="font-weight:700;color:${L.text}">Confluence</span>
        <span style="color:${L.text3};margin-left:8px">${ICON.chevRight({ size: 18, sw: 2.6 })}</span>Data team
        <span style="color:${L.text3}">${ICON.chevRight({ size: 18, sw: 2.6 })}</span>Data models
        <span style="flex:1"></span>
        <span style="display:inline-flex;align-items:center;margin-right:6px;opacity:${viewers.toFixed(3)};transform:translateX(${(10 * (1 - viewers)).toFixed(1)}px)">${avatar('F', '#8f7ee7', 32)}<span style="margin-left:-8px">${avatar('O', '#22a06b', 32)}</span><span style="margin-left:-8px">${avatar('M', '#e56910', 32)}</span></span>
        <span style="display:inline-flex;align-items:center;padding:4px 16px;border-radius:6px;background:${L.blue};color:#fff;font-weight:600">Share</span></div>
      <div class="abs" style="left:${IN - PX}px;top:${BAR + 14}px;font-size:40px;font-weight:800;letter-spacing:-.02em;color:${L.text};white-space:nowrap">Sales data model</div>
    </div>`;

    // ---- the macro: the real render ----
    const glow = seg(t, viewAt, viewAt + 0.25) * (1 - seg(t, viewAt + 0.9, viewAt + 1.7));
    const mp = easeOut(seg(t, 0.15, 0.6));
    html += `<div class="abs" style="left:${MX}px;top:${MY}px;width:${MW}px;height:${MH}px;border-radius:12px;overflow:hidden;border:1px solid ${L.line};background:#fff;opacity:${mp.toFixed(3)};transform:translateY(${lerp(12, 0, mp).toFixed(1)}px);box-shadow:0 0 0 ${(3 * glow).toFixed(2)}px rgba(24,104,219,${(0.55 * glow).toFixed(3)}), 0 0 ${Math.round(40 * glow)}px rgba(24,104,219,${(0.35 * glow).toFixed(3)})">
      <img src="/social-video/player/assets/${SHOT.file}" width="${MW}" height="${MH}" style="display:block;width:${MW}px;height:${MH}px"></div>`;
    html += `<div class="abs mono" style="left:${MX + 4}px;top:${MY + MH + 12}px;font-size:18px;color:${L.text3};white-space:nowrap;opacity:${mp.toFixed(3)}">${REPO} · main · a1f9c2e</div>`;
    if (t >= nameAt) {
      html += `<div class="abs" style="right:${1080 - PX - PW + 28}px;top:${PY + BAR + 16}px;${appear(t, nameAt, { dy: 8 })}"><span class="pill" style="font-size:23px;padding:8px 16px 8px 9px;gap:11px;background:#0b1422;color:#fff;box-shadow:0 10px 30px #0004">${appIcon(30, 'box-shadow:none;border-radius:7px')}ERD Studio for Confluence</span></div>`;
    }
    const tags = [];
    if (t >= viewAt) tags.push(`<span class="pill" style="font-size:19px;padding:4px 12px;gap:7px;background:#f1f2f4;color:${L.text2};border:1px solid ${L.line};${appear(t, viewAt, { dy: 6 })}">${ICON.lock({ size: 16 })}Read-only</span>`);
    if (t >= noAt) {
      const p = easeOut(seg(t, noAt, noAt + 0.4));
      tags.push(`<span class="pill" style="font-size:20px;padding:4px 14px;gap:8px;background:#dcfff1;border:2px solid #4bce97;color:#216e4e;opacity:${p.toFixed(3)};transform:scale(${lerp(0.9, 1, p).toFixed(3)});transform-origin:100% 50%">${ICON.check({ size: 18 })}No VS Code needed</span>`);
    }
    if (tags.length) html += `<div class="abs" style="right:${1080 - (PX + PW) + 24}px;top:${MY + MH + 6}px;display:flex;gap:10px;align-items:center">${tags.join('')}</div>`;

    // ---- the repo ----
    const repoAt = 0.1;
    const gh = Math.sin(Math.PI * seg(t, ghAt, ghAt + 0.5));
    const lit = easeOut(seg(t, dbmlAt, dbmlAt + 0.3)) * (1 - 0.6 * seg(t, dbmlAt + 1.6, dbmlAt + 2.4));
    const chips = FOLDERS.map((f, i) => `<span style="display:inline-flex;align-items:center;gap:8px;height:42px;padding:0 13px;border-radius:9px;background:rgba(232,162,74,${(0.06 + 0.2 * lit).toFixed(3)});border:1.5px solid rgba(232,162,74,${(0.25 + 0.7 * lit).toFixed(3)});white-space:nowrap;${appear(t, repoAt + 0.2 + i * 0.08, { dy: 6 })}"><span style="color:#e8a24a;display:flex">${ICON.folder({ size: 20 })}</span><span class="mono" style="font-size:20px">${f}</span></span>`).join('');
    html += `<div class="card" style="left:${PX}px;top:${RY}px;width:${PW}px;height:${RH}px;${appear(t, repoAt, { dy: -20, dur: 0.4 })}">
      <div class="card__head" style="height:56px;font-size:22px"><div class="card__tab card__tab--on"><img src="${LOGO('github.svg')}" width="26" height="26" style="display:block;width:26px;height:26px;background:#fff;border-radius:50%;transform:scale(${(1 + 0.25 * gh).toFixed(3)})">${REPO}</div><div class="card__crumb">main › .erd-studio/</div></div>
      <div class="card__body" style="top:56px"><div class="abs" style="left:20px;right:20px;top:14px;display:flex;gap:10px">${chips}</div></div></div>`;
    // The line from the repo down to the page, the files flowing along it.
    const y0 = RY + RH + 4, y1 = PY - 4, ax = 540;
    const grow = easeOut(seg(t, readsAt, readsAt + 0.35));
    let sv = `<path d="M${ax} ${y0} V${lerp(y0, y1, grow)}" stroke="#4c9aff" stroke-width="4" fill="none"/>`;
    if (grow >= 1) for (let k = 0; k < 2; k++) { const q = ((t * 0.9 + k * 0.5) % 1); sv += `<circle cx="${ax}" cy="${lerp(y0, y1, q)}" r="5" fill="#85b8ff"/>`; }
    html += `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1">${sv}</svg>`;
    if (t >= readsAt + 0.2 && t < wordAt(scene, 'truth', 'open format') - 0.1) html += `<div class="abs" style="left:${ax + 20}px;top:${y0 + 2}px;font-size:20px;color:var(--text-2);white-space:nowrap;${appear(t, readsAt + 0.2, { dy: 0, dx: -8 })}">reads the committed DBML</div>`;
    // `truth`: the one connection is the whole pipeline. On "single source of truth" the repo card gets
    // the badge; on "No vendor in the middle" a struck-through cloud lands beside the line (nothing
    // sits between GitHub and Confluence); on "open format" the line's label says what is rendered.
    const truthAt = wordAt(scene, 'truth', 'single source');
    const vendorAt = wordAt(scene, 'truth', 'No vendor') - 0.1;
    const openAt = wordAt(scene, 'truth', 'open format') - 0.1;
    if (t >= truthAt) {
      const p = easeOut(seg(t, truthAt, truthAt + 0.4));
      html += `<div class="abs" style="left:${PX + PW - 372}px;top:${RY + 8}px;${appear(t, truthAt, { dy: -8 })}"><span class="pill" style="font-size:22px;padding:7px 16px;gap:8px;background:rgba(34,197,94,${(0.1 + 0.12 * p).toFixed(3)});border:2px solid #22c55e;color:#4ade80;transform:scale(${(1 + 0.06 * Math.sin(Math.PI * p)).toFixed(3)})">${ICON.check({ size: 20 })}Single source of truth</span></div>`;
    }
    if (t >= vendorAt) {
      html += `<div class="abs" style="right:${1080 - (ax - 22)}px;top:${y0 - 2}px;white-space:nowrap;${appear(t, vendorAt, { dy: 0, dx: 10 })}"><span class="pill" style="font-size:20px;padding:5px 14px;gap:8px;background:#2a1a1a;border:2px solid #f87171;color:#fca5a5"><span style="text-decoration:line-through">vendor cloud</span> · nothing in the middle</span></div>`;
    }
    if (t >= openAt) {
      html += `<div class="abs" style="left:${ax + 20}px;top:${y0 + 2}px;font-size:20px;color:var(--text-2);white-space:nowrap;background:var(--bg, #0b0f17);padding-right:8px;${appear(t, openAt, { dy: 0, dx: -8 })}">renders the DBML, an open format</div>`;
    }
    return html;
  },
};
