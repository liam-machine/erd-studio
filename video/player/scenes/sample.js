// 11 · No dbt project yet: where to open the sample project from. The last content scene, just
// before the end card. A VS Code window with no project open: the activity bar (ERD Studio's
// icon selected), the ERD Studio sidebar showing the empty domain tree's welcome view (its tail,
// down to the "Try the sample project" link, which VS Code draws as a button), and the Welcome
// panel in the editor with its no-project card. As the narration names each entry point it gets
// a numbered badge and a pulsing outline: 1 the Welcome panel card, 2 the sidebar link, 3 the
// Command Palette ("ERD Studio: Try the Sample Project"), which drops down over the window. The
// palette closes, the pointer clicks the Welcome panel's button, VS Code's modal confirm
// (SAMPLE_CONFIRM_MESSAGE, src/providers/GettingStartedPanel.ts) appears and the pointer presses
// Download on "…choose where to save it".
import { appear, clamp, ICON, lerp, path, pointer, seg } from '../lib.js';

// Verbatim product copy (the pipeline test checks each against its source).
// Welcome panel, no-project state (src/types/gettingStarted.ts).
export const NO_PROJECT = ['Open a folder containing ', 'dbt_project.yml', ' to continue.'];
export const SAMPLE_TITLE = 'No dbt project yet? Try the sample';
export const SAMPLE_TEXT = 'A small Kimball-style dbt project with fake coffee-shop data — runs on your computer, no account needed.';
export const SAMPLE_BUTTON = 'Try the sample project';
// The domain tree's welcome view (package.json → viewsWelcome), from "Or start by hand:" down.
export const SIDEBAR = [
  'Or start by hand:',
  ['Set Up ERD Studio'],
  'Creates the .erd-studio directory structure and your first domain.',
  ['Install AI Coding Harness'],
  'Pick exactly which AI assistants get the ERD Studio schema reference.',
  ['Try the sample project'],
  'No dbt project yet? Download a small sample dbt project with fake coffee-shop data and try ERD Studio on it — no account needed.',
];
export const SIDEBAR_LINK = 'Try the sample project';
// erdStudio.trySampleProject: category + title, as the Command Palette lists it (package.json).
export const PALETTE_CATEGORY = 'ERD Studio';
export const PALETTE_TITLE = 'Try the Sample Project';
const QUERY = 'try the sample';
// SAMPLE_CONFIRM_MESSAGE and SAMPLE_DOWNLOAD_ACTION (GettingStartedPanel.ts).
export const CONFIRM = "Download the ERD Studio sample project? It's a small dbt project with fake coffee-shop data from github.com/liam-machine/erd-studio-sample (about 1 MB). You'll choose where to save it.";
export const DOWNLOAD = 'Download';

// Window: activity bar | sidebar | editor (frame coordinates).
const X = 96, Y = 322, W = 1728, H = 600, HEAD = 64;
const AB = 76, SBW = 500;
const SB_X = X + AB, ED_X = SB_X + SBW, ED_W = W - AB - SBW;
const COL_X = ED_X + 52, COL_W = ED_W - 104;                    // Welcome panel column
const NOTE_Y = Y + HEAD + 40, CARD_Y = Y + HEAD + 130;           // no-project note, sample card
// Frame y of the sidebar's "Try the sample project" button centre, measured from the rendered
// (bottom-anchored) welcome view — re-measure if the viewsWelcome copy changes.
const SB_LINK_Y = 769;
const BTN = { x: COL_X + 27 + 124, y: CARD_Y + 24 + 32 + 6 + 60 + 18 + 23 };   // button centre
const PAL = { x: X + (W - 820) / 2, y: Y + 12, w: 820 };
const MODAL = { x: 420, y: 468, w: 1080 };
const GREEN = '34,197,94';

/** Pulsing green outline (0..1 strength) as a box-shadow fragment; pure in t. */
function ring(t, k) {
  if (k <= 0) return '';
  const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 1.1);
  const w = (3 + 1.5 * pulse) * k;
  return `box-shadow:0 0 0 ${w.toFixed(1)}px rgb(${GREEN}),0 0 ${(18 + 22 * pulse) * k}px rgba(${GREEN},${(0.45 * k).toFixed(2)});`;
}

/** Numbered badge + label, anchored at (x, y) = its left-centre. */
function badge(t, at, n, label, x, y, fade = 1) {
  if (t < at || fade <= 0) return '';
  const p = clamp((t - at) / 0.3);
  const s = 0.6 + 0.4 * (1 - Math.pow(1 - p, 3)) + 0.12 * Math.sin(Math.PI * p);
  return `<div class="abs" style="left:${x}px;top:${y - 26}px;height:52px;display:flex;align-items:center;gap:12px;padding:0 20px 0 7px;border-radius:26px;background:#0f2a19;border:2px solid rgb(${GREEN});box-shadow:0 10px 30px #000b;white-space:nowrap;opacity:${(p * fade).toFixed(3)};transform:scale(${s.toFixed(3)});transform-origin:left center">
    <span style="width:36px;height:36px;border-radius:50%;background:rgb(${GREEN});color:#06210f;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800">${n}</span>
    <span style="font-size:23px;font-weight:700;color:var(--text)">${label}</span></div>`;
}

export default {
  render(t, { beats }) {
    const a1 = beats.panel.t + 0.15;                 // "Open it from the Welcome panel"
    const a2 = beats.sidebar.t + 0.1;                // "the ERD Studio sidebar"
    const a3 = beats.palette.t + 0.35;               // "or the Command Palette"
    const palClose = beats.palette.end + 0.1;
    const clickAt = beats.save.t + 0.55;             // "Pick any one,"
    const downloadAt = beats.save.end + 0.6;         // just after "…where to save it" (minDur leaves
                                                     // the modal ~2 s on screen, then closes it)

    // Which entry point is lit (the one being named), fading in and handing over to the next.
    const k1 = seg(t, a1, a1 + 0.3) * (1 - seg(t, a2, a2 + 0.3));
    const k2 = seg(t, a2, a2 + 0.3) * (1 - seg(t, a3, a3 + 0.3));
    const k3 = seg(t, a3, a3 + 0.3);

    // ---- window chrome ----
    let html = `<div class="card" style="left:${X}px;top:${Y}px;width:${W}px;height:${H}px;${appear(t, 0)}">
      <div class="abs" style="left:0;top:0;width:${AB}px;bottom:0;background:#101114;border-right:1px solid var(--card-border)"></div>
      <div class="abs" style="left:${AB}px;top:0;width:${SBW}px;bottom:0;background:#15161a;border-right:1px solid var(--card-border)"></div>
      <div class="abs" style="left:${AB}px;top:0;width:${SBW}px;height:${HEAD}px;display:flex;align-items:center;gap:12px;padding:0 22px;border-bottom:1px solid var(--card-border);font-size:18px;font-weight:700;letter-spacing:.1em;color:var(--text-2)">
        ERD STUDIO<span style="flex:1"></span><span style="color:var(--text)">${ICON.playCircle({ size: 24 })}</span><span>${ICON.plus({ size: 20, sw: 2.4 })}</span></div>
      <div class="abs" style="left:${AB + SBW}px;right:0;top:0;height:${HEAD}px;background:var(--card-head);border-bottom:1px solid var(--card-border);display:flex;align-items:stretch;font-size:22px">
        <div class="card__tab card__tab--on"><img src="/media/icon.png" width="26" height="26" style="border-radius:6px">Welcome to ERD Studio</div></div>
    </div>`;

    // ---- activity bar: explorer, search, ERD Studio (selected) ----
    const abIcon = (i, svg, sel) => `<div class="abs" style="left:${X}px;top:${Y + 18 + i * 70}px;width:${AB}px;height:56px;display:flex;align-items:center;justify-content:center;color:${sel ? 'var(--text)' : 'var(--text-3)'};${appear(t, 0.1)}">
      ${sel ? `<i class="abs" style="left:0;top:4px;bottom:4px;width:4px;background:var(--text)"></i>` : ''}${svg}</div>`;
    html += abIcon(0, filesIcon(), false) + abIcon(1, searchIcon(), false);
    html += `<div class="abs" style="left:${X + 12}px;top:${Y + 18 + 2 * 70}px;width:${AB - 24}px;height:56px;border-radius:12px;${ring(t, k2)}"></div>`;
    html += abIcon(2, erdIcon(), true);

    // ---- sidebar: the empty domain tree's welcome view, scrolled to its end ----
    const items = SIDEBAR.map((it) => {
      if (Array.isArray(it)) {
        const isSample = it[0] === SIDEBAR_LINK;
        return `<div style="position:relative;height:46px;border-radius:4px;background:#0e639c;color:#fff;font-size:19px;display:flex;align-items:center;justify-content:center;flex:none;${isSample ? ring(t, k2) : ''}">${it[0]}</div>`;
      }
      return `<div style="font-size:19px;line-height:28px;color:#b9bdc4;flex:none">${it}</div>`;
    }).join('');
    // (The clip box is 12px wider than the column each side so the sample link's outline shows.)
    html += `<div class="abs" style="left:${SB_X + 12}px;top:${Y + HEAD}px;width:${SBW - 24}px;height:${H - HEAD}px;overflow:hidden;${appear(t, 0.2)}">
      <div class="abs" style="left:0;right:0;top:0;bottom:0;padding:0 12px 30px;display:flex;flex-direction:column;justify-content:flex-end;gap:16px">${items}</div>
      <div class="abs" style="left:0;right:0;top:0;height:120px;background:linear-gradient(#15161a,rgba(21,22,26,0))"></div></div>`;

    // ---- Welcome panel: the no-project note and the sample card ----
    const pressed = t >= clickAt && t < clickAt + 0.18 ? 'filter:brightness(1.25);transform:scale(.97);' : '';
    html += `<div class="abs wp-noproject" style="left:${COL_X}px;top:${NOTE_Y}px;width:${COL_W}px;${appear(t, 0.25)}">${NO_PROJECT[0]}<span class="wp-code">${NO_PROJECT[1]}</span>${NO_PROJECT[2]}</div>
      <div class="abs wp-sample" style="left:${COL_X}px;top:${CARD_Y}px;width:${COL_W}px;${ring(t, k1)}${appear(t, 0.35)}">
        <div class="wp-sample__title">${SAMPLE_TITLE}</div>
        <div class="wp-sample__text" style="white-space:normal;height:60px">${SAMPLE_TEXT}</div>
        <div class="wp-step__actions"><span class="wp-btn wp-btn--primary" style="${pressed}">${SAMPLE_BUTTON}</span></div>
      </div>`;

    // ---- Command Palette ----
    const palOp = seg(t, a3 - 0.25, a3) * (1 - seg(t, palClose, palClose + 0.2));
    if (palOp > 0) {
      const typedN = Math.floor(clamp((t - a3) * 20, 0, QUERY.length));
      const q = QUERY.slice(0, typedN);
      const showRow = typedN >= 3;
      // The typed query's match in the title is highlighted, as the palette does.
      const m = PALETTE_TITLE.toLowerCase().indexOf(QUERY);
      const label = `${PALETTE_TITLE.slice(0, m)}<span style="color:#2aaaff;font-weight:700">${PALETTE_TITLE.slice(m, m + QUERY.length)}</span>${PALETTE_TITLE.slice(m + QUERY.length)}`;
      html += `<div class="abs" style="left:${PAL.x}px;top:${PAL.y}px;width:${PAL.w}px;border-radius:10px;background:#252526;border:1px solid #454545;padding:10px;opacity:${palOp.toFixed(3)};transform:translateY(${lerp(-8, 0, palOp).toFixed(1)}px);${k3 > 0 ? ring(t, k3).replace('box-shadow:', 'box-shadow:0 24px 70px #000c,') : 'box-shadow:0 24px 70px #000c;'}">
        <div style="height:48px;border-radius:4px;background:#3c3c3c;border:1px solid #007fd4;display:flex;align-items:center;padding:0 14px;font-size:22px;color:var(--text);white-space:nowrap">&gt;${q}<span style="display:inline-block;width:2px;height:26px;background:var(--text);margin-left:2px"></span></div>
        ${showRow ? `<div style="margin-top:8px;height:48px;border-radius:4px;background:#04395e;display:flex;align-items:center;padding:0 14px;font-size:22px;color:var(--text);white-space:nowrap"><span>${PALETTE_CATEGORY}: ${label}</span></div>` : ''}
      </div>`;
    }

    // ---- badges (1 and 2 stay once shown, so the set reads 1-2-3; 3 leaves with the palette) ----
    html += badge(t, a1, 1, 'Welcome panel', COL_X + COL_W - 250, CARD_Y);
    html += badge(t, a2, 2, 'ERD Studio sidebar', SB_X + SBW - 40, SB_LINK_Y);
    html += badge(t, a3, 3, 'Command Palette', PAL.x + PAL.w - 232, PAL.y + 132, palOp);

    // ---- VS Code's modal confirm: dims the window, closes once Download is pressed ----
    const modalOp = seg(t, clickAt + 0.3, clickAt + 0.6) * (1 - seg(t, downloadAt + 0.4, downloadAt + 0.65));
    if (modalOp > 0) {
      const dlPressed = t >= downloadAt && t < downloadAt + 0.18 ? 'filter:brightness(1.25);transform:scale(.97);' : '';
      html += `<div class="abs" style="left:${X}px;top:${Y}px;width:${W}px;height:${H}px;border-radius:20px;background:rgba(0,0,0,${(0.45 * modalOp).toFixed(3)})"></div>
        <div class="vsc-modal" style="left:${MODAL.x}px;top:${MODAL.y}px;width:${MODAL.w}px;opacity:${modalOp.toFixed(3)};transform:translateY(${lerp(10, 0, Math.min(1, modalOp * 1.5)).toFixed(1)}px)">
          <span style="flex:none;color:var(--blue)">${infoIcon()}</span>
          <div style="flex:1"><div class="vsc-modal__msg">${CONFIRM}</div>
            <div class="vsc-modal__actions"><span class="wp-btn">Cancel</span><span class="wp-btn wp-btn--primary" style="${dlPressed}">${DOWNLOAD}</span></div></div>
        </div>`;
    }

    // ---- pointer: from the closing palette to the Welcome panel's button, then Download ----
    const dl = { x: MODAL.x + MODAL.w - 32 - 68, y: MODAL.y + 176 };
    const p = path(t, [
      { t: palClose, x: 1290, y: 470 },
      { t: clickAt - 0.1, x: BTN.x, y: BTN.y },
      { t: clickAt + 0.6, x: BTN.x, y: BTN.y },
      { t: downloadAt - 0.15, x: dl.x, y: dl.y },
    ]);
    const press = t < downloadAt ? seg(t, clickAt, clickAt + 0.45) : seg(t, downloadAt, downloadAt + 0.45);
    const pointerOp = seg(t, palClose, palClose + 0.3);
    html += `<div class="abs" style="inset:0;opacity:${pointerOp.toFixed(2)}">${pointer(p.x, p.y, press >= 1 ? 0 : press)}</div>`;
    return html;
  },
};

function erdIcon() {
  // media/icon-sidebar.svg (the activity-bar icon), inlined so it takes currentColor.
  return `<svg width="36" height="36" viewBox="0 0 24 24" fill="none"><g transform="translate(-2.08 -2.08) scale(.22)"><g transform="translate(4 0) skewX(-8)">
    <path d="M16 42H42V51H26V59H40V68H26V77H42V86H16Z" fill="currentColor"/>
    <path fill-rule="evenodd" d="M48 86V42H65C76 42 82 48 82 57C82 64 79 68 73 70L84 86H72L62 71H58V86H48ZM58 51V62H64C69 62 72 60 72 56.5C72 53 69 51 64 51H58Z" fill="currentColor"/>
    <path fill-rule="evenodd" d="M88 42H101C115 42 122 50 122 64C122 78 115 86 101 86H88V42ZM98 51V77H101C108 77 112 73 112 64C112 55 108 51 101 51H98Z" fill="currentColor"/></g></g></svg>`;
}
function filesIcon() {
  return '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M8 3h7l4 4v11H8z"/><path d="M15 3v4h4"/><path d="M5 7v14h11"/></svg>';
}
function searchIcon() {
  return '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/></svg>';
}
function infoIcon() {
  return '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M12 11v6" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.4" fill="currentColor" stroke="none"/></svg>';
}
