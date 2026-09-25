// 3 · The Welcome panel, drawn as the real one is built (src/types/gettingStarted.ts →
// buildGettingStartedHtml): a single stacked column — hero, the video, "Transcript", then
// "GET SET UP", the "New to this?" sample link and four numbered step cards. It is scaled ~1.5x so it reads at 1080p, which
// makes it taller than the card, so the panel scrolls like a real webview does:
//   top (hero + video) → steps 1–2 → the pointer clicks "Set up my AI helper" → the setup
//   result appears (the real setupReadyMessage([]) and describeWrittenFiles() groups) → back to
//   step 1, where "Get Claude Code" and the other assistants are called out → down to steps 3–4.
// No AI assistant is found yet (the state the "No AI assistant yet?" line talks to), so every
// card shows that state's variant: step 1 has Get Claude Code + Re-check + "Also supported",
// step 2 installs for every supported assistant, step 3 has no per-assistant rows yet.
//
// The steps are laid out in normal flow (the result box pushes steps 3–4 down, as it does in
// the real panel); the scroll stops and pointer targets below are measured from that layout —
// re-measure them (see the comment on S) if the copy changes.
import { appear, card, easeInOut, ICON, lerp, path, pointer, seg, spinner } from '../lib.js';

export const X = 96, Y = 322, W = 1728, H = 600;
export const VIEW_TOP = Y + 64;                   // card body top in frame space
export const COL_W = 1400, COL_X = (W - COL_W) / 2;      // column inside the body (body-relative x)
const BODY_X = X + COL_X + 26 + 38 + 18;          // frame x of a step's text/buttons

// Content y (px from the top of the webview, before scrolling) of the hero pieces.
export const C = { kicker: 36, title: 64, sub: 122, video: 184, videoH: 788, transcript: 988, section: 1054, steps: 1096 };
// Measured from the rendered layout (content y): the top of step 1's buttons and of step 2's.
const BTN1_Y = 1309, BTN2_Y = 1604;
// Scroll stops: hero; steps 1–2; step 2's result; steps 3–4 (content y at the top of the view).
const S = { top: 0, steps: 1124, helper: 1592, later: 2004 };
const toFrame = (cy, scroll) => VIEW_TOP + cy - scroll;

// setupReadyMessage([]) and the describeWrittenFiles() groups for a fresh install with no
// assistant found (both skill folders), in their fixed order — verbatim from gettingStarted.ts.
export const READY = 'AI helper ready for Claude Code, GitHub Copilot, Codex, Gemini CLI and Cursor. Install one, then start the guided setup (the Welcome panel shows what to type).';
export const GROUPS = [
  ['The guided setup for Claude Code', 'The /erd-studio-setup skill: the step-by-step walkthrough Claude Code follows in this project.'],
  ['The guided setup for GitHub Copilot, Codex, Gemini CLI and Cursor', 'The same walkthrough in the shared .agents/skills folder, which those assistants read.'],
  ["ERD Studio's file-format rules", 'Teaches your assistant how ERD Studio diagram files are laid out, so what it writes opens on the canvas.'],
  ['A safety check for Claude Code', 'Makes Claude Code load those rules before it edits your diagrams. It lives in .claude/settings.local.json, which is never committed.'],
  ['A small checking tool', 'Your assistant runs it to compare your logical model with your dbt project. It sits in your home folder, outside the project.'],
  ['Your .gitignore', 'Lines added so these helper files stay out of git, matching how the existing ERD Studio skill is set up.'],
];
const OTHERS = ['GitHub Copilot', 'Codex', 'Gemini CLI', 'Cursor'];
// With a project open, the panel puts this link (.gs-sample-link) between "GET SET UP" and step 1.
export const SAMPLE_LINK_TEXT = 'New to this? Try it on the sample project first';
const SAMPLE_LINK = `<div class="wp-samplelink"><span style="color:var(--link)">${SAMPLE_LINK_TEXT}</span></div>`;

function step({ num, done = false, title, body, ring = 0 }) {
  const glow = ring > 0 ? `box-shadow:0 0 0 ${(3 * ring).toFixed(1)}px var(--blue),0 0 ${(30 * ring).toFixed(0)}px rgba(92,162,248,${(0.35 * ring).toFixed(2)});` : '';
  return `<div class="wp-step" style="${glow}">
    <span class="wp-step__num${done ? ' wp-step__num--done' : ''}">${num}</span>
    <div class="wp-step__body"><div class="wp-step__title">${title}</div>${body}</div></div>`;
}

export default {
  render(t, { beats }) {
    const clickAt = beats.click.t + 1.75;           // lands on "…click 'Set up my AI helper'"
    const doneAt = beats.adds.t + 0.4;
    const na = beats.noai.t;

    // Scroll: hero → steps → the setup result → back to step 1 → steps 3–4.
    const moves = [
      [0.8, 1.6, S.top, S.steps],
      [doneAt + 0.3, doneAt + 1.0, S.steps, S.helper],
      [na + 0.05, na + 0.75, S.helper, S.steps],
      [na + 2.35, na + 3.05, S.steps, S.later],
    ];
    let scroll = S.top;
    for (const [a, b, from, to] of moves) if (t >= a) scroll = lerp(from, to, easeInOut(seg(t, a, b)));

    const working = t >= clickAt && t < doneAt;
    const installed = t >= doneAt;

    // ---- hero + video ----
    let html = `${hero()}
      <div class="abs wp-section" style="left:${COL_X}px;top:${C.section}px">GET SET UP</div>`;

    // ---- 1 · Your AI assistant (none found yet) ----
    const ring = seg(t, na + 0.75, na + 1.15);
    const linkLit = seg(t, na + 1.3, na + 1.7);
    let steps = step({ num: '1', title: 'Your AI assistant', ring,
      body: `<div class="wp-step__text">The guided setup runs inside an AI coding assistant, and none was found on this computer. Install one, then press Re-check. Claude Code is recommended: it's the one the guide is tested with.</div>
        <div class="wp-step__actions"><span class="wp-btn wp-btn--primary">${ICON.external({ size: 18 })}Get Claude Code</span><span class="wp-btn">Re-check</span></div>
        <div class="wp-step__hint" style="display:flex;gap:22px">Also supported:${OTHERS.map((o) => `<span style="color:var(--link);${linkLit ? `text-decoration:underline;text-decoration-color:rgba(55,148,255,${linkLit.toFixed(2)});text-underline-offset:5px;` : ''}">${o}</span>`).join('')}</div>` });

    // ---- 2 · Set up my AI helper: idle → "Setting up…" (disabled) → Installed + result ----
    const pressed = t >= clickAt && t < clickAt + 0.18 ? 'filter:brightness(1.25);transform:scale(.97);' : '';
    const label = installed ? 'Reinstall my AI helper' : working ? 'Setting up…' : 'Set up my AI helper';
    let body2 = `<div class="wp-step__text">Adds the <span class="wp-code">/erd-studio-setup</span> guide and ERD Studio's file-format rules for <b style="color:var(--text)">every supported assistant</b> (so it's ready whichever you install), plus a small checking tool your assistant uses behind the scenes.</div>
      <div class="wp-step__actions"><span class="wp-btn wp-btn--primary" style="${pressed}${working ? 'opacity:.6;' : ''}">${working ? spinner(t, 18, '#fff') : ''}${label}</span></div>`;
    if (installed) {
      body2 += `<div class="wp-step__status" style="color:var(--green);${appear(t, doneAt, { dy: 6 })}">${ICON.check({ size: 18 })}Installed</div>
        <div class="wp-result" style="${appear(t, doneAt + 0.1, { dy: 8 })}">
          <div class="wp-result__msg" style="white-space:normal;max-width:1180px">${READY}</div>
          ${GROUPS.map(([g, why], i) => `<div class="wp-result__item" style="white-space:normal;max-width:1180px;${appear(t, doneAt + 0.25 + i * 0.12, { dy: 0, dx: -8 })}"><b>${g}:</b> ${why}</div>`).join('')}
        </div>`;
    }
    steps += step({ num: '2', done: installed, title: 'Set up my AI helper', body: body2 });

    // ---- 3 · Start the guided setup (no assistant yet: no per-assistant rows) ----
    steps += step({ num: '3', title: 'Start the guided setup',
      body: `<div class="wp-step__text">Your assistant checks your dbt setup, works out how your project is modelled and checks with you, builds your logical model and checks it against dbt, explaining each step.</div>
        <div class="wp-step__hint">Install an assistant (step 1) and press Re-check to see exactly what to type.</div>` });

    // ---- 4 · Open the canvas (no domains yet) ----
    steps += step({ num: '4', title: 'Open the canvas',
      body: `<div class="wp-step__text">The guided setup creates your first domain for you, or you can start one by hand.</div>
        <div class="wp-step__actions"><span class="wp-btn">Create your first domain</span></div>` });

    html += `<div class="abs wp-steps" style="left:${COL_X}px;top:${C.steps}px;width:${COL_W}px">${SAMPLE_LINK}${steps}</div>`;

    const content = `<div class="abs" style="inset:0;overflow:hidden"><div class="wp" style="transform:translateY(${(-scroll).toFixed(1)}px)">${html}</div></div>`;
    const panel = card({ x: X, y: Y, w: W, h: H, tabs: [{ label: 'Welcome to ERD Studio', on: true, icon: `<img src="/media/icon.png" width="26" height="26" style="border-radius:6px">` }], body: content, style: appear(t, 0) });

    // Pointer: glide in, click "Set up my AI helper", then drift up to "Get Claude Code".
    const btn2 = { x: BODY_X + 130, y: toFrame(BTN2_Y, S.steps) + 26 };
    const btn1 = { x: BODY_X + 120, y: toFrame(BTN1_Y, S.steps) + 26 };
    const p = path(t, [
      { t: 0.6, x: 1500, y: 1010 },
      { t: clickAt - 0.1, x: btn2.x, y: btn2.y },
      { t: na + 0.85, x: btn2.x, y: btn2.y },
      { t: na + 1.6, x: btn1.x, y: btn1.y },
    ]);
    const press = seg(t, clickAt, clickAt + 0.45);
    const pointerOp = seg(t, 0.6, 0.9) * (1 - seg(t, na + 2.1, na + 2.4));

    return `${panel}<div class="abs" style="inset:0;opacity:${pointerOp.toFixed(2)}">${pointer(p.x, p.y, press)}</div>`;
  },
};

/** The panel's top: hero, the video and "Transcript" (content coordinates). */
export function hero() {
  return `
      <div class="abs wp-kicker" style="left:${COL_X}px;top:${C.kicker}px">ERD STUDIO</div>
      <div class="abs wp-title" style="left:${COL_X}px;top:${C.title}px">Welcome to ERD Studio</div>
      <div class="abs wp-sub" style="left:${COL_X}px;top:${C.sub}px">Turn the dbt project you already have into a data model you can see.</div>
      <div class="abs wp-video" style="left:${COL_X}px;top:${C.video}px;width:${COL_W}px;height:${C.videoH}px">
        <div class="abs" style="left:70px;top:64px;font-size:20px;font-weight:800;letter-spacing:.24em;color:var(--text-2)">ERD STUDIO</div>
        <div class="abs" style="left:70px;top:100px;font-size:62px;font-weight:800;line-height:1.07;letter-spacing:-.025em;white-space:nowrap">From your dbt project<br><span style="color:var(--text-2)">to a <span style="color:var(--blue)">data model</span>.</span></div>
        <span class="wp-sound">${soundIcon()}Play with sound</span>
        <div class="abs" style="left:70px;right:70px;bottom:44px;display:flex;gap:12px">${[0, 1, 2, 3, 4].map(() => '<i style="flex:1;height:5px;border-radius:3px;background:#292a30"></i>').join('')}</div>
      </div>
      <div class="abs wp-transcript" style="left:${COL_X}px;top:${C.transcript}px">${ICON.play({ size: 14 })}Transcript</div>`;
}

function soundIcon() {
  return '<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M2 6h2.5L8 3v10L4.5 10H2zM10.5 5.2a4 4 0 0 1 0 5.6l-.7-.7a3 3 0 0 0 0-4.2zM12.3 3.4a6.5 6.5 0 0 1 0 9.2l-.7-.7a5.5 5.5 0 0 0 0-7.8z"/></svg>';
}
