// 3 · "Then I tried to vibe code data engineering." A Claude Code terminal: the prompt types, the
// AI reads every .sql file (green), then looks for the data model and finds none (amber). On
// `guess` a ghost fct_order appears with `grain: ???` and "?" key badges, and it wobbles between
// two plausible guesses (grain + the key that goes with it).
import { COLORS, ICON, appear, caret, card, esc, seg, spinner, tick, typed, typedEnd } from '../lib.js';

const X = 64, W = 952;
const TERM = { y: 300, h: 420 };
const GHOST = { x: 64, y: 752, w: 470, scale: 1.1 };
const PROMPT = 'build a daily orders mart';

function row(y, inner, style = '') {
  return `<div class="abs" style="left:40px;right:40px;top:${y}px;height:44px;display:flex;align-items:center;gap:16px;white-space:nowrap;${style}">${inner}</div>`;
}

/** Which of the two guesses is showing (0/1) and a 0..1 crossfade weight toward guess 1. */
function guessMix(t, from) {
  if (t < from) return 0;
  const period = 1.4, k = ((t - from) % period) / period;       // 0..1 across one cycle
  // hold guess 0, fade to 1, hold guess 1, fade back to 0
  if (k < 0.35) return 0;
  if (k < 0.5) return (k - 0.35) / 0.15;
  if (k < 0.85) return 1;
  return 1 - (k - 0.85) / 0.15;
}

const qBadge = `<span class="badge" style="background:#3d3113;color:var(--amber);min-width:34px;font-size:20px;padding:2px 8px">?</span>`;

export default {
  render(t, { beats }) {
    const vibe = beats.vibe.t, blind = beats.blind.t, guess = beats.guess.t;
    const typeAt = vibe + 0.15;
    const typeEnd = typedEnd(PROMPT, typeAt, 20);
    const readAt = blind + 0.1;            // "My AI could read every line…"
    const readDone = blind + 1.6;          // "…of SQL"
    const lookAt = blind + 2.2;            // "…but it couldn't…"
    const lookDone = blind + 3.25;         // "…see the design"
    const ghostAt = guess + 0.05;          // "What's the grain?"
    const keysAt = guess + 0.9;            // "Which keys?"
    const wobbleAt = guess + 1.3;          // "It had to guess"

    // ---------- terminal ----------
    let body = row(30, `<span style="color:var(--blue)">${ICON.chevRight({ size: 28 })}</span>
      <span class="mono" style="font-size:28px;color:var(--text)">${esc(typed(PROMPT, t, typeAt, 20))}</span>${t < readAt ? caret(t, typeEnd) : ''}`);

    if (t >= readAt) {
      body += row(112, `<span class="dot"></span><span class="mono" style="font-size:26px;color:var(--text)">Read<span style="color:var(--text-2)">(models/**/*.sql)</span></span>`, appear(t, readAt, { dy: 0, dx: -10 }));
      const done = t >= readDone;
      body += row(166, `<span style="width:14px"></span>${done ? tick('ok') : spinner(t, 30)}<span style="font-size:26px;font-weight:600;color:${done ? 'var(--green)' : 'var(--text-2)'}">${done ? '42 SQL files read' : 'reading…'}</span>`, appear(t, readAt + 0.2, { dy: 0, dx: -10 }));
    }
    if (t >= lookAt) {
      body += row(240, `<span class="dot"></span><span style="font-size:26px;font-weight:600">Looking for the data model…</span>`, appear(t, lookAt, { dy: 0, dx: -10 }));
      const done = t >= lookDone;
      body += row(294, `<span style="width:14px"></span>${done ? tick('warn') : spinner(t, 30)}<span style="font-size:26px;font-weight:600;color:${done ? 'var(--amber)' : 'var(--text-2)'}">${done ? 'Not in this repo: no grain, no keys' : 'searching…'}</span>`, appear(t, lookAt + 0.2, { dy: 0, dx: -10 }));
    }
    let html = card({
      x: X, y: TERM.y, w: W, h: TERM.h, dots: true,
      tabs: [{ label: 'Claude Code', on: true, icon: `<span style="color:var(--claude)">${ICON.terminal({ size: 24 })}</span>` }],
      crumb: 'analytics',
      body: `<div class="chat">${body}</div>`,
      style: appear(t, 0),
    });

    // ---------- the ghost model: what the AI has to invent ----------
    if (t >= ghostAt) {
      const g = guessMix(t, wobbleAt);
      const wob = t >= wobbleAt ? Math.sin((t - wobbleAt) * 3.4) * 1.1 : 0;
      const grains = ['One row per order?', 'One row per order line?'];
      const grainTxt = t < wobbleAt
        ? `<span class="mono" style="font-size:22px;color:var(--amber)">grain: ???</span>`
        : `<span style="position:relative;display:block;width:100%;height:100%">
            <span class="abs" style="left:0;top:8px;color:var(--amber);opacity:${Math.max(0, 1 - 2 * g).toFixed(3)}">${grains[0]}</span>
            <span class="abs" style="left:0;top:8px;color:var(--amber);opacity:${Math.max(0, 2 * g - 1).toFixed(3)}">${grains[1]}</span></span>`;
      const cols = [
        { name: 'order_id', type: 'INT', q: true },
        { name: 'customer_id', type: 'INT', q: true },
        { name: 'order_date', type: 'DATE' },
        { name: 'order_amt', type: 'DECIMAL' },
      ];
      const showQ = t >= keysAt;
      const rows = cols.map((c, i) => `<div class="node__row"${c.q && showQ ? ` style="background:rgba(56,48,28,${seg(t, keysAt + i * 0.12, keysAt + i * 0.12 + 0.3).toFixed(3)})"` : ''}>
          <span class="node__key" style="${appear(t, keysAt + i * 0.12, { dy: 0 })}">${c.q && showQ ? qBadge : ''}</span>
          <span class="node__col">${c.name}</span><span class="node__type">${c.type}</span></div>`).join('');
      html += `<div class="abs" style="left:${GHOST.x}px;top:${GHOST.y}px;transform-origin:0 0;transform:scale(${GHOST.scale});${appear(t, ghostAt, { dy: 12 })}">
        <div class="node" style="position:relative;width:${GHOST.w}px;border:3px dashed ${COLORS.amber};background:#17181cee;transform:rotate(${wob.toFixed(3)}deg)">
          <div class="node__head"><span class="node__name" style="color:var(--text-2)">fct_order</span><span class="pill" style="font-size:18px;padding:3px 12px;background:#3d3113;color:var(--amber)">guessed</span></div>
          <div class="node__grain" style="color:var(--amber)">${grainTxt}</div>${rows}</div></div>`;

      // Right: the two guesses it keeps flipping between (grain, and the key that goes with it).
      const RX = GHOST.x + GHOST.w * GHOST.scale + 36, RW = X + W - RX;
      const chip = (label, lit) => `<div style="height:48px;display:flex;align-items:center;gap:12px;padding:0 18px;border-radius:12px;border:2px ${lit > 0.5 ? 'solid' : 'dashed'} ${lit > 0.5 ? COLORS.amber : '#4a4436'};background:rgba(61,49,19,${(0.9 * lit).toFixed(3)});color:${lit > 0.5 ? 'var(--amber)' : 'var(--text-3)'};font-size:25px;font-weight:600;white-space:nowrap">${label}</div>`;
      const lit0 = t < wobbleAt ? 0 : 1 - g, lit1 = t < wobbleAt ? 0 : g;
      html += `<div class="abs" style="left:${RX}px;top:${GHOST.y - 2}px;width:${RW}px;display:flex;flex-direction:column;gap:10px;${appear(t, ghostAt + 0.3, { dy: 0, dx: 12 })}">
        <div style="font-size:24px;font-weight:800;letter-spacing:.12em;color:var(--text-2)">GRAIN?</div>
        ${chip('per order', lit0)}${chip('per order line', lit1)}
        <div style="margin-top:10px;font-size:24px;font-weight:800;letter-spacing:.12em;color:var(--text-2);${appear(t, keysAt, { dy: 0 })}">PRIMARY KEY?</div>
        <div style="display:flex;flex-direction:column;gap:10px;${appear(t, keysAt, { dy: 6 })}">${chip('order_id', lit0)}${chip('order_id + line_no', lit1)}</div>
      </div>`;
    }
    return html;
  },
};
