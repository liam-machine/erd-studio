// simple/together — the emotional payoff. A plain "Change #128 · Add order status" card holds
// two items, "The map" and "The code", each gaining the same new `status` field. On "change
// together" one green outline wraps both; on "one approval" a "1 approval" pill lands. Then
// three big checklist rows tick, one per spoken word (Reviewed / Tracked / Shipped, measured
// from x_rts.wav), and on "Shipped" the card's status flips to "Live". The rhetorical question
// plays over a calm hold: only a slow green halo breathes behind the finished card.
import { appear, easeOut, lerp, seg, SIMPLE } from '../../lib.js';

const CX = 64, CY = 300, CW = 952, CH = 440;          // change card, y 300..740
const TX = CX + 32, TW = (CW - 64 - 28) / 2, TY = CY + 176, TH = 228;   // the two item tiles
const RY = 768, RH = 94, RG = 14;                      // checklist rows, y 768..1070

const C = SIMPLE.change;
const hump = (t, a, up, down) => (t < a ? 0 : t < a + up ? seg(t, a, a + up) : 1 - seg(t, a + up, a + up + down));

// ---- icons (inline SVG; the font subsets have no symbols) ----
const mapIcon = (size, color) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"><path d="M3 6.5l6-2.5 6 2.5 6-2.5v13.5l-6 2.5-6-2.5-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/></svg>`;
const codeIcon = (size, color) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15"/></svg>`;
const personIcon = (size, color) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${color}"><circle cx="12" cy="8" r="4.2"/><path d="M3.8 21c.6-4.6 3.9-7.2 8.2-7.2s7.6 2.6 8.2 7.2z"/></svg>`;
/** Check mark drawn in over `p` (0..1). */
const drawnCheck = (size, color, p) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" stroke-dasharray="22" stroke-dashoffset="${(22 * (1 - p)).toFixed(2)}"/></svg>`;
const plusIcon = (size, color) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;

function tile({ x, label, icon, color, lineBg, t, at, addAt, glow }) {
  const a = easeOut(seg(t, addAt, addAt + 0.35));
  return `<div class="abs" style="left:${x}px;top:${TY}px;width:${TW}px;height:${TH}px;border-radius:18px;background:#15161a;border:2px solid ${glow > 0 ? `rgba(34,197,94,${(0.3 + 0.6 * glow).toFixed(2)})` : 'var(--card-border)'};overflow:hidden;${appear(t, at, { dy: 16 })}">
    <div style="position:absolute;left:28px;top:26px;display:flex;align-items:center;gap:18px;white-space:nowrap">
      <span style="width:68px;height:68px;border-radius:16px;background:${lineBg};display:flex;align-items:center;justify-content:center">${icon}</span>
      <span style="font-size:40px;font-weight:800;letter-spacing:-.01em;color:var(--text)">${label}</span></div>
    <div style="position:absolute;left:28px;right:28px;top:128px;height:70px;border-radius:12px;background:rgba(19,48,31,${a.toFixed(3)});border:2px solid rgba(34,197,94,${(0.55 * a).toFixed(3)});display:flex;align-items:center;gap:14px;padding:0 20px;opacity:${lerp(0, 1, a).toFixed(3)};transform:translateX(${lerp(-12, 0, a).toFixed(1)}px);white-space:nowrap">
      ${plusIcon(26, 'var(--green)')}<span style="font-size:30px;font-weight:600;color:var(--text)">new field</span><span class="mono" style="font-size:30px;font-weight:700;color:var(--green)">${C.field}</span></div>
  </div>`;
}

export default {
  render(t, { beats }) {
    const O = beats.one.t, R = beats.rts.t, S = beats.sense.t;
    const cardAt = 0;              // the change is already open as the scene fades in
    const mapAt = O + 0.25;        // clip 0.3 s → "the map"
    const codeAt = O + 0.8;        // clip 0.86 s → "the code"
    const both = O + 1.1;          // clip 1.08 s → "change together": both gain the field, one outline
    const approvalAt = O + 2.1;    // clip 2.12 s → "one approval"
    const rowsAt = R - 0.35;       // the empty checklist settles in just before "Reviewed"
    const ticks = [R + 0.05, R + 0.96, R + 1.8];   // x_rts.wav: 0.00 / 0.96 / 1.80 s — one per word
    const liveAt = ticks[2] + 0.1;

    // Calm hold for the question: a slow green glow grows around the finished card.
    const halo = easeOut(seg(t, S, S + 2.5));

    let html = '';

    // ---- the change card ----
    const outline = easeOut(seg(t, both, both + 0.4));
    const outlineGlow = hump(t, both, 0.2, 0.8);
    const live = t >= liveAt;
    const lp = hump(t, liveAt, 0.12, 0.35);
    const status = live
      ? `<span class="pill" style="font-size:28px;padding:10px 24px;gap:12px;background:var(--green);color:#06210f;transform:scale(${(1 + 0.1 * lp).toFixed(3)})"><span style="width:14px;height:14px;border-radius:50%;background:#06210f"></span>Live</span>`
      : `<span class="pill" style="font-size:28px;padding:9px 22px;gap:12px;border:2px solid var(--text-3);color:var(--text-2)"><span style="width:14px;height:14px;border-radius:50%;border:2.5px solid var(--text-2)"></span>In review</span>`;

    html += `<div class="card" style="left:${CX}px;top:${CY}px;width:${CW}px;height:${CH}px;border-color:${live ? '#1f5a35' : 'var(--card-border)'};box-shadow:0 30px 80px #000a, 0 0 ${(70 * halo).toFixed(1)}px rgba(34,197,94,${(0.22 * halo).toFixed(3)});${appear(t, cardAt)}">
      <div class="abs" style="left:32px;top:30px;display:flex;align-items:center;gap:16px;white-space:nowrap">
        <span style="font-size:26px;font-weight:700;letter-spacing:.08em;color:var(--text-3)">CHANGE #${C.number}</span></div>
      <div class="abs" style="right:32px;top:24px">${status}</div>
      <div class="abs" style="left:32px;top:74px;font-size:50px;font-weight:800;letter-spacing:-.02em;white-space:nowrap">${C.title}</div>
    </div>`;

    // Green outline around both items on "change together".
    if (outline > 0) {
      html += `<div class="abs" style="left:${TX - 12}px;top:${TY - 12}px;width:${CW - 64 + 24}px;height:${TH + 24}px;border-radius:26px;border:3px solid rgba(34,197,94,${(0.9 * outline).toFixed(2)});box-shadow:0 0 ${(34 * outlineGlow).toFixed(1)}px rgba(34,197,94,.45)"></div>`;
    }
    html += tile({ x: TX, label: 'The map', icon: mapIcon(40, 'var(--logical)'), color: 'var(--logical)', lineBg: '#1b2a40', t, at: mapAt, addAt: both, glow: outlineGlow });
    html += tile({ x: TX + TW + 28, label: 'The code', icon: codeIcon(40, 'var(--text)'), color: 'var(--text)', lineBg: '#2a2c33', t, at: codeAt, addAt: both + 0.12, glow: outlineGlow });

    // "1 approval" pill, centred on the outline's bottom edge.
    if (t >= approvalAt) {
      const p = easeOut(seg(t, approvalAt, approvalAt + 0.35));
      const pop = 1 + 0.08 * hump(t, approvalAt, 0.14, 0.3);
      html += `<div class="abs" style="left:${CX}px;width:${CW}px;top:${TY + TH + 12 - 30}px;display:flex;justify-content:center;opacity:${p.toFixed(3)};transform:translateY(${lerp(10, 0, p).toFixed(1)}px) scale(${pop.toFixed(3)})">
        <span class="pill" style="font-size:34px;padding:10px 28px;gap:12px;background:#0f2417;border:3px solid var(--green);color:var(--green);box-shadow:0 10px 30px #000a">${personIcon(32, 'var(--green)')}1 approval</span></div>`;
    }

    // ---- the checklist: one tick per word ----
    const labels = ['Reviewed', 'Tracked', 'Shipped'];
    labels.forEach((w, i) => {
      const at = ticks[i];
      const y = RY + i * (RH + RG);
      const on = t >= at;
      const f = easeOut(seg(t, at, at + 0.22));
      const pop = hump(t, at, 0.1, 0.3);
      const box = on
        ? `<span style="width:64px;height:64px;border-radius:16px;background:var(--green);display:flex;align-items:center;justify-content:center;flex:none;transform:scale(${(1 + 0.16 * pop).toFixed(3)});box-shadow:0 0 ${(30 * pop).toFixed(1)}px rgba(34,197,94,.6)">${drawnCheck(44, '#06210f', f)}</span>`
        : `<span style="width:64px;height:64px;border-radius:16px;border:3px solid #4a4e56;flex:none"></span>`;
      html += `<div class="abs" style="left:${CX}px;top:${y}px;width:${CW}px;height:${RH}px;border-radius:20px;background:${on ? `rgba(19,48,31,${lerp(0.4, 1, f).toFixed(3)})` : '#17181c'};border:2px solid ${on ? `rgba(34,197,94,${lerp(0.25, 0.55, f).toFixed(2)})` : 'var(--card-border)'};display:flex;align-items:center;gap:28px;padding:0 30px;white-space:nowrap;${appear(t, rowsAt + i * 0.06, { dy: 12 })}">
        ${box}<span style="font-size:48px;font-weight:800;letter-spacing:-.02em;color:${on ? 'var(--text)' : 'var(--text-3)'}">${w}</span><span style="font-size:48px;font-weight:800;letter-spacing:-.02em;color:${on ? 'var(--green)' : '#3a3d44'}">together</span></div>`;
    });
    return html;
  },
};
