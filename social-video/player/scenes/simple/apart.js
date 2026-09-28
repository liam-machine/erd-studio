// simple/3 · The heart of the video. Two places, far apart, on the same diagonal twice:
//   drawn → a light "drawing tool" window (top-left) holding the map, with the Managers.
//   built → a dark "the code" window (bottom-right), with the Engineers. "not connected".
//   city  → the same two corners become the analogy: a BLUEPRINT sheet (top-left) and a
//           BUILDING SITE with a crane (bottom-right), joined by a long winding road with a
//           "different city" pin.
//   stale → the blueprint is stamped "last updated 14 months ago" and the building visibly
//           differs from it: an extra room, lit amber, "not on the blueprint".
import { COLORS, ICON, appear, card, clamp, easeInOut, easeOut, seg } from '../../lib.js';

// ---------- phase 1 geometry ----------
const TOOL = { x: 64, y: 316, w: 580, h: 320 };
const CODE = { x: 436, y: 744, w: 580, h: 336 };
// ---------- phase 2 geometry ----------
// Inner drawings are authored at w 540 and scaled by K onto the frame.
const K = 0.889;
const BP = { x: 64, y: 316, w: 540, h: 340 };          // on frame: 480 x 302 -> y 316..618
const SITE = { x: 536, y: 780, w: 540, h: 338 };        // on frame: 480 x 300 -> y 780..1080

const avatar = (size, bg, fg, ring = '#0f1114') => `<svg width="${size}" height="${size}" viewBox="0 0 48 48" style="display:block;border-radius:50%;box-shadow:0 0 0 4px ${ring}"><circle cx="24" cy="24" r="24" fill="${bg}"/><circle cx="24" cy="19" r="8" fill="${fg}"/><path d="M8.5 41c2.5-8 8.5-12.5 15.5-12.5S37 33 39.5 41" fill="${fg}"/></svg>`;
/** Three overlapping avatars + a label: a group of people. */
function people({ x, y, w, bg, fg, label, sub, style = '' }) {
  const trio = `<div style="position:relative;width:${96 * 2 + 128 - 60}px;height:128px">
      <div class="abs" style="left:0;top:22px">${avatar(96, bg, fg)}</div>
      <div class="abs" style="right:0;top:22px">${avatar(96, bg, fg)}</div>
      <div class="abs" style="left:${96 - 30}px;top:0">${avatar(128, bg, fg)}</div></div>`;
  return `<div class="abs" style="left:${x}px;top:${y}px;width:${w}px;display:flex;flex-direction:column;align-items:center;gap:14px;${style}">
    ${trio}<div style="font-size:40px;font-weight:800;letter-spacing:-.01em;white-space:nowrap">${label}</div>
    ${sub ? `<div style="font-size:26px;color:var(--text-2);margin-top:-8px;white-space:nowrap">${sub}</div>` : ''}</div>`;
}

// The drawing tool's own light diagram: three boxes with grey placeholder rows.
function lightBox(x, y, w, title, op) {
  const bar = (bw) => `<div style="height:30px;display:flex;align-items:center;padding:0 14px;border-top:1px solid #e3e6ea"><span style="width:${bw}px;height:10px;border-radius:5px;background:#cfd5dd"></span></div>`;
  return `<div class="abs" style="left:${x}px;top:${y}px;width:${w}px;background:#fff;border:2px solid #b9c6da;border-radius:10px;overflow:hidden;box-shadow:0 6px 16px #0002;opacity:${op.toFixed(3)}">
    <div style="height:42px;display:flex;align-items:center;padding:0 14px;background:#e8eef9;font-size:25px;font-weight:700;color:#1f2a44">${title}</div>${bar(w * 0.55)}${bar(w * 0.4)}</div>`;
}

function toolWindow(t, drawn) {
  const bodyH = TOOL.h - 56;
  const b = (i) => easeOut(seg(t, drawn + 0.35 + i * 0.15, drawn + 0.7 + i * 0.15));
  const ln = easeInOut(seg(t, drawn + 0.8, drawn + 1.3));
  const conn = `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1">
    <path d="M224 60 H280 V120 H330" pathLength="1" stroke-dasharray="${ln.toFixed(3)} 2" fill="none" stroke="#8fa0b8" stroke-width="3"/>
    <path d="M224 190 H280 V150 H330" pathLength="1" stroke-dasharray="${ln.toFixed(3)} 2" fill="none" stroke="#8fa0b8" stroke-width="3"/></svg>`;
  const body = `<div class="abs" style="left:0;top:0;right:0;height:${bodyH}px;background:#f4f6f9;background-image:radial-gradient(#d7dce3 1.3px, transparent 1.4px);background-size:24px 24px">
      ${conn}${lightBox(24, 18, 200, 'customers', b(0))}${lightBox(330, 82, 220, 'orders', b(1))}${lightBox(24, 146, 200, 'payments', b(2))}</div>`;
  return `<div class="abs" style="left:${TOOL.x}px;top:${TOOL.y}px;width:${TOOL.w}px;height:${TOOL.h}px;border-radius:18px;overflow:hidden;background:#fff;border:2px solid #c9ced6;box-shadow:0 30px 70px #000a;${appear(t, drawn + 0.05)}">
    <div style="height:56px;display:flex;align-items:center;gap:12px;padding:0 20px;background:#e6e9ee;border-bottom:1px solid #d3d8df">
      <i style="width:14px;height:14px;border-radius:50%;background:#c3c8cf"></i><i style="width:14px;height:14px;border-radius:50%;background:#c3c8cf"></i><i style="width:14px;height:14px;border-radius:50%;background:#c3c8cf"></i>
      <span style="margin-left:14px;display:flex;align-items:center;gap:10px;padding:6px 16px;border-radius:8px;background:#fff;font-size:26px;font-weight:600;color:#1f2328;white-space:nowrap">
        <span style="color:#5b6b85">${ICON.globe({ size: 24 })}</span>drawing tool</span></div>
    <div class="abs" style="left:0;right:0;top:56px;bottom:0">${body}</div></div>`;
}

const BARS = [[0, 170, '--syn-kw'], [1, 250, '--syn-key'], [1, 190, '--syn-str'], [2, 290, '--syn-val'], [2, 150, '--syn-key'], [1, 220, '--syn-str'], [0, 120, '--syn-punc']];
function codeWindow(t, built) {
  const bars = BARS.map(([ind, w, col], i) => {
    const p = easeOut(seg(t, built + 0.85 + i * 0.12, built + 1.15 + i * 0.12));
    return `<div class="abs" style="left:34px;top:${28 + i * 36}px;height:30px;display:flex;align-items:center">
      <span class="mono" style="width:30px;text-align:right;font-size:22px;color:var(--line-no)">${i + 1}</span>
      <span style="margin-left:${28 + ind * 44}px;width:${(w * p).toFixed(1)}px;height:16px;border-radius:8px;background:var(${col});opacity:.85"></span></div>`;
  }).join('');
  return card({
    x: CODE.x, y: CODE.y, w: CODE.w, h: CODE.h, dots: true,
    tabs: [{ label: 'the code', on: true, icon: `<span style="color:var(--blue)">${ICON.terminal({ size: 24 })}</span>` }],
    body: bars,
    style: appear(t, built + 0.05),
  });
}

// ---------- phase 2: the analogy ----------
const WHITE = '#f2f7ff';
function blueprint(t, at, stale) {
  const draw = easeInOut(seg(t, at + 0.15, at + 0.85));
  const dash = (p) => `pathLength="1" stroke-dasharray="${clamp(p).toFixed(3)} 2"`;
  const d1 = draw, d2 = seg(t, at + 0.55, at + 1.0);
  const old = seg(t, stale, stale + 0.6);
  const house = `<svg class="abs" style="left:0;top:0" width="${BP.w}" height="${BP.h}" viewBox="0 0 ${BP.w} ${BP.h}" fill="none" stroke="${WHITE}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M190 270 V150 L300 80 L410 150 V270 Z" stroke-width="5" ${dash(d1)}/>
    <path d="M280 270 V205 H320 V270" stroke-width="4" ${dash(d2)}/>
    <path d="M212 172 H256 V206 H212 Z M344 172 H388 V206 H344 Z" stroke-width="4" ${dash(d2)}/>
    <path d="M234 172 V206 M366 172 V206" stroke-width="2.5" ${dash(d2)} opacity=".7"/>
    <g opacity="${d2.toFixed(3)}" stroke-width="2.5">
      <path d="M190 296 H410 M190 286 V306 M410 286 V306"/></g>
    <text x="300" y="324" fill="${WHITE}" stroke="none" font-family="JetBrains Mono" font-size="27" text-anchor="middle" opacity="${d2.toFixed(3)}">12 m</text>
    <g opacity="${d2.toFixed(3)}"><rect x="420" y="270" width="110" height="52" rx="4" stroke-width="2.5"/>
      <text x="475" y="305" fill="${WHITE}" stroke="none" font-family="Inter" font-weight="700" font-size="26" text-anchor="middle">PLAN A</text></g></svg>`;
  const paper = `<div class="abs" style="inset:0;border-radius:10px;background:linear-gradient(160deg,#2466b8,#1a4f94);background-image:
      linear-gradient(#ffffff1c 1.5px, transparent 1.5px), linear-gradient(90deg, #ffffff1c 1.5px, transparent 1.5px),
      linear-gradient(#ffffff0c 1px, transparent 1px), linear-gradient(90deg, #ffffff0c 1px, transparent 1px),
      linear-gradient(160deg,#2466b8,#1a4f94);
      background-size:90px 90px,90px 90px,18px 18px,18px 18px,100% 100%;box-shadow:0 30px 70px #000b, inset 0 0 0 2px #ffffff26"></div>
    <div class="abs" style="inset:14px;border:2px solid #ffffff40;border-radius:4px"></div>`;
  const filt = `filter:saturate(${(1 - 0.45 * old).toFixed(3)}) brightness(${(1 - 0.18 * old).toFixed(3)})`;
  // The stamp, top-left of the sheet (the house stays visible so it can be compared).
  let stamp = '';
  if (t >= stale + 0.25) {                  // "So the map slowly…"
    const s = seg(t, stale + 0.25, stale + 0.55);
    const sc = 1.3 - 0.3 * easeOut(s);
    stamp = `<div class="abs" style="left:14px;top:26px;opacity:${s.toFixed(3)};transform:rotate(-10deg) scale(${sc.toFixed(3)});transform-origin:50% 50%">
      <div style="padding:5px;border:5px solid var(--amber);border-radius:14px;background:#1a1405f2;box-shadow:0 14px 34px #000c">
        <div style="padding:6px 18px 8px;border:2px solid #f4b42c88;border-radius:9px;text-align:center;color:var(--amber);font-weight:800;white-space:nowrap">
          <div style="font-size:28px;letter-spacing:.14em">LAST UPDATED</div>
          <div style="font-size:42px;line-height:1.05;letter-spacing:.02em">14 MONTHS AGO</div></div></div></div>`;
  }
  return `<div class="abs" style="left:${BP.x}px;top:${BP.y}px;width:${BP.w}px;height:${BP.h}px;transform-origin:0 0;transform:scale(${K});">
    <div class="abs" style="inset:0;${appear(t, at, { dy: 18 })}">
    <div class="abs" style="inset:0;transform:rotate(-2deg);${filt}">${paper}${house}</div>${stamp}</div></div>`;
}

function site(t, at, stale) {
  const mast = easeInOut(seg(t, at + 0.1, at + 0.6));
  const jib = easeInOut(seg(t, at + 0.45, at + 0.85));
  const frame = easeInOut(seg(t, at + 0.3, at + 0.95));
  const dash = (p) => `pathLength="1" stroke-dasharray="${clamp(p).toFixed(3)} 2"`;
  const studs = [200, 240, 280, 320].map((x, i) => {
    const op = seg(t, at + 0.6 + i * 0.08, at + 0.8 + i * 0.08);
    return `<path d="M${x} 170 V290" stroke="#aeb6c2" stroke-width="3" opacity="${op.toFixed(3)}"/>`;
  }).join('');
  const room = easeOut(seg(t, stale + 0.85, stale + 1.3));   // "…stops being true"
  const glow = room > 0 ? `<rect x="372" y="186" width="150" height="122" rx="12" fill="#f4b42c" opacity="${(0.16 * room).toFixed(3)}" stroke="none"/>` : '';
  const extra = room > 0 ? `<g opacity="${room.toFixed(3)}" transform="translate(0 ${(12 * (1 - room)).toFixed(1)})">
      ${glow}<path d="M380 200 H512 V290 H380" stroke="#f4b42c" stroke-width="6" fill="#f4b42c26"/>
      <path d="M424 226 H468 V260 H424 Z" stroke="#f4b42c" stroke-width="4" fill="none"/><path d="M446 226 V260" stroke="#f4b42c" stroke-width="2.5"/></g>` : '';
  const svg = `<svg class="abs" style="left:0;top:0;overflow:visible" width="${SITE.w}" height="${SITE.h}" viewBox="0 0 ${SITE.w} ${SITE.h}" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <!-- ground -->
    <path d="M0 290 H${SITE.w}" stroke="#4a4136" stroke-width="4"/>
    <!-- crane: lattice mast, jib, counter-jib, tie lines, cable + hook -->
    <path d="M62 290 V44 M86 290 V44" stroke="#c9ced6" stroke-width="4" ${dash(mast)}/>
    <path d="M62 270 L86 240 L62 210 L86 180 L62 150 L86 120 L62 90 L86 60" stroke="#8b9099" stroke-width="2.5" ${dash(mast)}/>
    <path d="M20 44 H440 M20 58 H440" stroke="#c9ced6" stroke-width="4" ${dash(jib)}/>
    <path d="M74 10 L20 44 M74 10 L440 44 M62 44 L74 10 L86 44" stroke="#8b9099" stroke-width="2.5" ${dash(jib)}/>
    <rect x="18" y="58" width="34" height="26" rx="3" fill="#6c6f76" stroke="none" opacity="${jib.toFixed(3)}"/>
    <path d="M300 58 V${(58 + 44 * jib).toFixed(1)}" stroke="#aeb6c2" stroke-width="2.5"/>
    <path d="M292 ${(102 * jib + 58 * (1 - jib)).toFixed(1)} h16 M300 ${(102 * jib + 58 * (1 - jib)).toFixed(1)} v8 q0 8 -8 6" stroke="#aeb6c2" stroke-width="3" opacity="${jib.toFixed(3)}"/>
    <!-- the house frame, same outline as the blueprint -->
    <path d="M160 290 V170 L270 110 L380 170 V290" stroke="#e9ecef" stroke-width="5" ${dash(frame)}/>
    <path d="M160 170 H380" stroke="#e9ecef" stroke-width="4" ${dash(frame)}/>
    ${studs}${extra}</svg>`;
  return `<div class="abs" style="left:${SITE.x}px;top:${SITE.y}px;width:${SITE.w}px;height:${SITE.h}px;transform-origin:0 0;transform:scale(${K})"><div class="abs" style="inset:0;${appear(t, at, { dy: 18 })}">
    <div class="abs" style="inset:0;border-radius:20px;background:linear-gradient(180deg,#1d2128 0%,#1a1c21 80%,#24211c 86%,#211e1a 100%);border:1px solid var(--card-border);box-shadow:0 30px 70px #000a;overflow:hidden"></div>
    <div class="abs" style="left:0;top:14px">${svg}</div></div></div>`;
}

// The road: a long winding S between the two places, drawn as a lane with a dashed centre line.
// From under the blueprint, across the whole middle band, down into the building site.
const R = [[300, 606], [300, 660], [320, 690], [420, 690], [560, 690], [700, 690], [740, 690], [790, 700], [790, 790]];
const bez = (p0, p1, p2, p3, u) => {
  const v = 1 - u;
  return [0, 1].map((k) => v * v * v * p0[k] + 3 * v * v * u * p1[k] + 3 * v * u * u * p2[k] + u * u * u * p3[k]);
};
const ROAD_D = `M${R[0]} C${R[1]} ${R[2]} ${R[3]} C${R[4]} ${R[5]} ${R[6]} C${R[7]} ${R[8]} ${R[8]}`;
const PIN = bez(R[3], R[4], R[5], R[6], 0.5);         // halfway along the long straight

function road(t, at) {
  const p = easeInOut(seg(t, at, at + 0.75));
  if (p <= 0) return '';
  const mask = `pathLength="1" stroke-dasharray="${p.toFixed(3)} 2"`;
  return `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1">
    <defs><mask id="apartRoadMask" maskUnits="userSpaceOnUse" x="0" y="0" width="1080" height="1350"><path d="${ROAD_D}" ${mask} stroke="#fff" stroke-width="40" fill="none" stroke-linecap="butt"/></mask></defs>
    <g mask="url(#apartRoadMask)" fill="none">
      <path d="${ROAD_D}" stroke="#2b2e35" stroke-width="30" stroke-linecap="round"/>
      <path d="${ROAD_D}" stroke="#8b9099" stroke-width="3.5" stroke-dasharray="16 14"/></g></svg>`;
}

function pinMarker(t, at) {
  if (t < at) return '';
  const [x, y] = PIN;
  const p = easeOut(seg(t, at, at + 0.35));
  const pin = `<svg width="56" height="68" viewBox="0 0 24 29"><path d="M12 28s-10-9-10-16.5a10 10 0 0 1 20 0C22 19 12 28 12 28z" fill="#e9ecef" stroke="#0f1114" stroke-width="1.5"/><circle cx="12" cy="11.5" r="4" fill="#0f1114"/></svg>`;
  return `<div class="abs" style="left:${x - 28}px;top:${y - 64}px;opacity:${p.toFixed(3)};transform:translateY(${(-14 * (1 - p)).toFixed(1)}px);filter:drop-shadow(0 6px 10px #000a)">${pin}</div>
    <div class="abs" style="left:${x - 200}px;width:400px;top:${y + 26}px;display:flex;justify-content:center;${appear(t, at + 0.1, { dy: -8 })}">
      <span class="pill" style="font-size:32px;padding:10px 24px;background:#26282e;color:var(--text);box-shadow:0 0 0 2px #4a4e56, 0 10px 24px #0009">different city</span></div>`;
}

export default {
  render(t, { beats }) {
    const drawn = beats.drawn.t, built = beats.built.t, city = beats.city.t, stale = beats.stale.t;
    const mgrAt = drawn + 2.6;               // "…for the managers" (clip pause 2.65–2.91)
    const engAt = built + 0.1;               // "The engineers…"
    const apartAt = built + 1.55;            // "…somewhere else"
    const bpAt = city + 0.45;                // "…keeping the blueprints"
    const bpLabel = city + 0.8;
    const roadAt = city + 1.2;               // "…in a different city"
    const pinAt = city + 1.5;
    const siteAt = city + 1.9;               // "…to the building site"
    const notOnAt = stale + 1.15;            // "…stops being true"

    let html = '';
    // ---------- phase 1: two tools, far apart ----------
    const op1 = 1 - seg(t, city, city + 0.4);
    if (op1 > 0) {
      let p1 = toolWindow(t, drawn);
      if (t >= mgrAt) p1 += people({ x: 668, y: 356, w: 348, bg: '#f3dfb4', fg: '#8a6d1f', label: 'Managers', style: appear(t, mgrAt, { dy: 12 }) });
      if (t >= built) p1 += codeWindow(t, built);
      if (t >= engAt) p1 += people({ x: 64, y: 790, w: 350, bg: '#cfe3ff', fg: '#2f5f9e', label: 'Engineers', style: appear(t, engAt + 0.1, { dy: 12 }) });
      if (t >= apartAt) {
        p1 += `<div class="abs" style="left:0;width:1080px;top:${(TOOL.y + TOOL.h + CODE.y) / 2 - 27}px;display:flex;justify-content:center;${appear(t, apartAt, { dy: 8 })}">
          <span class="pill" style="font-size:30px;padding:9px 24px;gap:12px;background:#26282e;color:var(--text);box-shadow:0 0 0 2px #3a3d45, 0 12px 28px #000a">
            <span style="width:32px;height:32px;border-radius:50%;background:#3a3d45;display:flex;align-items:center;justify-content:center">${ICON.x({ size: 18 })}</span>not connected</span></div>`;
      }
      html += `<div class="abs" style="left:0;top:0;width:1080px;height:1350px;opacity:${op1.toFixed(3)};transform:scale(${(1 - 0.03 * (1 - op1)).toFixed(4)});transform-origin:540px 700px">${p1}</div>`;
    }

    // ---------- phase 2: blueprints in one city, the building site in another ----------
    if (t >= bpAt) {
      html += road(t, roadAt);
      html += blueprint(t, bpAt, stale);
      html += `<div class="abs" style="left:590px;top:340px;width:426px;display:flex;flex-direction:column;align-items:flex-start;gap:14px;${appear(t, bpLabel, { dy: 12 })}">
        <div style="font-size:48px;font-weight:800;letter-spacing:-.02em">Blueprints</div>
        <span class="pill" style="font-size:28px;padding:8px 20px;background:#1b2a40;color:#cfe3ff;box-shadow:0 0 0 2px ${COLORS.logical}88">= the map</span></div>`;
      html += pinMarker(t, pinAt);
      if (t >= siteAt) {
        html += site(t, siteAt, stale);
        html += `<div class="abs" style="left:64px;top:820px;width:440px;display:flex;flex-direction:column;align-items:flex-start;gap:14px;${appear(t, siteAt + 0.2, { dy: 12 })}">
          <div style="font-size:48px;font-weight:800;letter-spacing:-.02em;white-space:nowrap">Building site</div>
          <span class="pill" style="font-size:28px;padding:8px 20px;background:#26282e;color:var(--text);box-shadow:0 0 0 2px #4a4e56">= the real thing</span></div>`;
      }
      if (t >= notOnAt) {
        html += `<div class="abs" style="left:64px;top:996px;${appear(t, notOnAt, { dy: 8 })}">
          <span class="pill" style="font-size:28px;padding:9px 20px;gap:12px;background:#3d3113;color:var(--amber);box-shadow:0 0 0 2px #f4b42c66">${ICON.warn({ size: 26 })}not on the blueprint</span></div>`;
      }
    }
    return html;
  },
};
