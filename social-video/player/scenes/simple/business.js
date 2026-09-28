// simple/business — managers still get the picture. A light team-wiki page ("Customer orders")
// read by Managers · Sales · Finance, carrying the ERD Studio for Confluence macro. The diagram
// is NOT redrawn: it is a screenshot of the real macro renderer (`ErdCanvas` from
// @erd-studio/renderer with the Confluence app's theme, rendered from
// assets/confluence-simple.display.json — the same customers/orders example as every simple
// scene), exactly the approach of scenes/business.js. On "picture" a callout names the app; on
// "wiki page" a green pill: no developer tools needed. Generic wiki chrome, no vendor marks.
import { appear, appIcon, easeOut, ICON, lerp, seg } from '../../lib.js';

// Page card (light), frame coordinates.
const PX = 64, PY = 300, PW = 952, PH = 790;       // y 300..1090
const BAR = 60;
const IN = PX + 32;
// The macro: the real render, 1760x1110 px (880x555 CSS at 2x), shown at 904 px wide.
const MX = PX + 24, MY = 498, MW = PW - 48, MH = Math.round(MW * 1110 / 1760); // y 498..1068

// Light-theme tokens (the wiki page, not the dark video frame).
const L = { page: '#ffffff', bar: '#f7f8f9', line: '#dfe1e6', text: '#172b4d', text2: '#44546f', text3: '#626f86' };

const avatar = (letter, bg, size, i) =>
  `<span style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};color:#fff;font-size:${Math.round(size * 0.46)}px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;flex:none;border:3px solid #fff;margin-left:${i ? -12 : 0}px">${letter}</span>`;

export default {
  render(t, { beats }) {
    const M = beats.mgr.t;
    const readersAt = M + 0.2;            // clip 0.2 s → "managers"
    const macroAt = 0.15;                 // the page already carries the picture
    const labelAt = M + 1.2;              // clip 1.2–1.7 s → "the picture"
    const glowAt = labelAt + 0.1;
    const pillAt = M + 2.75;              // clip 2.6–3.5 s → "team's wiki page"

    // ---- page ----
    const sep = `<span style="color:${L.text3}">·</span>`;
    let html = `<div class="abs" style="left:${PX}px;top:${PY}px;width:${PW}px;height:${PH}px;border-radius:20px;background:${L.page};overflow:hidden;box-shadow:0 30px 80px #000c, 0 0 0 1px #ffffff1a">
      <div class="abs" style="left:0;right:0;top:0;height:${BAR}px;background:${L.bar};border-bottom:1px solid ${L.line};display:flex;align-items:center;gap:12px;padding:0 24px;font-size:24px;color:${L.text2};white-space:nowrap">
        <span style="color:${L.text3}">${ICON.file({ size: 24 })}</span><span style="font-weight:600;color:${L.text}">Team wiki</span>
        <span style="color:${L.text3}">${ICON.chevRight({ size: 20, sw: 2.6 })}</span>Sales
        <span style="color:${L.text3}">${ICON.chevRight({ size: 20, sw: 2.6 })}</span>Reports
        <span style="flex:1"></span>
        <span style="display:inline-flex;align-items:center;gap:8px;padding:6px 16px;border-radius:8px;border:1px solid ${L.line};background:#fff;color:${L.text};font-weight:600">Share</span></div>
      <div class="abs" style="left:${IN - PX}px;top:${BAR + 22}px;font-size:48px;font-weight:800;letter-spacing:-.02em;color:${L.text};white-space:nowrap">Customer orders</div>
      <div class="abs" style="left:${IN - PX}px;top:${BAR + 92}px;display:flex;align-items:center;gap:12px;font-size:26px;color:${L.text2};white-space:nowrap;${appear(t, readersAt, { dy: 8 })}">
        <span style="display:inline-flex">${avatar('M', '#1d7afc', 42, 0)}${avatar('S', '#e56910', 42, 1)}${avatar('F', '#8f7ee7', 42, 2)}</span>
        <span style="font-weight:600;color:${L.text}">Managers</span>${sep}<span style="font-weight:600;color:${L.text}">Sales</span>${sep}<span style="font-weight:600;color:${L.text}">Finance</span></div>
    </div>`;

    // "No developer tools needed": right of the page title.
    if (t >= pillAt) {
      const p = easeOut(seg(t, pillAt, pillAt + 0.4));
      html += `<div class="abs" style="right:${1080 - (PX + PW - 28)}px;top:${PY + BAR + 25}px;opacity:${p.toFixed(3)};transform:scale(${lerp(0.9, 1, p).toFixed(3)});transform-origin:100% 50%">
        <span class="pill" style="font-size:26px;padding:10px 20px;gap:10px;background:#dcfff1;border:2px solid #4bce97;color:#216e4e">${ICON.check({ size: 24 })}No developer tools needed</span></div>`;
    }

    // ---- the macro: the real render ----
    const glow = seg(t, glowAt, glowAt + 0.25) * (1 - seg(t, glowAt + 0.7, glowAt + 1.6));
    const mp = easeOut(seg(t, macroAt, macroAt + 0.45));
    html += `<div class="abs" style="left:${MX}px;top:${MY}px;width:${MW}px;height:${MH}px;border-radius:12px;overflow:hidden;border:1px solid ${L.line};background:#fff;opacity:${mp.toFixed(3)};transform:translateY(${lerp(12, 0, mp).toFixed(1)}px);box-shadow:0 0 0 ${(3 * glow).toFixed(2)}px rgba(29,122,252,${(0.55 * glow).toFixed(3)}), 0 0 ${Math.round(40 * glow)}px rgba(29,122,252,${(0.35 * glow).toFixed(3)})">
      <img src="/social-video/player/assets/confluence-simple.png" width="${MW}" height="${MH}" style="display:block;width:${MW}px;height:${MH}px"></div>`;

    // Callout in the picture's empty top-left: the same map, as a picture, by ERD Studio.
    if (t >= labelAt) {
      html += `<div class="abs" style="left:${MX + 22}px;top:${MY + 22}px;display:flex;flex-direction:column;gap:12px;align-items:flex-start">
        <span class="pill" style="font-size:27px;padding:10px 20px 10px 10px;gap:12px;background:#0b1422;color:#fff;box-shadow:0 10px 30px #0006;${appear(t, labelAt, { dy: 8 })}">${appIcon(38, 'box-shadow:none;border-radius:9px')}ERD Studio for Confluence</span>
        <span class="pill" style="font-size:26px;padding:8px 18px;gap:10px;background:#e9f2ff;color:#0c66e4;border:1.5px solid #85b8ff;${appear(t, labelAt + 0.35, { dy: 8 })}">the same map, as a picture</span></div>`;
    }
    return html;
  },
};
