// 11 · Stars: the repo's real GitHub star history, drawn left to right: months of flat line, then
// the 1.0 launch post and a near-vertical climb. Deliberately no numbers on screen (no counter,
// no axis values, no dates): it shows the shape, "taking off", and stays true as stars grow.
//
// Data: `gh api -H "Accept: application/vnd.github.star+json" repos/liam-machine/erd-studio/stargazers`
// (every stargazer's starred_at, bucketed by UTC day), taken 2026-09-24. Never smooth, scale or
// extrapolate it: the shape is only worth showing because it is true. Re-pull before re-rendering.
import { appear, easeInOut, easeOut, FRAME, lerp, seg } from '../lib.js';

const S = FRAME.stage;
const DAY = 86400000;
const START = Date.UTC(2026, 5, 1);              // 1 Jun
const END = Date.UTC(2026, 8, 24);               // 24 Sep (the day the data was taken)
const NEW_STARS = {                              // UTC day -> stars added that day
  '2026-06-11': 1, '2026-06-12': 1, '2026-06-16': 1, '2026-07-25': 1, '2026-09-07': 1, '2026-09-08': 1,
  '2026-09-17': 1, '2026-09-19': 65, '2026-09-20': 27, '2026-09-21': 35, '2026-09-22': 12, '2026-09-23': 3,
  '2026-09-24': 4,
};
const LAUNCH = Date.UTC(2026, 8, 17, 22, 1);     // the 1.0 post: Thu 18 Sep, 8:01 am AEST

// Cumulative total at the end of each day.
const SERIES = [];
for (let d = START, total = 0; d <= END; d += DAY) {
  total += NEW_STARS[new Date(d).toISOString().slice(0, 10)] ?? 0;
  SERIES.push({ d, total });
}
const MAX = SERIES[SERIES.length - 1].total;     // 153
const PRE = SERIES.find((p) => p.d >= Date.UTC(2026, 8, 17)).total; // 7, the day before the spike

// Chart geometry (frame px).
const CARD = { x: S.x, y: S.y + 10, w: S.w, h: 760 };
const PLOT = { x: CARD.x + 60, y: CARD.y + 200, w: CARD.w - 60 - 60, h: 500 };
const Y_MAX = 160;
const px = (d) => PLOT.x + ((d - START) / (END - START)) * PLOT.w;
const py = (v) => PLOT.y + PLOT.h - (v / Y_MAX) * PLOT.h;

// A step line (stars arrive on a day), as points.
const PTS = [];
SERIES.forEach((p, i) => {
  const x = px(p.d);
  if (i) PTS.push([x, py(SERIES[i - 1].total)]);
  PTS.push([x, py(p.total)]);
});
const LINE = PTS.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
const AREA = `${LINE} L${px(END).toFixed(1)} ${py(0)} L${px(START).toFixed(1)} ${py(0)} Z`;
/** Value of the line at a given x (where the glowing head sits as the reveal sweeps). */
function valueAt(x) {
  let v = 0;
  for (const p of SERIES) if (px(p.d) <= x + 0.01) v = p.total;
  return v;
}

const star = (size, fill = 'currentColor') =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24"><path d="M12 2.8l2.7 5.8 6.3.7-4.7 4.3 1.3 6.2L12 16.6l-5.6 3.2 1.3-6.2L3 9.3l6.3-.7z" fill="${fill}"/></svg>`;

export default {
  render(t, { beats }) {
    const w = beats.week.t;
    // Reveal: the flat months sweep in on "And since the launch" (+0.05 → +0.85, measured in
    // s_week.wav), then the climb draws on "…it's taking off" (+0.95 → +2.0).
    const flatFrom = w + 0.05, flatTo = w + 0.85, climbFrom = w + 0.95, climbTo = w + 2.0;
    const xLaunch = px(Date.UTC(2026, 8, 18));
    let revealX;
    if (t < climbFrom) revealX = lerp(PLOT.x, xLaunch, easeInOut(seg(t, flatFrom, flatTo)));
    else revealX = lerp(xLaunch, PLOT.x + PLOT.w + 2, easeOut(seg(t, climbFrom, climbTo)));
    const climb = seg(t, climbFrom, climbTo);
    const landed = t >= climbTo;

    let html = `<div class="card" style="left:${CARD.x}px;top:${CARD.y}px;width:${CARD.w}px;height:${CARD.h}px;${appear(t, 0)}">
      <div class="card__head"><div class="card__tab card__tab--on"><span style="color:var(--amber)">${star(22)}</span>Stargazers</div><div class="card__crumb">liam-machine/erd-studio</div></div></div>`;

    // Title, top-left of the card: no number, the line is the message. Glows as it takes off.
    const glow = landed ? 1 : climb;
    html += `<div class="abs" style="left:${CARD.x + 44}px;top:${CARD.y + 100}px;display:flex;align-items:center;gap:18px;${appear(t, 0.15)}">
      <span style="color:var(--amber);filter:drop-shadow(0 0 ${(18 * glow).toFixed(1)}px #f4b42caa)">${star(56)}</span>
      <span style="font-size:54px;font-weight:800;letter-spacing:-.025em;line-height:1">GitHub stars</span></div>`;

    // Gridlines only: no values, no dates.
    let axes = '';
    for (const v of [0, 40, 80, 120, 160]) axes += `<line x1="${PLOT.x}" x2="${PLOT.x + PLOT.w}" y1="${py(v)}" y2="${py(v)}" stroke="${v ? '#ffffff12' : '#ffffff30'}" stroke-width="${v ? 1.5 : 2}"/>`;
    html += `<svg class="abs" style="left:0;top:0;overflow:visible;${appear(t, 0.2)}" width="1" height="1">${axes}</svg>`;

    // The line + area, revealed up to revealX by a clip rect.
    const clipW = Math.max(0, revealX - PLOT.x + 4);
    html += `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1">
      <defs>
        <clipPath id="starsReveal"><rect x="${PLOT.x - 4}" y="${PLOT.y - 60}" width="${clipW.toFixed(1)}" height="${PLOT.h + 80}"/></clipPath>
        <linearGradient id="starsFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22c55e" stop-opacity=".38"/><stop offset="1" stop-color="#22c55e" stop-opacity="0"/></linearGradient>
      </defs>
      <g clip-path="url(#starsReveal)">
        <path d="${AREA}" fill="url(#starsFill)"/>
        <path d="${LINE}" fill="none" stroke="#22c55e" stroke-width="12" stroke-linejoin="round" opacity="${(0.25 * glow).toFixed(3)}" style="filter:blur(8px)"/>
        <path d="${LINE}" fill="none" stroke="#22c55e" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>
      </g></svg>`;

    // Glowing head on the line while it draws (it is the "rocket").
    if (t >= flatFrom && !landed) {
      const hx = Math.min(revealX, PLOT.x + PLOT.w), hy = py(valueAt(hx));
      html += `<div class="abs" style="left:${hx - 11}px;top:${hy - 11}px;width:22px;height:22px;border-radius:50%;background:#eafff1;box-shadow:0 0 0 6px #22c55e55, 0 0 ${lerp(16, 44, climb).toFixed(0)}px ${lerp(4, 14, climb).toFixed(0)}px #22c55e"></div>`;
    }

    // "1.0 launch" marker at the foot of the climb, on "…the launch" (+0.55).
    const mk = w + 0.55;
    if (t >= mk) {
      const lx = px(LAUNCH);
      html += `<svg class="abs" style="left:0;top:0;overflow:visible;opacity:${easeOut(seg(t, mk, mk + 0.35)).toFixed(3)}" width="1" height="1">
        <line x1="${lx}" x2="${lx}" y1="${py(PRE) - 4}" y2="${PLOT.y - 6}" stroke="#f4b42c" stroke-width="2.5" stroke-dasharray="7 7"/></svg>
        <div class="abs" style="left:${lx - 330}px;top:${PLOT.y - 58}px;width:318px;text-align:right;${appear(t, mk, { dy: 8 })}">
          <span class="pill" style="font-size:24px;padding:8px 18px;background:#2a2414;color:var(--amber);box-shadow:0 0 0 2px #f4b42c44">1.0 launch</span></div>`;
    }

    // Landing: a trend-up pill beside the peak.
    if (landed) {
      const up = `<svg class="icon" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>`;
      html += `<div class="abs" style="left:${PLOT.x + PLOT.w - 470}px;top:${py(MAX) + 40}px;width:420px;text-align:right;${appear(t, climbTo, { dy: 10 })}">
        <span class="pill" style="font-size:32px;padding:12px 26px;gap:12px;background:#13301f;color:var(--green);box-shadow:0 0 0 2px #22c55e55, 0 10px 30px #0008">${up}taking off</span></div>`;
    }
    return html;
  },
};
