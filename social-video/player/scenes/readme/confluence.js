// readme · 10 · confluence — "For the business: view it in Confluence." ERD Studio for Confluence,
// the Atlassian Marketplace app (docs/dev/compatibility.md): a Confluence macro that reads the
// `.erd-studio/` folder from your GitHub repo and draws one diagram, read-only, on a page. Nothing
// here claims more than that: no editing, no sync back, no price.
//
// The page is a light Confluence page (the official Confluence icon in its top bar, assets/logos/,
// see LOGOS.md) titled after the story's `sales` diagram. The diagram on it is a real render, not
// a drawing: @erd-studio/renderer's ErdCanvas in viewer mode, as the macro draws it
// (assets/confluence-sales.png from confluence-sales.display.json; re-shoot with
// `node confluence-shot.mjs`). It is this cut's diagram as the earlier scenes leave it:
// dim_customer and fct_order in the gold layer, fct_order with the `status` column.
//
// `app`: the page is there from the cut; "ERD Studio for Confluence" names the macro on its words,
// "on the Atlassian Marketplace" joins under it as its caption chunk comes up. `view`: "from GitHub" — the GitHub mark and the
// repo's `.erd-studio/` folder it reads — then "in Confluence" lights the macro and its Read-only
// chip, and "No VS Code needed" lands just ahead of its words so it holds to the end card.
import { appear, appIcon, easeOut, ICON, lerp, seg } from '../../lib.js';
import { R, wordAt } from './story.js';

const PX = 64, PY = 300, PW = 952, PH = 790;       // y 300..1090
const BAR = 60;
const IN = PX + 32;
// The macro: the real render, 1760x1110 px, shown at 904 px wide (y 498..1079).
const MX = PX + 24, MY = 498, MW = PW - 48, MH = Math.round(MW * 1110 / 1760);

// Light-theme tokens (the Confluence page, not the dark video frame).
const L = { page: '#ffffff', bar: '#f7f8f9', line: '#dfe1e6', text: '#172b4d', text2: '#44546f', text3: '#626f86', blue: '#1868db' };
const LOGO = (f) => `/social-video/player/assets/logos/${f}`;

const avatar = (letter, bg, size = 36) =>
  `<span style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};color:#fff;font-size:${Math.round(size * 0.46)}px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;flex:none">${letter}</span>`;

export default {
  render(t, { beats, scene }) {
    const nameAt = wordAt(scene, 'app', 'ERD Studio for');
    const marketAt = wordAt(scene, 'app', 'on the Atlassian');
    const repoAt = wordAt(scene, 'view', 'GitHub');
    const pageAt = wordAt(scene, 'view', 'in Confluence');
    const noCodeAt = wordAt(scene, 'view', 'no VS Code') - 0.45;

    // ---- page ----
    let html = `<div class="abs" style="left:${PX}px;top:${PY}px;width:${PW}px;height:${PH}px;border-radius:20px;background:${L.page};overflow:hidden;box-shadow:0 30px 80px #000c, 0 0 0 1px #ffffff1a;${appear(t, 0)}">
      <div class="abs" style="left:0;right:0;top:0;height:${BAR}px;background:${L.bar};border-bottom:1px solid ${L.line};display:flex;align-items:center;gap:12px;padding:0 20px;font-size:23px;color:${L.text2};white-space:nowrap">
        <img src="${LOGO('confluence.svg')}" width="34" height="34" style="display:block;width:34px;height:34px">
        <span style="font-weight:700;color:${L.text}">Confluence</span>
        <span style="color:${L.text3};margin-left:8px">${ICON.chevRight({ size: 18, sw: 2.6 })}</span>Data team
        <span style="color:${L.text3}">${ICON.chevRight({ size: 18, sw: 2.6 })}</span>Data models
        <span style="flex:1"></span>
        <span style="display:inline-flex;align-items:center;padding:5px 16px;border-radius:6px;background:${L.blue};color:#fff;font-weight:600">Share</span></div>
      <div class="abs" style="left:${IN - PX}px;top:${BAR + 24}px;font-size:46px;font-weight:800;letter-spacing:-.02em;color:${L.text};white-space:nowrap">Sales data model</div>
      <div class="abs" style="left:${IN - PX}px;top:${BAR + 92}px;display:flex;align-items:center;gap:12px;font-size:24px;color:${L.text2};white-space:nowrap">
        ${avatar('D', L.blue)}Data team<span style="color:${L.text3}">·</span>Updated just now</div>
    </div>`;

    // "No VS Code needed": right of the meta line, on its words.
    if (t >= noCodeAt) {
      const p = easeOut(seg(t, noCodeAt, noCodeAt + 0.4));
      html += `<div class="abs" style="right:${1080 - (PX + PW - 28)}px;top:${PY + BAR + 84}px;opacity:${p.toFixed(3)};transform:scale(${lerp(0.9, 1, p).toFixed(3)});transform-origin:100% 50%">
        <span class="pill" style="font-size:25px;padding:10px 20px;gap:10px;background:#dcfff1;border:2px solid #4bce97;color:#216e4e">${ICON.check({ size: 24 })}No VS Code needed</span></div>`;
    }

    // ---- the macro: the real render ----
    const glow = seg(t, pageAt, pageAt + 0.25) * (1 - seg(t, pageAt + 0.6, pageAt + 1.5));
    const mp = easeOut(seg(t, 0.15, 0.6));
    html += `<div class="abs" style="left:${MX}px;top:${MY}px;width:${MW}px;height:${MH}px;border-radius:12px;overflow:hidden;border:1px solid ${L.line};background:#fff;opacity:${mp.toFixed(3)};transform:translateY(${lerp(12, 0, mp).toFixed(1)}px);box-shadow:0 0 0 ${(3 * glow).toFixed(2)}px rgba(24,104,219,${(0.55 * glow).toFixed(3)}), 0 0 ${Math.round(40 * glow)}px rgba(24,104,219,${(0.35 * glow).toFixed(3)})">
      <img src="/social-video/player/assets/confluence-sales.png" width="${MW}" height="${MH}" style="display:block;width:${MW}px;height:${MH}px"></div>`;

    // Read-only, top right of the macro, once the page is named.
    if (t >= pageAt) {
      html += `<div class="abs" style="right:${1080 - (MX + MW - 16)}px;top:${MY + 16}px;${appear(t, pageAt, { dy: 6 })}">
        <span class="pill" style="font-size:21px;padding:7px 14px;gap:8px;background:#f1f2f4;color:${L.text2};border:1px solid ${L.line}">${ICON.lock({ size: 18 })}Read-only</span></div>`;
    }

    // Callouts in the canvas's empty top-left: the app, where it is, where the files come from.
    if (t >= nameAt) {
      html += `<div class="abs" style="left:${MX + 22}px;top:${MY + 20}px;display:flex;flex-direction:column;gap:10px;align-items:flex-start">
        <span class="pill" style="font-size:25px;padding:9px 18px 9px 10px;gap:12px;background:#0b1422;color:#fff;box-shadow:0 10px 30px #0006;${appear(t, nameAt, { dy: 8 })}">${appIcon(34, 'box-shadow:none;border-radius:8px')}ERD Studio for Confluence</span>`;
      if (t >= marketAt) {
        html += `<span class="pill" style="font-size:22px;padding:7px 16px;gap:10px;background:#e9f2ff;color:#0c66e4;border:1.5px solid #85b8ff;${appear(t, marketAt, { dy: 8 })}">on the Atlassian Marketplace</span>`;
      }
      if (t >= repoAt) {
        html += `<span class="pill" style="font-size:22px;padding:7px 16px 7px 10px;gap:10px;background:#fff;color:${L.text};border:1.5px solid ${L.line};box-shadow:0 6px 18px #091e4224;${appear(t, repoAt, { dy: 8 })}"><img src="${LOGO('github.svg')}" width="26" height="26" style="display:block;width:26px;height:26px">read from<span class="mono" style="font-size:20px;font-weight:600">${R.repo} › .erd-studio/</span></span>`;
      }
      html += `</div>`;
    }
    return html;
  },
};
