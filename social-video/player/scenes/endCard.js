// 12 · End card (held last frame, likely thumbnail, the call to action). No headline: main.js
// fades the kicker and chapter bar out, so this scene owns y 60..1090.
// name: icon, "ERD Studio", sub-line, then the three pills on "Free, with the source on GitHub".
// cta:  the brand block eases up, a VS Code-style Extensions search types "ERD Studio" and the
//       result row appears, then "Link in the comments" with a down chevron. All landed by cta+1.5.
//       A cut can replace that line (`props.link: { text, chevron }`; the README cut says where
//       else it is published and drops the chevron).
import { appear, appIcon, caret, easeInOut, ICON, lerp, seg, typed } from '../lib.js';

const QUERY = 'ERD Studio';
const search = (size = 28) =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L20 20"/></svg>`;

export default {
  render(t, { beats, scene }) {
    // Tagline: [plain, highlighted]. A cut can override it (script `props.tagline`).
    const [tagA, tagB] = scene?.props?.tagline ?? ['The logical model, ', 'in your repo.'];
    const link = { text: 'Link in the comments', chevron: true, ...scene?.props?.link };
    const name = beats.name.t, cta = beats.cta.t;
    // The brand block starts centred in the frame and eases up to make room for the CTA.
    const lift = easeInOut(seg(t, cta - 0.05, cta + 0.45));
    const dy = lerp(190, 0, lift);
    const g = (y) => y + dy;

    const pill = (label, at, { green = false, icon = '' } = {}) =>
      `<span class="pill" style="font-size:28px;padding:12px 26px;gap:12px;border-radius:999px;background:${green ? '#13301f' : '#1c1e23'};border:2px solid ${green ? '#1f6b3a' : '#34363d'};color:${green ? 'var(--green)' : 'var(--text)'};${appear(t, at, { dy: 10 })}">${icon}${label}</span>`;

    // Soft green halo behind the icon (static gradient, pure).
    let html = `<div class="abs" style="left:190px;top:${g(20)}px;width:700px;height:520px;border-radius:50%;background:radial-gradient(closest-side,#22c55e1f,#22c55e08 60%,transparent);${appear(t, 0, { dy: 0, dur: 0.8 })}"></div>`;

    html += `<div class="abs" style="left:0;right:0;top:${g(96)}px;display:flex;justify-content:center;${appear(t, 0.05, { dy: 18, dur: 0.5 })}">${appIcon(200)}</div>`;
    html += `<div class="abs" style="left:0;right:0;top:${g(326)}px;text-align:center;font-size:116px;line-height:1;font-weight:800;letter-spacing:-.04em;white-space:nowrap;${appear(t, name, { dy: 16, dur: 0.45 })}">ERD Studio</div>`;
    html += `<div class="abs" style="left:0;right:0;top:${g(466)}px;text-align:center;font-size:40px;line-height:1.2;font-weight:700;letter-spacing:-.01em;white-space:nowrap;${appear(t, name + 0.35)}">${tagA}<span style="color:var(--green)">${tagB}</span></div>`;

    // "ERD Studio for VS Code. Free, with the source on GitHub." (e_name.wav: "Free" ≈ name+2.2,
    // "source" ≈ name+3.1). "Free" is attached to the VS Code extension on purpose: it is what is
    // free, and the pill says so without implying anything about the Confluence app.
    html += `<div class="abs" style="left:0;right:0;top:${g(560)}px;display:flex;justify-content:center;gap:16px">
      ${pill('Free VS Code extension', name + 2.2, { green: true, icon: ICON.check({ size: 24 }) })}
      ${pill('Source on GitHub', name + 3.1, { green: true, icon: ICON.check({ size: 24 }) })}</div>`;

    // ---- CTA: Extensions search ----
    const cardAt = cta + 0.3;             // once the brand block has mostly lifted
    if (t >= cardAt) {
      const typeAt = cardAt + 0.2, cps = 22;
      const typedEnd = typeAt + QUERY.length / cps;
      const resAt = typedEnd + 0.1;
      const X = 150, W = 780, Y = 676;
      const q = typed(QUERY, t, typeAt, cps);
      html += `<div class="card" style="left:${X}px;top:${Y}px;width:${W}px;height:262px;${appear(t, cardAt, { dy: 16, dur: 0.4 })}">
        <div class="abs" style="left:0;right:0;top:0;height:60px;background:var(--card-head);border-bottom:1px solid var(--card-border);display:flex;align-items:center;padding:0 26px;font-size:24px;font-weight:700;letter-spacing:.1em;color:var(--text-2)">EXTENSIONS</div>
        <div class="abs" style="left:22px;right:22px;top:78px;height:66px;border-radius:12px;background:#24262c;border:2px solid ${t >= typeAt ? '#2f6fd1' : '#34363d'};display:flex;align-items:center;gap:14px;padding:0 20px;white-space:nowrap">
          <span style="color:var(--text-2);display:flex">${search(28)}</span>
          <span style="font-size:30px;font-weight:600;color:var(--text)">${q}</span>${t < resAt + 0.6 ? caret(t, typedEnd, 'var(--text)') : ''}</div>
        <div class="abs" style="left:22px;right:22px;top:160px;height:84px;border-radius:12px;background:rgba(37,99,235,.16);display:flex;align-items:center;gap:18px;padding:0 18px;white-space:nowrap;${appear(t, resAt, { dy: 8, dur: 0.3 })}">
          ${appIcon(58, 'box-shadow:none')}
          <div style="flex:1;min-width:0"><div style="font-size:28px;font-weight:700;line-height:1.15">ERD Studio</div>
          <div style="font-size:24px;color:var(--text-2);line-height:1.25">${tagA}${tagB.replace(/\.$/, '')}</div></div>
          <span style="display:inline-flex;align-items:center;height:48px;padding:0 24px;border-radius:8px;background:#0e639c;color:#fff;font-size:24px;font-weight:700">Install</span></div></div>`;

      // "Link in the comments" + chevron (or the cut's own line)
      const linkAt = resAt + 0.2;           // ≈ cta+1.25: everything has landed by cta+1.5
      const bob = t >= linkAt + 0.4 ? 5 * Math.sin((t - linkAt - 0.4) * Math.PI * 1.2) : 0;
      html += `<div class="abs" style="left:0;right:0;top:972px;display:flex;flex-direction:column;align-items:center;gap:6px;${appear(t, linkAt, { dy: 12 })}">
        <div style="font-size:38px;font-weight:800;letter-spacing:-.01em;white-space:nowrap">${link.text}</div>
        ${link.chevron ? `<div style="color:var(--green);transform:translateY(${bob.toFixed(1)}px)">${ICON.chevDown({ size: 46, sw: 3 })}</div>` : ''}</div>`;
    }
    return html;
  },
};
