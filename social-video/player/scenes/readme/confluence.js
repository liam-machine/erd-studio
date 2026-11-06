// readme · 15 · confluence — "For the business: view it in Confluence." ERD Studio for Confluence,
// the Atlassian Marketplace app (docs/dev/compatibility.md): a Confluence macro that reads the
// committed `.erd-studio/` folder straight from the team's GitHub repo and draws a diagram,
// read-only, on a page. Nothing here claims more than that: no editing in Confluence, no sync
// back, no price, never "free".
//
// Top: the team's repo (the GitHub mark, acme-analytics › .erd-studio/, its folders). Below it,
// joined by a line the files flow down, a light Confluence page (the official Confluence icon in
// its top bar, assets/logos/, LOGOS.md) carrying a real render of the diagram as the macro draws
// it (@erd-studio/renderer's ErdCanvas in viewer mode, assets/confluence-sales*.png; re-shoot with
// `node confluence-shot.mjs`): dim_customer and fct_order in the gold layer. Under the render, the
// macro's own source line (repo · branch · short commit), as the app prints it.
// `app`: "ERD Studio for Confluence" names the macro; on "connects" the repo arrives and the line
// draws; the GitHub mark pulses on "GitHub". `db`: "database" tags the repo, "DBML files" lights
// its folders, "drawn as a diagram" glows the macro (Read-only chip), "anyone can read" adds
// "No VS Code needed". `truth`: "one source of truth" on the line; a developer's commit ("Add
// status to fct_order") lands in the repo, and the macro redraws from it — `status` appears in
// fct_order, lit, and the source line's commit becomes a1f9c2e; "not another SaaS product" —
// nothing else to update.
// Says "DBML files": Liam's call (PR #246) is that ERD Studio for Confluence moves to core 0.4.0
// with the `dbml` reader (docs/dev/compatibility.md → "The 2.0 format") before this video ships.
import { appear, appIcon, easeOut, ICON, lerp, seg } from '../../lib.js';
import { R, wordAt } from './story.js';

const PX = 64, PW = 952;
const RY = 300, RH = 170;                          // the repo card, y 300..470
const PY = 512, PH = 1090 - PY;                    // the page, y 512..1090
const BAR = 56;
const IN = PX + 32;
// The macro: the real render, 1760x1110 px.
const SRC = 34;                                    // the macro's source line under the render
const MY = PY + BAR + 70, MH = 1080 - SRC - MY, MW = Math.round(MH * 1760 / 1110), MX = PX + Math.round((PW - MW) / 2);
const K = MW / 1760;                               // render px → frame px
// fct_order's status row in the render (1760x1110 px): lit when the commit's redraw adds it.
const STATUS = { x: 1150, y: 512, w: 528, h: 64 };
const OLD_SHA = '7c03b5d', NEW_SHA = 'a1f9c2e';

// Light-theme tokens (the Confluence page, not the dark video frame).
const L = { page: '#ffffff', bar: '#f7f8f9', line: '#dfe1e6', text: '#172b4d', text2: '#44546f', text3: '#626f86', blue: '#1868db' };
const LOGO = (f) => `/social-video/player/assets/logos/${f}`;
const FOLDERS = ['gold/tables/', 'gold/relationships/', 'gold/diagrams/'];   // the layer's folders
const dbIcon = (size = 22) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/></svg>`;

const avatar = (letter, bg, size = 34) =>
  `<span style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};color:#fff;font-size:${Math.round(size * 0.46)}px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;flex:none">${letter}</span>`;

export default {
  render(t, { scene }) {
    const nameAt = wordAt(scene, 'app', 'ERD Studio for');
    const connAt = wordAt(scene, 'app', 'connects') - 0.1;
    const repoAt = Math.min(connAt, nameAt + 0.4);   // the repo is there as the app is named; the line draws on "connects"
    const ghAt = wordAt(scene, 'app', 'GitHub');
    const dbAt = wordAt(scene, 'db', 'database');
    const filesAt = wordAt(scene, 'db', 'DBML files');
    const drawnAt = wordAt(scene, 'db', 'drawn');
    const anyoneAt = wordAt(scene, 'db', 'anyone') - 0.2;
    const truthAt = wordAt(scene, 'truth', 'source');
    const devAt = wordAt(scene, 'truth', 'developers');
    const saasAt = wordAt(scene, 'truth', 'not another');

    // ---- the page ----
    const updAt = devAt + 0.9;                       // the macro redraws from the new commit
    const updated = t >= updAt;
    let html = `<div class="abs" style="left:${PX}px;top:${PY}px;width:${PW}px;height:${PH}px;border-radius:20px;background:${L.page};overflow:hidden;box-shadow:0 30px 80px #000c, 0 0 0 1px #ffffff1a;${appear(t, 0)}">
      <div class="abs" style="left:0;right:0;top:0;height:${BAR}px;background:${L.bar};border-bottom:1px solid ${L.line};display:flex;align-items:center;gap:12px;padding:0 20px;font-size:22px;color:${L.text2};white-space:nowrap">
        <img src="${LOGO('confluence.svg')}" width="32" height="32" style="display:block;width:32px;height:32px">
        <span style="font-weight:700;color:${L.text}">Confluence</span>
        <span style="color:${L.text3};margin-left:8px">${ICON.chevRight({ size: 18, sw: 2.6 })}</span>Data team
        <span style="color:${L.text3}">${ICON.chevRight({ size: 18, sw: 2.6 })}</span>Data models
        <span style="flex:1"></span>
        <span style="display:inline-flex;align-items:center;padding:4px 16px;border-radius:6px;background:${L.blue};color:#fff;font-weight:600">Share</span></div>
      <div class="abs" style="left:${IN - PX}px;top:${BAR + 14}px;display:flex;align-items:baseline;gap:18px;white-space:nowrap">
        <span style="font-size:40px;font-weight:800;letter-spacing:-.02em;color:${L.text}">Sales data model</span>
        <span style="display:flex;align-items:center;gap:10px;font-size:21px;color:${L.text2}">${avatar('D', L.blue, 28)}Data team</span></div>
    </div>`;

    // ---- the macro: the real render ----
    const glow = seg(t, drawnAt, drawnAt + 0.25) * (1 - seg(t, drawnAt + 0.8, drawnAt + 1.6));
    const mp = easeOut(seg(t, 0.15, 0.6));
    // Before the commit: fct_order without status (confluence-sales-before.png); after it, the
    // macro's redraw cross-fades to the render with it, and the new row is lit for a moment.
    const redraw = easeOut(seg(t, updAt, updAt + 0.4));
    const rowLit = redraw * (1 - seg(t, updAt + 1.6, updAt + 2.4));
    const img = (f, op) => `<img src="/social-video/player/assets/${f}" width="${MW}" height="${MH}" style="position:absolute;left:0;top:0;display:block;width:${MW}px;height:${MH}px;opacity:${op.toFixed(3)}">`;
    html += `<div class="abs" style="left:${MX}px;top:${MY}px;width:${MW}px;height:${MH}px;border-radius:12px;overflow:hidden;border:1px solid ${L.line};background:#fff;opacity:${mp.toFixed(3)};transform:translateY(${lerp(12, 0, mp).toFixed(1)}px);box-shadow:0 0 0 ${(3 * glow).toFixed(2)}px rgba(24,104,219,${(0.55 * glow).toFixed(3)}), 0 0 ${Math.round(40 * glow)}px rgba(24,104,219,${(0.35 * glow).toFixed(3)})">
      ${img('confluence-sales-before.png', 1)}${redraw > 0 ? img('confluence-sales.png', redraw) : ''}
      ${rowLit > 0 ? `<div style="position:absolute;left:${Math.round(STATUS.x * K)}px;top:${Math.round(STATUS.y * K)}px;width:${Math.round(STATUS.w * K)}px;height:${Math.round(STATUS.h * K)}px;border-radius:4px;background:rgba(34,160,107,${(0.16 * rowLit).toFixed(3)});box-shadow:inset 4px 0 0 rgba(34,160,107,${rowLit.toFixed(3)})"></div>` : ''}</div>`;
    // The macro's source line: repo · branch · commit, as the app prints it under the diagram.
    html += `<div class="abs mono" style="left:${MX + 4}px;top:${MY + MH + 8}px;font-size:18px;color:${L.text3};white-space:nowrap;opacity:${mp.toFixed(3)}">${R.repo} · main · <span style="${updated ? `color:#216e4e;font-weight:700;` : ''}">${updated ? NEW_SHA : OLD_SHA}</span></div>`;
    if (t >= nameAt) {
      html += `<div class="abs" style="left:${MX + 16}px;top:${MY + 14}px;${appear(t, nameAt, { dy: 8 })}"><span class="pill" style="font-size:23px;padding:8px 16px 8px 9px;gap:11px;background:#0b1422;color:#fff;box-shadow:0 10px 30px #0006">${appIcon(30, 'box-shadow:none;border-radius:7px')}ERD Studio for Confluence</span></div>`;
    }
    if (t >= drawnAt) {
      html += `<div class="abs" style="right:${1080 - (MX + MW - 14)}px;top:${MY + 14}px;${appear(t, drawnAt, { dy: 6 })}">
        <span class="pill" style="font-size:20px;padding:6px 13px;gap:8px;background:#f1f2f4;color:${L.text2};border:1px solid ${L.line}">${ICON.lock({ size: 17 })}Read-only</span></div>`;
    }
    if (t >= anyoneAt) {
      const p = easeOut(seg(t, anyoneAt, anyoneAt + 0.4));
      html += `<div class="abs" style="left:${MX + 16}px;top:${MY + 70}px;opacity:${p.toFixed(3)};transform:scale(${lerp(0.9, 1, p).toFixed(3)});transform-origin:0 50%">
        <span class="pill" style="font-size:22px;padding:7px 16px;gap:9px;background:#dcfff1;border:2px solid #4bce97;color:#216e4e">${ICON.check({ size: 20 })}No VS Code needed</span></div>`;
    }

    // ---- the repo ----
    if (t >= repoAt) {
      const gh = Math.sin(Math.PI * seg(t, ghAt, ghAt + 0.5));
      const lit = easeOut(seg(t, filesAt, filesAt + 0.3)) * (1 - 0.6 * seg(t, filesAt + 1.6, filesAt + 2.4));
      const chips = FOLDERS.map((f, i) => `<span style="display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 13px;border-radius:9px;background:rgba(122,167,224,${(0.06 + 0.2 * lit).toFixed(3)});border:1.5px solid rgba(122,167,224,${(0.25 + 0.7 * lit).toFixed(3)});white-space:nowrap;${appear(t, repoAt + 0.2 + i * 0.08, { dy: 6 })}"><span style="color:#7aa7e0;display:flex">${ICON.folder({ size: 20 })}</span><span class="mono" style="font-size:19px">${f}</span></span>`).join('');
      let body = `<div class="abs" style="left:20px;right:20px;top:14px;display:flex;gap:10px">${chips}</div>`;
      if (t >= devAt) {
        body += `<div class="abs" style="left:20px;right:20px;top:66px;height:36px;display:flex;align-items:center;gap:12px;white-space:nowrap;font-size:21px;${appear(t, devAt, { dy: 8 })}">
          <span class="dot" style="background:var(--green)"></span><span class="mono" style="color:var(--text-2);font-size:19px">${NEW_SHA}</span><span style="color:var(--text)">Add status to fct_order</span><span style="color:var(--text-3)">· a developer · just now</span>
          ${t >= saasAt ? `<span class="pill" style="margin-left:auto;font-size:19px;padding:3px 12px;gap:6px;background:#13301f;color:var(--green);border:1px solid #1f5a35;${appear(t, saasAt, { dy: 0, dx: 8 })}">${ICON.check({ size: 16 })}nothing else to update</span>` : ''}</div>`;
      }
      html += `<div class="card" style="left:${PX}px;top:${RY}px;width:${PW}px;height:${RH}px;${appear(t, repoAt, { dy: -20, dur: 0.4 })}">
        <div class="card__head" style="height:56px;font-size:22px"><div class="card__tab card__tab--on"><img src="${LOGO('github.svg')}" width="26" height="26" style="display:block;width:26px;height:26px;background:#fff;border-radius:50%;transform:scale(${(1 + 0.25 * gh).toFixed(3)})">${R.repo}</div><div class="card__crumb">main › .erd-studio/</div></div>
        <div class="card__body">${body}</div></div>`;
      if (t >= dbAt) {
        html += `<div class="abs" style="right:${1080 - PX - PW + 16}px;top:${RY + 8}px;${appear(t, dbAt, { dy: 6 })}"><span class="pill" style="font-size:21px;padding:5px 15px;gap:8px;background:#1c1e23;color:var(--text);border:1px solid #3a3d45">${dbIcon(20)}the “database”${t >= filesAt ? `<span style="color:#9cc2f0;${appear(t, filesAt, { dy: 0 })}">= DBML files</span>` : ''}</span></div>`;
      }
      // The line from the repo down to the page, the files flowing along it.
      const y0 = RY + RH + 4, y1 = PY - 4, ax = 540;
      const grow = easeOut(seg(t, connAt + 0.1, connAt + 0.5));
      let sv = `<path d="M${ax} ${y0} V${lerp(y0, y1, grow)}" stroke="#4c9aff" stroke-width="4" fill="none"/>`;
      if (grow >= 1 && t >= connAt) for (let k = 0; k < 2; k++) { const q = ((t * 0.9 + k * 0.5) % 1); sv += `<circle cx="${ax}" cy="${lerp(y0, y1, q)}" r="5" fill="#85b8ff"/>`; }
      html += `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1">${sv}</svg>`;
      html += `<div class="abs" style="left:${ax + 20}px;top:${y0 + 4}px;font-size:20px;color:var(--text-2);white-space:nowrap;${t >= connAt + 0.3 ? appear(t, connAt + 0.3, { dy: 0, dx: -8 }) : 'opacity:0;'}">reads the committed files</div>`;
      if (t >= truthAt - 0.1) {
        html += `<div class="abs" style="right:${ax + 20 - 0}px;top:${y0 + 1}px;transform:translateX(${0}px);${appear(t, truthAt - 0.1, { dy: 0, dx: 8 })}"><span class="pill" style="font-size:21px;padding:4px 14px;gap:8px;background:#13301f;color:var(--green);border:1px solid #1f5a35">${ICON.check({ size: 16 })}one source of truth</span></div>`;
      }
    }
    return html;
  },
};
