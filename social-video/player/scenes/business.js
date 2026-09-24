// 10 · Business: a light team-wiki page ("Orders data model") carrying the ERD Studio for
// Confluence macro. The diagram is NOT redrawn here: it is a screenshot of the real macro
// renderer (`ErdCanvas` from @erd-studio/renderer, with the Confluence app's theme, rendered by
// erd-studio-pro/apps/confluence/static/frontend/harness from assets/confluence-orders.display.json
// — the same orders domain as every other scene). So what the business sees is what the app draws.
// On `conf` a callout names the app and where the files come from; then a green pill: viewers
// need no GitHub account.
//
// Re-shoot the asset (from erd-studio-pro/apps/confluence/static/frontend):
//   vite build --config harness/vite.config.ts --outDir <dir>/harness   (then serve <dir>, with the
//   fixture beside it) and screenshot harness/index.html?fixture=../confluence-orders.display.json
//   &draggable=0 at 880x555 CSS px, deviceScaleFactor 2, once body[data-ready="true"].
import { appear, appIcon, easeOut, ICON, lerp, seg } from '../lib.js';

// Page card (light), frame coordinates.
const PX = 64, PY = 300, PW = 952, PH = 790;       // y 300..1090
const BAR = 60;
const IN = PX + 32;
// The macro: the real render, 1760x1110 px (880x555 CSS at 2x), shown at 904 px wide.
const MX = PX + 24, MY = 498, MW = PW - 48, MH = Math.round(MW * 1110 / 1760); // y 498..1068

// Light-theme tokens (the Confluence page, not the dark video frame).
const L = { page: '#ffffff', bar: '#f7f8f9', line: '#dfe1e6', text: '#172b4d', text2: '#44546f', text3: '#626f86' };

const avatar = (letter, bg, size = 36) =>
  `<span style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};color:#fff;font-size:${Math.round(size * 0.46)}px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;flex:none">${letter}</span>`;

export default {
  render(t, { beats }) {
    const lose = beats.lose.t, conf = beats.conf.t;
    const macroAt = lose + 0.35;          // the page already carries the diagram on "the business"
    const labelAt = conf + 0.05;          // "ERD Studio for Confluence"
    const filesAt = conf + 1.55;          // "renders the same files on a page"
    const glowAt = filesAt + 0.3;
    const pillAt = conf + 3.3;            // "No GitHub account needed"

    // ---- page ----
    let html = `<div class="abs" style="left:${PX}px;top:${PY}px;width:${PW}px;height:${PH}px;border-radius:20px;background:${L.page};overflow:hidden;box-shadow:0 30px 80px #000c, 0 0 0 1px #ffffff1a;${appear(t, 0)}">
      <div class="abs" style="left:0;right:0;top:0;height:${BAR}px;background:${L.bar};border-bottom:1px solid ${L.line};display:flex;align-items:center;gap:12px;padding:0 24px;font-size:24px;color:${L.text2};white-space:nowrap">
        <span style="color:${L.text3}">${ICON.file({ size: 24 })}</span><span style="font-weight:600;color:${L.text}">Team wiki</span>
        <span style="color:${L.text3}">${ICON.chevRight({ size: 20, sw: 2.6 })}</span>Data
        <span style="color:${L.text3}">${ICON.chevRight({ size: 20, sw: 2.6 })}</span>Models
        <span style="flex:1"></span>
        <span style="display:inline-flex;align-items:center;gap:8px;padding:6px 16px;border-radius:8px;border:1px solid ${L.line};background:#fff;color:${L.text};font-weight:600">Share</span></div>
      <div class="abs" style="left:${IN - PX}px;top:${BAR + 24}px;font-size:46px;font-weight:800;letter-spacing:-.02em;color:${L.text};white-space:nowrap">Orders data model</div>
      <div class="abs" style="left:${IN - PX}px;top:${BAR + 92}px;display:flex;align-items:center;gap:12px;font-size:24px;color:${L.text2};white-space:nowrap">
        ${avatar('D', '#1d7afc')}Data team<span style="color:${L.text3}">·</span>Updated just now</div>
    </div>`;

    // "Viewers need no GitHub account": right of the meta line.
    if (t >= pillAt) {
      const p = easeOut(seg(t, pillAt, pillAt + 0.4));
      html += `<div class="abs" style="right:${1080 - (PX + PW - 28)}px;top:${PY + BAR + 84}px;opacity:${p.toFixed(3)};transform:scale(${lerp(0.9, 1, p).toFixed(3)});transform-origin:100% 50%">
        <span class="pill" style="font-size:25px;padding:10px 20px;gap:10px;background:#dcfff1;border:2px solid #4bce97;color:#216e4e">${ICON.check({ size: 24 })}Viewers need no GitHub account</span></div>`;
    }

    // ---- the macro: the real render ----
    const glow = seg(t, glowAt, glowAt + 0.25) * (1 - seg(t, glowAt + 0.6, glowAt + 1.5));
    const mp = easeOut(seg(t, macroAt, macroAt + 0.45));
    html += `<div class="abs" style="left:${MX}px;top:${MY}px;width:${MW}px;height:${MH}px;border-radius:12px;overflow:hidden;border:1px solid ${L.line};background:#fff;opacity:${mp.toFixed(3)};transform:translateY(${lerp(12, 0, mp).toFixed(1)}px);box-shadow:0 0 0 ${(3 * glow).toFixed(2)}px rgba(29,122,252,${(0.55 * glow).toFixed(3)}), 0 0 ${Math.round(40 * glow)}px rgba(29,122,252,${(0.35 * glow).toFixed(3)})">
      <img src="/social-video/player/assets/confluence-orders.png" width="${MW}" height="${MH}" style="display:block;width:${MW}px;height:${MH}px"></div>`;

    // Callout in the canvas's empty top-left: which app, and where the files come from.
    if (t >= labelAt) {
      html += `<div class="abs" style="left:${MX + 22}px;top:${MY + 20}px;display:flex;flex-direction:column;gap:10px;align-items:flex-start">
        <span class="pill" style="font-size:25px;padding:9px 18px 9px 10px;gap:12px;background:#0b1422;color:#fff;box-shadow:0 10px 30px #0006;${appear(t, labelAt, { dy: 8 })}">${appIcon(34, 'box-shadow:none;border-radius:8px')}ERD Studio for Confluence</span>`;
      if (t >= filesAt) {
        html += `<span class="pill" style="font-size:24px;padding:8px 16px;gap:10px;background:#e9f2ff;color:#0c66e4;border:1.5px solid #85b8ff;${appear(t, filesAt, { dy: 8 })}">${ICON.folder({ size: 24 })}rendered from<span class="mono" style="font-size:22px;font-weight:600">acme/analytics › .erd-studio/</span></span>`;
      }
      html += `</div>`;
    }
    return html;
  },
};
