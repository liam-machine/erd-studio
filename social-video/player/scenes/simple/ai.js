// simple/ai · "I wanted AI to help build it all. / But it could read the code, not the map. So it
// had to guess." A generic "AI assistant" chat (no vendor marks): the question types in a user
// bubble; on `guess` the assistant reads the code (green tick on "code"), looks for the map (amber
// "not found" on "map"), and below it draws its GUESSED map: two dashed cards joined by a wobbly
// amber line through a "?" that pops on "guess".
import { COLORS, ICON, appear, caret, card, easeOut, esc, seg, spinner, typed, typedEnd } from '../../lib.js';

const X = 64, W = 952;
const CHAT = { y: 300, h: 380 };
const QUESTION = 'Show me orders per customer';

// ---- local icons ----
const sw = (d, size, col, w = 2.2) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const codeIcon = (s, c) => sw('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4.5l-3 15"/>', s, c, 2.4);
const mapIcon = (s, c) => sw('<path d="M3 6.5l6-2.3 6 2.3 6-2.3v13.3l-6 2.3-6-2.3-6 2.3z"/><path d="M9 4.2v13.3M15 6.5v13.3"/>', s, c);
const personIcon = (s, c) => `<svg class="icon" width="${s}" height="${s}" viewBox="0 0 24 24" fill="${c}"><circle cx="12" cy="8" r="4.2"/><path d="M3.8 21c.6-4.6 4-7.2 8.2-7.2s7.6 2.6 8.2 7.2z"/></svg>`;
const receiptIcon = (s, c) => sw('<path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21z"/><path d="M9 8h6M9 12h6M9 16h3"/>', s, c);

const tickDot = (kind) => `<span class="tick tick--${kind}" style="width:42px;height:42px">${kind === 'ok' ? ICON.check({ size: 26 }) : ICON.warn({ size: 26 })}</span>`;

/** One assistant step row: icon tile, label; spinner until `doneAt`, then a tick + result text. */
function step(t, { y, at, doneAt, icon, busy, done, kind }) {
  if (t < at) return '';
  const fin = t >= doneAt;
  const col = !fin ? 'var(--text-2)' : kind === 'ok' ? 'var(--green)' : 'var(--amber)';
  const tileBg = !fin ? '#24262c' : kind === 'ok' ? '#13301f' : '#3d3113';
  return `<div class="abs" style="left:132px;top:${y}px;height:64px;display:flex;align-items:center;gap:20px;white-space:nowrap;${appear(t, at, { dy: 0, dx: -12 })}">
    <span style="width:64px;height:64px;border-radius:16px;background:${tileBg};display:flex;align-items:center;justify-content:center">${icon(36, fin ? (kind === 'ok' ? '#22c55e' : '#f4b42c') : '#9aa0aa')}</span>
    <span style="font-size:32px;font-weight:700;color:${fin ? 'var(--text)' : 'var(--text-2)'}">${fin ? done : busy}</span>
    ${fin ? `<span style="display:flex;align-items:center;gap:12px;${appear(t, doneAt, { dy: 0, dx: -8, dur: 0.25 })}">${tickDot(kind)}<span style="font-size:30px;font-weight:700;color:${col}">${kind === 'ok' ? 'done' : 'not found'}</span></span>` : spinner(t, 34)}
  </div>`;
}

/** A card on the AI's guessed map: icon + name, and two plain fields (one marked "?"). */
function guessCard({ x, y, w, icon, name, fields, qRow, t, at, qAt }) {
  const rows = fields.map((f, i) => `<div style="height:62px;display:flex;align-items:center;gap:14px;padding:0 26px;font-size:31px;color:var(--text);border-top:1px solid #3a3322">
      <span style="flex:1">${f}</span>${i === qRow && t >= qAt ? `<span style="width:40px;height:40px;border-radius:50%;background:#3d3113;border:2px solid var(--amber);color:var(--amber);display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800;${appear(t, qAt, { dy: 0, dur: 0.25 })}">?</span>` : ''}</div>`).join('');
  return `<div class="abs" style="left:${x}px;top:${y}px;width:${w}px;border-radius:20px;border:3px dashed ${COLORS.amber};background:#1c1a15;overflow:hidden;box-shadow:0 18px 44px #0009;${appear(t, at, { dy: 16 })}">
    <div style="height:82px;display:flex;align-items:center;gap:16px;padding:0 26px">
      <span style="width:52px;height:52px;border-radius:14px;background:#3d3113;display:flex;align-items:center;justify-content:center">${icon(32, '#f4b42c')}</span>
      <span style="font-size:36px;font-weight:800">${name}</span></div>${rows}</div>`;
}

export default {
  render(t, { beats }) {
    const a = beats.ai.t, g = beats.guess.t;
    // x_ai: "I wanted AI(+0.42) to help build it all(+1.5)."
    const typeAt = a + 0.45, cps = 19;
    const typeEnd = typedEnd(QUESTION, typeAt, cps);   // ~ +1.9, just after "…it all"
    // x_guess: "But it could read the code(+0.7), not the map(+1.4). So it had to guess(+2.5)."
    const readAt = g + 0.2, readDone = g + 0.85;       // tick on "code"
    const lookAt = g + 1.0, lookDone = g + 1.42;       // amber on "map"
    const cardsAt = g + 1.72;                           // in the pause before "So it had to…"
    const lineAt = g + 2.05, lineEnd = g + 2.45;
    const qAt = g + 2.5;                                // "…guess"

    // ---------------- the chat ----------------
    const bubbleTxt = esc(typed(QUESTION, t, typeAt, cps));
    let body = '';
    if (t >= typeAt - 0.1) {
      body += `<div class="abs" style="right:36px;top:26px;height:80px;padding:0 32px;border-radius:28px 28px 8px 28px;background:#1d3557;border:1px solid #2d4a70;display:flex;align-items:center;font-size:34px;font-weight:600;color:#eaf2ff;white-space:nowrap;${appear(t, typeAt - 0.1, { dy: 8, dur: 0.25 })}">${bubbleTxt || '&#8203;'}${t < typeEnd + 0.6 ? caret(t, typeEnd, '#cfe3ff') : ''}</div>`;
    }
    if (t >= readAt - 0.1) {
      body += `<div class="abs" style="left:36px;top:138px;width:68px;height:68px;border-radius:50%;background:#1b2a40;border:2px solid #2d4a70;color:var(--blue);display:flex;align-items:center;justify-content:center;${appear(t, readAt - 0.1, { dy: 0, dur: 0.25 })}">${ICON.sparkle({ size: 36 })}</div>`;
    }
    body += step(t, { y: 140, at: readAt, doneAt: readDone, icon: codeIcon, busy: 'Reading the code', done: 'Read the code', kind: 'ok' });
    body += step(t, { y: 236, at: lookAt, doneAt: lookDone, icon: mapIcon, busy: 'Looking for the map', done: 'The map', kind: 'warn' });

    let html = card({
      x: X, y: CHAT.y, w: W, h: CHAT.h,
      tabs: [{ label: 'AI assistant', on: true, icon: `<span style="color:var(--blue)">${ICON.sparkle({ size: 24 })}</span>` }],
      headStyle: 'font-size:24px', body, style: appear(t, 0, { dy: 18 }),
    });

    // ---------------- the guessed map ----------------
    if (t >= cardsAt) {
      const GY = 780, LW = 370, LX = X, RX = X + W - LW;
      html += `<div class="abs" style="left:${X}px;top:${GY - 44}px;width:${W}px;text-align:center;font-size:24px;font-weight:800;letter-spacing:.16em;color:var(--amber);white-space:nowrap;${appear(t, cardsAt, { dy: 0 })}">THE AI'S GUESS</div>`;
      html += guessCard({ x: LX, y: GY, w: LW, icon: personIcon, name: 'customers', fields: ['name', 'email'], qRow: 1, t, at: cardsAt, qAt: qAt + 0.15 });
      html += guessCard({ x: RX, y: GY, w: LW, icon: receiptIcon, name: 'orders', fields: ['date', 'total'], qRow: 0, t, at: cardsAt + 0.12, qAt: qAt + 0.25 });

      // The wrong join: customers.email -> orders.date, wobbling (it isn't sure).
      const y0 = GY + 82 + 62 + 31, y1 = GY + 82 + 31;  // centre of "email" row, of "date" row
      const x0 = LX + LW + 6, x1 = RX - 6;
      const p = easeOut(seg(t, lineAt, lineEnd));
      const wob = t >= lineAt ? 1 : 0;
      const N = 40;
      let d = '';
      for (let i = 0; i <= N; i++) {
        const u = i / N;
        const x = x0 + (x1 - x0) * u;
        const base = y0 + (y1 - y0) * (0.5 - 0.5 * Math.cos(Math.PI * u));
        const amp = 14 * Math.sin(Math.PI * u) * wob;
        const y = base + amp * Math.sin(u * Math.PI * 4 + t * 5.5);
        d += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      html += `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1">
        <mask id="aiLineMask"><rect x="${x0 - 10}" y="${GY - 20}" width="${(x1 - x0 + 20) * p}" height="300" fill="#fff"/></mask>
        <path d="${d}" mask="url(#aiLineMask)" fill="none" stroke="${COLORS.amber}" stroke-width="5" stroke-linecap="round" stroke-dasharray="14 10" stroke-dashoffset="${(-t * 30).toFixed(1)}"/></svg>`;

      // The big "?" on the line, on "guess".
      if (t >= qAt) {
        const q = easeOut(seg(t, qAt, qAt + 0.3));
        const bob = Math.sin((t - qAt) * 3) * 4;
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2 + bob;
        html += `<div class="abs" style="left:${cx - 44}px;top:${cy - 44}px;width:88px;height:88px;border-radius:50%;background:var(--amber);color:#1a1405;display:flex;align-items:center;justify-content:center;font-size:56px;font-weight:800;box-shadow:0 10px 30px #0009;opacity:${q.toFixed(3)};transform:scale(${(0.6 + 0.4 * q).toFixed(3)})">?</div>`;
      }
      // Plain verdict under the guess.
      const chipAt = qAt + 0.35;
      if (t >= chipAt) {
        html += `<div class="abs" style="left:${X}px;top:${GY + 232}px;width:${W}px;display:flex;justify-content:center;${appear(t, chipAt, { dy: 8 })}">
          <span class="pill" style="font-size:28px;padding:10px 24px;background:#3d3113;color:var(--amber);border:2px solid #6b5420">${ICON.warn({ size: 26 })}joined in the wrong place</span></div>`;
      }
    }
    return html;
  },
};
