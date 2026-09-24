// 10 · Business: a generic team-wiki page ("Orders data model") with an embedded, read-only
// ERD Studio for Confluence macro drawing the same two tables. On `conf` the macro header lights
// up, then the repo chip below feeds the page ("renders the same files"), then a green pill:
// viewers need no GitHub account.
import { appear, appIcon, card, COLORS, easeOut, edge, ICON, node, rowY, seg, STORY } from '../lib.js';

// Page card (window chrome) and the macro inside it, in frame coordinates.
const PX = 64, PY = 300, PW = 952, PH = 664;          // page card: y 300..964
const IN = PX + 40;                                     // page content left
const MX = 96, MY = 550, MW = 888, MH = 390;             // macro box: y 550..940
const MHEAD = 58;
const NW = 374;
const DX = MX + 32, FX = MX + MW - 32 - NW, NY = MY + MHEAD + 22;
const CHIP_Y = 1000, CHIP_H = 72;                       // repo chip: y 1000..1072

const avatar = (letter, bg, size = 34) =>
  `<span style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};color:#0d1117;font-size:${Math.round(size * 0.5)}px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;flex:none">${letter}</span>`;

export default {
  render(t, { beats }) {
    const lose = beats.lose.t, conf = beats.conf.t;
    const nodesAt = lose + 0.45;          // the page already carries the diagram on "business"
    const hdrAt = conf + 0.05;            // "ERD Studio for Confluence"
    const filesAt = conf + 1.55;          // "renders the same files on a page"
    const feedAt = filesAt + 0.35;
    const glowAt = feedAt + 0.45;         // files arrive: the diagram pulses
    const pillAt = conf + 3.3;            // "No GitHub account needed"

    // ---- page chrome ----
    let html = card({
      x: PX, y: PY, w: PW, h: PH,
      tabs: [{ label: 'Orders data model', on: true, icon: `<span style="color:var(--text-2)">${ICON.globe({ size: 24 })}</span>` }],
      crumb: 'Team wiki',
      headStyle: 'font-size:24px',
      style: appear(t, 0),
    });

    // breadcrumb + page actions
    const crumbSep = `<span style="color:var(--text-3)">${ICON.chevRight({ size: 20, sw: 2.6 })}</span>`;
    html += `<div class="abs" style="left:${IN}px;top:${PY + 64 + 20}px;display:flex;align-items:center;gap:10px;font-size:24px;color:var(--text-2);white-space:nowrap;${appear(t, 0.1)}">Data${crumbSep}Models</div>`;
    html += `<div class="abs" style="right:${1080 - (PX + PW - 40)}px;top:${PY + 64 + 18}px;display:flex;align-items:center;gap:12px;${appear(t, 0.15)}">
      <span class="btn" style="font-size:24px;padding:8px 18px">Share</span></div>`;
    // title + meta
    html += `<div class="abs" style="left:${IN}px;top:${PY + 64 + 56}px;font-size:48px;font-weight:800;letter-spacing:-.02em;white-space:nowrap;${appear(t, 0.2)}">Orders data model</div>`;
    html += `<div class="abs" style="left:${IN}px;top:${PY + 64 + 126}px;display:flex;align-items:center;gap:12px;font-size:24px;color:var(--text-2);white-space:nowrap;${appear(t, 0.3)}">
      ${avatar('D', '#8fb8f0')}Data team<span style="color:var(--text-3)">·</span>Sales<span style="color:var(--text-3)">·</span>Finance</div>`;

    // "Viewers need no GitHub account" pill, right of the meta line
    if (t >= pillAt) {
      const p = easeOut(seg(t, pillAt, pillAt + 0.4));
      html += `<div class="abs" style="right:${1080 - (PX + PW - 40)}px;top:${PY + 64 + 116}px;opacity:${p.toFixed(3)};transform:scale(${(0.9 + 0.1 * p).toFixed(3)});transform-origin:100% 50%">
        <span class="pill" style="font-size:25px;padding:10px 20px;gap:10px;background:#13301f;border:2px solid #1f6b3a;color:var(--green);box-shadow:0 0 ${Math.round(28 * (1 - seg(t, pillAt + 0.4, pillAt + 1.4)))}px #22c55e55">${ICON.check({ size: 24 })}Viewers need no GitHub account</span></div>`;
    }

    // ---- macro ----
    const hdr = easeOut(seg(t, hdrAt, hdrAt + 0.4));
    const glow = seg(t, glowAt, glowAt + 0.25) * (1 - seg(t, glowAt + 0.5, glowAt + 1.4));
    const macroBorder = `rgba(96,165,250,${(0.28 + 0.5 * hdr + 0.22 * glow).toFixed(3)})`;
    html += `<div class="abs" style="left:${MX}px;top:${MY}px;width:${MW}px;height:${MH}px;border-radius:16px;border:2px solid ${macroBorder};background:#14161a;overflow:hidden;box-shadow:0 0 ${Math.round(46 * glow)}px rgba(96,165,250,${(0.45 * glow).toFixed(3)});${appear(t, 0.35)}">
      <div class="abs" style="left:0;right:0;top:0;height:${MHEAD}px;background:rgba(37,99,235,${(0.1 + 0.14 * hdr).toFixed(3)});border-bottom:1px solid #2a3a55;display:flex;align-items:center;gap:12px;padding:0 20px;font-size:24px;white-space:nowrap">
        ${appIcon(30, 'box-shadow:none')}<span style="font-weight:700">ERD Studio for Confluence</span>
        <span style="color:var(--text-3)">·</span><span style="color:var(--text-2)">acme/analytics</span>
        <span style="color:var(--text-3)">·</span><span style="color:var(--text-2)">main</span>
        <span style="flex:1"></span><span style="display:flex;align-items:center;gap:8px;color:var(--text-2)">${ICON.lock({ size: 20 })}Read-only</span></div>
      <div class="abs grid-bg" style="left:0;right:0;top:${MHEAD}px;bottom:0"></div></div>`;

    // nodes + edge (same data as every scene)
    const dim = STORY.dim_customer, fct = STORY.fct_order;
    const ep = seg(t, nodesAt + 0.45, nodesAt + 0.85);
    const y1 = NY + rowY(0), y2 = NY + rowY(1), mid = (DX + NW + FX) / 2;
    html += `<div class="abs" style="inset:0;${appear(t, nodesAt + 0.4, { dy: 0 })}">${edge([[DX + NW, y1], [mid, y1], [mid, y2], [FX, y2]], { progress: ep, one: [DX + NW + 8, y1 - 10], many: [FX - 24, y2 - 8] })}</div>`;
    const pulse = glow > 0 ? `box-shadow:0 0 ${Math.round(34 * glow)}px rgba(96,165,250,${(0.55 * glow).toFixed(3)}),0 18px 44px #0009;` : '';
    html += node({ x: DX, y: NY, w: NW, name: dim.name, layer: STORY.layer, grain: dim.grain, cols: dim.cols, style: appear(t, nodesAt) + pulse });
    html += node({ x: FX, y: NY, w: NW, name: fct.name, layer: STORY.layer, grain: fct.grain, cols: fct.cols, style: appear(t, nodesAt + 0.12) + pulse });

    // ---- the repo files feeding the page ----
    if (t >= filesAt) {
      const chipW = 660, chipX = 540 - chipW / 2;
      html += `<div class="abs" style="left:${chipX}px;top:${CHIP_Y}px;width:${chipW}px;height:${CHIP_H}px;border-radius:16px;background:var(--card);border:2px solid #2a3a55;display:flex;align-items:center;gap:14px;padding:0 24px;white-space:nowrap;box-shadow:0 14px 40px #0009;${appear(t, filesAt, { dy: 12 })}">
        <span style="color:#7f8792">${ICON.folder({ size: 28 })}</span><span style="font-size:26px;font-weight:700">acme/analytics</span>
        <span style="color:var(--text-3)">${ICON.chevRight({ size: 22, sw: 2.6 })}</span><span class="mono" style="font-size:24px;color:var(--text-2)">.erd-studio/</span>
        <span style="flex:1"></span><span class="pill" style="font-size:24px;background:var(--blue-row);color:#cfe3ff;padding:4px 14px">3 files</span></div>`;
      // Connector: from the chip up into the macro's bottom edge, drawn upward, then a flow of dashes.
      const y0 = CHIP_Y - 4, yT = MY + MH + 2;
      const len = y0 - yT;
      const dp = easeOut(seg(t, feedAt, feedAt + 0.4));
      const flow = ((t - feedAt) * 60) % 18;
      const dash = dp >= 1 ? `stroke-dasharray="10 8" stroke-dashoffset="${flow.toFixed(1)}"` : `stroke-dasharray="${(len * dp).toFixed(1)} ${len + 20}"`;
      html += `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1">
        <path d="M540 ${y0} L540 ${yT + 8}" stroke="${COLORS.logical}" stroke-width="4" stroke-linecap="round" fill="none" ${dash}/>
        ${dp >= 1 ? `<path d="M529 ${yT + 16} L540 ${yT + 4} L551 ${yT + 16}" stroke="${COLORS.logical}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` : ''}</svg>`;
    }
    return html;
  },
};
