// onboard/install · "Install ERD Studio for VS Code, and open your dbt project. / A short Get started
// guide opens by itself." One editor window (generic chrome, crumb "jaffle-shop"):
//   1. the Extensions view: search "ERD Studio", the result row and the extension's details page;
//      the pointer clicks Install on "…for VS Code" and it becomes "Installed" (the ERD Studio
//      icon joins the activity bar);
//   2. on "…and open your dbt project" the side bar becomes the Explorer: models/, target/ and
//      dbt_project.yml (highlighted);
//   3. on `guide` the Welcome editor slides in with the real walkthrough (package.json
//      contributes.walkthroughs, id erdStudio.getStarted): title, description, the five steps with
//      "Open your dbt project" done and "Draw your dbt project — no AI needed" open as next, sized
//      as the scene's hero (full width, 29 px rows; the step's image is left out).
// `walkthrough()` and the window geometry are exported so onboard/draw can continue from the
// exact same frame.
import { ICON, appIcon, appear, card, easeOut, esc, path, pointer, seg, spinner } from '../../lib.js';

// ---- window geometry (frame px); the body box starts under the 64 px head ----
export const WIN = { x: 64, y: 300, w: 952, h: 790 };
export const BODY = { x: WIN.x + 1, y: WIN.y + 65, w: WIN.w - 2, h: WIN.h - 66 };
const ACT = 64;                 // activity bar width
const SIDE = 356;               // side bar width (x ACT .. ACT+SIDE)
const ED = ACT + SIDE;          // editor area left

// ---- the walkthrough (body coordinates) ----
export const WT = {
  title: 'Get started with ERD Studio',
  description: 'Draw your dbt project as an ERD in a minute, then enrich it with your AI assistant.',
  steps: [
    { id: 'watch', title: 'See the AI-guided setup' },
    { id: 'sample', title: 'No dbt project? Try the sample' },
    { id: 'openProject', title: 'Open your dbt project' },
    {
      id: 'draw', title: 'Draw your dbt project — no AI needed', button: 'Draw from dbt',
      text: 'Pick a folder of dbt models. ERD Studio copies their columns and relationship tests into a diagram you can edit, and lays it out for you.',
    },
    { id: 'enrich', title: 'Enrich it with your AI assistant' },
  ],
};
// Two sizes of the same page. `hero` (this scene) uses the whole Welcome area: rows 29 px, the open
// step 30 / 27 px, the step's image left out (next to a readable step list there is no room for it
// at phone size). The compact default is what onboard/draw zooms into (its ZOOM and TY assume it),
// so DRAW_ROW / DRAW_BTN keep describing the compact page; HERO_DRAW_ROW / HERO_DRAW_BTN are the
// hero page's boxes. The scene fade between install and draw hides the size change.
const GEOM = {
  compact: { SX: 96, SW: 580, ROW: 58, OPEN_H: 282, STEPS_Y: 160, DOT: 32, TITLE: 38, DESC: 24, DESC_LH: 32, DESC_W: 800, STEP: 25, OPEN_T: 25, TEXT: 24, TEXT_LH: 33, TEXT_TOP: 60, INDENT: 58, BTN_TOP: 206, BTN_W: 206, BTN_H: 54, BTN_F: 25 },
  // last row ends at body y 700, 24 px clear of the bottom
  hero: { SX: 92, SW: 830, ROW: 62, OPEN_H: 276, STEPS_Y: 168, DOT: 36, TITLE: 44, DESC: 27, DESC_LH: 36, DESC_W: 830, STEP: 29, OPEN_T: 30, TEXT: 27, TEXT_LH: 36, TEXT_TOP: 62, INDENT: 64, BTN_TOP: 190, BTN_W: 248, BTN_H: 64, BTN_F: 29 },
};
const rowBox = (g) => ({ x: g.SX, y: g.STEPS_Y + 3 * g.ROW, w: g.SW, h: g.OPEN_H });
const btnBox = (g) => ({ x: g.SX + g.INDENT, y: g.STEPS_Y + 3 * g.ROW + g.BTN_TOP, w: g.BTN_W, h: g.BTN_H });
/** Body-space boxes of the open "draw" step and its button (compact page: onboard/draw's zoom). */
export const DRAW_ROW = rowBox(GEOM.compact);
export const DRAW_BTN = btnBox(GEOM.compact);
/** The same boxes on the hero page this scene shows. */
export const HERO_DRAW_ROW = rowBox(GEOM.hero);
export const HERO_DRAW_BTN = btnBox(GEOM.hero);

const doneDot = (size) =>
  `<span style="width:${size}px;height:${size}px;border-radius:50%;background:#3794ff;color:#0b1422;display:flex;align-items:center;justify-content:center;flex:none">${ICON.check({ size: Math.round(size * 0.66) })}</span>`;
const openDot = (size) => `<span style="width:${size}px;height:${size}px;border-radius:50%;display:block;border:3px solid #6c6f76;flex:none;box-sizing:border-box"></span>`;

/**
 * The Welcome editor's walkthrough page in body coordinates (origin = the editor body's top-left).
 * @param o.done       step ids shown as completed
 * @param o.glow       0..1 highlight on the open "draw" step
 * @param o.press      0..1 click press on its Draw from dbt button
 * @param o.hero       true: the full-width hero size (this scene); false: the compact page
 */
export function walkthrough({ done = ['openProject'], glow = 0, press = 0, hero = false } = {}) {
  const g = hero ? GEOM.hero : GEOM.compact;
  let h = `<div class="abs" style="left:${g.SX}px;top:${hero ? 18 : 24}px;font-size:${g.TITLE}px;${hero ? 'line-height:52px;' : ''}font-weight:800;letter-spacing:${hero ? '-.015em' : '-.01em'};white-space:nowrap">${WT.title}</div>`;
  h += `<div class="abs" style="left:${g.SX}px;top:80px;width:${g.DESC_W}px;font-size:${g.DESC}px;line-height:${g.DESC_LH}px;color:var(--text-2)">${WT.description}</div>`;
  let y = g.STEPS_Y;
  for (const s of WT.steps) {
    const dot = done.includes(s.id) ? doneDot(g.DOT) : openDot(g.DOT);
    if (s.button) {
      const bw = `rgba(55,148,255,${(0.35 + 0.65 * glow).toFixed(2)})`;
      const btnBg = press > 0 && press < 1 ? '#0b4f7d' : '#0e639c';
      h += `<div class="abs" style="left:${g.SX}px;top:${y}px;width:${g.SW}px;height:${g.OPEN_H}px;border-radius:${hero ? 14 : 12}px;background:#ffffff0c;border:2px solid ${bw};box-shadow:0 0 ${((hero ? 30 : 26) * glow).toFixed(1)}px rgba(55,148,255,${((hero ? 0.4 : 0.35) * glow).toFixed(2)})">
        <div class="abs" style="left:14px;top:${hero ? 16 : 17}px">${dot}</div>
        <div class="abs" style="left:${g.INDENT}px;top:${hero ? 12 : 14}px;font-size:${g.OPEN_T}px;line-height:${hero ? 40 : 36}px;font-weight:700;white-space:nowrap">${esc(s.title)}</div>
        <div class="abs" style="left:${g.INDENT}px;top:${g.TEXT_TOP}px;width:${g.SW - g.INDENT - (hero ? 32 : 28)}px;font-size:${g.TEXT}px;line-height:${g.TEXT_LH}px;color:var(--text-2)">${s.text}</div>
        <div class="abs" style="left:${g.INDENT}px;top:${g.BTN_TOP}px;width:${g.BTN_W}px;height:${g.BTN_H}px;border-radius:${hero ? 8 : 6}px;background:${btnBg};color:#fff;font-size:${g.BTN_F}px;font-weight:${hero ? 700 : 600};display:flex;align-items:center;justify-content:center;white-space:nowrap">${s.button}</div>
      </div>`;
      y += g.OPEN_H + 8;
    } else {
      h += `<div class="abs" style="left:${g.SX}px;top:${y}px;width:${g.SW}px;height:${g.ROW}px;display:flex;align-items:center;gap:${hero ? 16 : 14}px;padding-left:14px;font-size:${g.STEP}px;white-space:nowrap;color:${done.includes(s.id) ? 'var(--text-2)' : 'var(--text)'}">${dot}${esc(s.title)}</div>`;
      y += g.ROW;
    }
  }
  return h;
}

// ---- small inline icons for the activity bar ----
const ai = (d, extra = '') => `<svg class="icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
const ACT_ICONS = {
  files: ai('<path d="M13 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V9z"/><path d="M13 3v6h6"/>'),
  search: ai('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/>'),
  ext: ai('<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/><rect x="14.5" y="2.5" width="7" height="7" rx="1" transform="rotate(12 18 6)"/>'),
  erd: ai('<rect x="3" y="4" width="8" height="6" rx="1.2"/><rect x="13" y="14" width="8" height="6" rx="1.2"/><path d="M7 10v7h6"/>'),
};

/** Activity bar (body coords). */
export function activityBar(active, { erd = true, erdOp = 1 } = {}) {
  const items = [['files', 22], ['search', 88], ['ext', 154]];
  if (erd) items.push(['erd', 220]);
  let h = `<div class="abs" style="left:0;top:0;width:${ACT}px;bottom:0;background:#131619;border-right:1px solid var(--card-border)"></div>`;
  for (const [k, y] of items) {
    const on = k === active;
    h += `<div class="abs" style="left:0;top:${y}px;width:${ACT}px;height:48px;display:flex;align-items:center;justify-content:center;color:${on ? 'var(--text)' : 'var(--text-3)'};${k === 'erd' ? `opacity:${erdOp.toFixed(3)};` : ''}">${ACT_ICONS[k]}</div>`;
    if (on) h += `<div class="abs" style="left:0;top:${y}px;width:3px;height:48px;background:var(--text)"></div>`;
  }
  return h;
}

// the details page's feature bullets (fills the lower half of the page)
const FEATURES = ['Draw your dbt project as an ERD', 'Compare the design with dbt', 'Enrich it with your AI assistant'];

export default {
  render(t, { beats }) {
    const I = beats.install.t, G = beats.guide.t;
    // o_install: "Install ERD Studio"(+0.0–0.59) "for VS Code,"(+0.68–2.46) "and open your dbt project."(+2.83–4.5)
    const click = I + 1.0;              // the pointer clicks Install
    const installed = click + 0.6;      // "Installing" spinner, then "Installed"
    const openAt = I + 2.8;             // "…and open your dbt project"
    const ymlAt = openAt + 0.55;        // dbt_project.yml highlights
    // o_guide: "A short"(+0.0–0.41) "Get started guide"(+0.5–1.55) "opens by itself"(+1.62–2.23)
    const wtAt = G + 0.0;
    const glowAt = G + 1.62;            // the next step lights on "opens by itself"

    const bx = BODY.x, by = BODY.y;
    let body = '';

    // ---- editor area: the extension's details page ----
    const btnX = ED + 32, btnY = 352, btnW = 214, btnH = 62;
    let btn;
    if (t < click + 0.05) btn = `<div class="abs" style="left:${btnX}px;top:${btnY}px;width:${btnW}px;height:${btnH}px;border-radius:8px;background:#0e639c;color:#fff;font-size:28px;font-weight:700;display:flex;align-items:center;justify-content:center">Install</div>`;
    else if (t < installed) btn = `<div class="abs" style="left:${btnX}px;top:${btnY}px;width:${btnW + 40}px;height:${btnH}px;border-radius:8px;background:#0b4f7d;color:#cfe3ff;font-size:28px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:12px">${spinner(t, 28, '#cfe3ff')}Installing</div>`;
    else btn = `<div class="abs" style="left:${btnX}px;top:${btnY}px;height:${btnH}px;padding:0 26px 0 16px;border-radius:999px;background:#13301f;border:2px solid var(--green);color:#dff7e8;font-size:28px;font-weight:800;display:flex;align-items:center;gap:12px;white-space:nowrap;${appear(t, installed, { dy: 0, dur: 0.25 })}"><span class="tick tick--ok" style="width:38px;height:38px">${ICON.check({ size: 24 })}</span>Installed</div>`;
    const edOp = 1 - 0.55 * easeOut(seg(t, openAt, openAt + 0.4));
    body += `<div class="abs" style="left:${ED}px;top:0;right:0;bottom:0;opacity:${edOp.toFixed(3)}">
      <div class="abs" style="left:32px;top:36px">${appIcon(112, 'box-shadow:none')}</div>
      <div class="abs" style="left:164px;top:40px;font-size:42px;font-weight:800;letter-spacing:-.01em;white-space:nowrap">ERD Studio</div>
      <div class="abs" style="left:164px;top:98px;font-size:26px;color:#3794ff;white-space:nowrap">liamwynne</div>
      <div class="abs" style="left:32px;top:178px;width:470px;font-size:26px;line-height:36px;color:var(--text-2)">Visual ERD designer for dbt: draw your models on a canvas, keep the design as YAML in your repo, compare it with dbt.</div>
      <div class="abs" style="left:32px;top:456px;right:32px;height:52px;display:flex;gap:30px;border-bottom:1px solid var(--card-border);font-size:25px;font-weight:600;white-space:nowrap">
        <span style="color:var(--text);box-shadow:inset 0 -3px 0 #3794ff;padding-top:6px">Details</span><span style="color:var(--text-3);padding-top:6px">Features</span><span style="color:var(--text-3);padding-top:6px">Changelog</span></div>
      ${FEATURES.map((f, i) => `<div class="abs" style="left:32px;top:${540 + i * 54}px;display:flex;align-items:center;gap:14px;font-size:26px;white-space:nowrap"><span style="width:10px;height:10px;border-radius:50%;background:#3794ff;flex:none"></span>${f}</div>`).join('')}
    </div>`;
    body += `<div class="abs" style="left:0;top:0;right:0;bottom:0;opacity:${edOp.toFixed(3)}">${btn}</div>`;

    // ---- side bar: Extensions, then Explorer ----
    // Extensions fades out, then Explorer fades in (sequential, so the two lists never overlap)
    const extOut = seg(t, openAt, openAt + 0.15);
    const sw = easeOut(seg(t, openAt + 0.15, openAt + 0.4));
    body += `<div class="abs" style="left:${ACT}px;top:0;width:${SIDE}px;bottom:0;background:#16181b;border-right:1px solid var(--card-border)"></div>`;
    if (extOut < 1) {
      body += `<div class="abs" style="left:${ACT}px;top:0;width:${SIDE}px;bottom:0;opacity:${(1 - extOut).toFixed(3)}">
        <div class="abs" style="left:24px;top:20px;font-size:24px;font-weight:700;letter-spacing:.06em;color:var(--text-2)">EXTENSIONS</div>
        <div class="abs" style="left:18px;top:66px;width:320px;height:54px;border-radius:6px;background:#202126;border:2px solid #0e639c;display:flex;align-items:center;padding-left:16px;font-size:26px">ERD Studio</div>
        <div class="abs" style="left:0;top:140px;width:${SIDE}px;height:132px;background:#04395e88"></div>
        <div class="abs" style="left:18px;top:160px">${appIcon(62, 'box-shadow:none')}</div>
        <div class="abs" style="left:96px;top:150px;font-size:27px;font-weight:700;white-space:nowrap">ERD Studio</div>
        <div class="abs" style="left:96px;top:188px;width:246px;font-size:24px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Visual ERD designer for dbt</div>
        <div class="abs" style="left:96px;top:226px;font-size:24px;color:var(--text-2);white-space:nowrap">liamwynne</div>
      </div>`;
    }
    if (sw > 0) {
      const row = (y, label, { folder = false, hot = 0 } = {}) =>
        `<div class="abs" style="left:0;top:${y}px;width:${SIDE}px;height:50px;background:rgba(27,42,64,${hot.toFixed(3)});${hot > 0 ? `box-shadow:inset 4px 0 0 rgba(96,165,250,${hot.toFixed(3)});` : ''}display:flex;align-items:center;gap:10px;padding-left:${folder ? 18 : 50}px;font-size:27px;white-space:nowrap">
          ${folder ? `<span style="color:var(--text-2)">${ICON.chevRight({ size: 22 })}</span><span style="color:#d9b35a">${ICON.folder({ size: 26 })}</span>` : `<span style="color:#c490e8">${ICON.file({ size: 26 })}</span>`}${label}</div>`;
      body += `<div class="abs" style="left:${ACT}px;top:0;width:${SIDE}px;bottom:0;opacity:${sw.toFixed(3)}">
        <div class="abs" style="left:24px;top:20px;font-size:24px;font-weight:700;letter-spacing:.06em;color:var(--text-2)">EXPLORER</div>
        <div class="abs" style="left:14px;top:68px;display:flex;align-items:center;gap:6px;font-size:24px;font-weight:800;letter-spacing:.04em">${ICON.chevDown({ size: 22 })}JAFFLE-SHOP</div>
        ${row(114, 'models', { folder: true })}${row(166, 'target', { folder: true })}${row(218, 'dbt_project.yml', { hot: easeOut(seg(t, ymlAt, ymlAt + 0.35)) })}
      </div>`;
    }

    // ---- the Welcome editor: the walkthrough slides in over the editor area ----
    if (t >= wtAt) {
      const p = easeOut(seg(t, wtAt, wtAt + 0.5));
      const glow = easeOut(seg(t, glowAt, glowAt + 0.4));
      body += `<div class="abs" style="left:${ACT}px;top:0;right:0;bottom:0;background:var(--card);opacity:${p.toFixed(3)};transform:translateX(${(90 * (1 - p)).toFixed(1)}px)">
        <div class="abs" style="left:${-ACT}px;top:0;right:0;bottom:0">${walkthrough({ glow, hero: true })}</div></div>`;
    }

    // ---- activity bar (on top) ----
    const erdOp = easeOut(seg(t, installed, installed + 0.4));
    body += activityBar(t < openAt ? 'ext' : 'files', { erd: t >= installed, erdOp });

    const tabs = [{ label: 'Extension: ERD Studio', on: t < wtAt + 0.05 }];
    if (t >= wtAt + 0.05) tabs.push({ label: 'Welcome', on: true });
    let html = card({ ...WIN, tabs, crumb: 'jaffle-shop', headStyle: 'font-size:24px', body, style: appear(t, 0, { dy: 16 }) });

    // ---- pointer: in, clicks Install on "…for VS Code", then fades where it is on the Installed swap ----
    const bcx = bx + btnX + btnW / 2, bcy = by + btnY + btnH / 2;
    if (t < installed + 0.25) {
      const pt = path(t, [{ t: I + 0.2, x: 880, y: 1000 }, { t: click - 0.1, x: bcx, y: bcy }]);
      const op = Math.min(seg(t, I + 0.1, I + 0.35), 1 - seg(t, installed, installed + 0.25));
      if (op > 0) html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, seg(t, click, click + 0.4))}</div>`;
    }
    return html;
  },
};
