// readme · 10 · ai — "Set Up My AI Helper, in the ERD Studio sidebar." `setup`: where a user finds
// it, not the Command Palette. A VS Code window: the activity bar, the Explorer open first; the
// pointer clicks the ERD Studio icon (package.json viewsContainers.activitybar, media/icon-sidebar.svg)
// on "ERD Studio" and the side bar becomes ERD STUDIO with its four views (package.json views:
// Diagrams and Table Library expanded, Relationships and Help & Feedback `visibility: collapsed`,
// so their headers sit at the foot of the side bar, as VS Code pins collapsed views). On "Help"
// the pointer expands HELP & FEEDBACK, which rises to make room for its rows
// (src/providers/HelpTreeProvider.ts HELP_ACTIONS, in
// order: Set Up My AI Helper · Watch the Tour · Show Me Around · Send Feedback · Show Logs, each
// with its codicon) and clicks Set Up My AI Helper (erdStudio.setupAiHelper). In the editor area an
// explainer card, "What it adds" (not product UI: the real command installs for the assistants it
// finds and says so in a notification), ticks the five assistants in on their names, each with where
// its skill lands (.claude/skills/ for Claude Code, .agents/skills/ for the rest —
// docs/ai-assistants.md); "+ hook" marks the assistants that also get the pre-edit hook (Claude
// Code, GitHub Copilot, Codex, Gemini CLI — the assistant-hooks PR, docs/ai-assistants.md → "The
// safety check"; Cursor has no hook yet and relies on the skill alone). skill.js opens the skill
// itself; aiwrite.js shows an assistant using it.
import { appear, easeOut, ICON, lerp, path, pointer, seg, tick } from '../../lib.js';
import { FILE_COL, wordAt } from './story.js';

const X = 64, Y = 300, W = 952, H = 780;
const AB = 76;                       // activity bar
const SB = 440;                      // side bar
const SX = X + AB, EX = X + AB + SB, EW = W - AB - SB;
const ASSISTANTS = [
  { name: 'Claude Code', word: 'Claude', dir: '.claude/skills/', hook: true },
  { name: 'GitHub Copilot', word: 'Copilot', dir: '.agents/skills/', hook: true },
  { name: 'Codex', word: 'Codex', dir: '.agents/skills/', hook: true },
  { name: 'Gemini CLI', word: 'Gemini', dir: '.agents/skills/', hook: true },
  { name: 'Cursor', word: 'Cursor', dir: '.agents/skills/' },
];

// Codicon-like glyphs (inline SVG: the font subsets have none).
const g = (d, size = 24, sw = 1.8) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const AB_ICON = {
  files: g('<path d="M8 3h7l4 4v11H8z"/><path d="M15 3v4h4M5 7v14h11"/>', 34),
  search: g('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L20 20"/>', 34),
  scm: g('<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 7.2v9.6M18 10.2c0 4-6 3-11 7"/>', 34),
  ext: g('<rect x="3.5" y="9.5" width="5.5" height="5.5"/><rect x="9" y="9.5" width="5.5" height="5.5"/><rect x="3.5" y="15" width="5.5" height="5.5"/><rect x="9" y="15" width="5.5" height="5.5"/><rect x="14.5" y="3.5" width="5.5" height="5.5" transform="rotate(12 17 6)"/>', 34),
};
const erdIcon = (size, col) => `<span style="display:block;width:${size}px;height:${size}px;background:${col};-webkit-mask:url(/media/icon-sidebar.svg) center/contain no-repeat;mask:url(/media/icon-sidebar.svg) center/contain no-repeat"></span>`;
const ROW_ICON = {
  sparkle: ICON.sparkle({ size: 22 }),
  play: g('<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l5.5-3.5z" fill="currentColor" stroke-width="1"/>', 22),
  compass: g('<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z" fill="currentColor" stroke-width="1"/>', 22),
  comment: g('<path d="M4 5h11v8H9l-3 3v-3H4z"/><path d="M15 9h5v8h-2v3l-3-3h-5v-1"/>', 22),
  output: g('<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M8 9h8M8 13h8M8 17h5"/>', 22),
};
const HELP = [
  { label: 'Set Up My AI Helper', icon: 'sparkle' },
  { label: 'Watch the Tour', icon: 'play' },
  { label: 'Show Me Around', icon: 'compass' },
  { label: 'Send Feedback', icon: 'comment' },
  { label: 'Show Logs', icon: 'output' },
];

// Side bar geometry (frame space). Diagrams and Table Library are expanded panes from the top;
// the collapsed Relationships and Help & Feedback headers sit at the foot of the side bar, and
// Help & Feedback rises by its five rows as it expands.
const HEAD_H = 58, VH = 48, RH = 42;
const vy = { diagrams: Y + HEAD_H };
vy.dRows = vy.diagrams + VH;          // three rows: Gold, sales, shop
vy.library = vy.dRows + 3 * RH + 6;
vy.lRows = vy.library + VH;           // three rows: Gold, dim_customer, fct_order
vy.helpShut = Y + H - VH;             // collapsed: the last header in the side bar
vy.helpOpen = Y + H - VH - HELP.length * RH - 10;

export default {
  render(t, { scene }) {
    const erdAt = wordAt(scene, 'setup', 'ERD Studio') + 0.25;      // click the activity bar icon
    const helpAt = wordAt(scene, 'setup', 'Help') + 0.15;           // expand Help & Feedback
    const runAt = wordAt(scene, 'setup', 'Helper') + 0.1;           // click Set Up My AI Helper
    const panelAt = wordAt(scene, 'setup', 'adds') - 0.1;
    const inErd = t >= erdAt;
    const open = easeOut(seg(t, helpAt, helpAt + 0.35));
    let html = '';

    // ---- window ----
    html += `<div class="abs" style="left:${X}px;top:${Y}px;width:${W}px;height:${H}px;border-radius:16px;background:var(--card);border:1px solid var(--card-border);box-shadow:0 30px 80px #000a;overflow:hidden;${appear(t, 0, { dy: 16 })}">
      <div class="abs" style="left:0;top:0;width:${AB}px;bottom:0;background:#131518;border-right:1px solid var(--card-border)"></div>
      <div class="abs" style="left:${AB}px;top:0;width:${SB}px;bottom:0;background:#17181c;border-right:1px solid var(--card-border)"></div>
      <div class="abs grid-bg" style="left:${AB + SB}px;top:52px;right:0;bottom:0;opacity:.55"></div>
      <div class="abs" style="left:${AB + SB}px;top:0;right:0;height:52px;background:var(--card-head);border-bottom:1px solid var(--card-border)"></div>
      <div class="abs" style="left:${AB + SB}px;top:0;height:52px;padding:0 20px;display:flex;align-items:center;gap:10px;font-size:21px;color:var(--text);background:var(--card);border-right:1px solid var(--card-border)"><span style="color:${FILE_COL.dbml}">${ICON.file({ size: 20 })}</span>sales.dbml</div>
    </div>`;

    // ---- activity bar ----
    const abIcons = ['files', 'search', 'scm', 'ext'];
    abIcons.forEach((k, i) => {
      const active = k === 'files' && !inErd;
      html += `<div class="abs" style="left:${X}px;top:${Y + 20 + i * 70}px;width:${AB}px;height:62px;display:flex;align-items:center;justify-content:center;color:${active ? 'var(--text)' : '#6c6f76'};${active ? 'box-shadow:inset 3px 0 0 var(--text);' : ''}">${AB_ICON[k]}</div>`;
    });
    const erdY = Y + 20 + 4 * 70;
    const hot = !inErd && t >= erdAt - 0.6;
    html += `<div class="abs" style="left:${X}px;top:${erdY}px;width:${AB}px;height:62px;display:flex;align-items:center;justify-content:center;${inErd ? 'box-shadow:inset 3px 0 0 var(--text);' : ''}">${erdIcon(38, inErd || hot ? '#e9ecef' : '#6c6f76')}</div>`;

    // ---- side bar ----
    const sbTitle = inErd ? 'ERD STUDIO' : 'EXPLORER';
    html += `<div class="abs" style="left:${SX + 22}px;top:${Y}px;height:${HEAD_H}px;display:flex;align-items:center;font-size:19px;font-weight:600;letter-spacing:.06em;color:var(--text-2)">${sbTitle}</div>`;
    const viewHead = (y, label, expanded, extra = '', style = '') => `<div class="abs" style="left:${SX}px;width:${SB}px;top:${y}px;height:${VH}px;display:flex;align-items:center;gap:6px;padding:0 14px;font-size:18px;font-weight:700;letter-spacing:.04em;color:var(--text);border-top:1px solid var(--card-border);white-space:nowrap;${style}"><span style="color:var(--text-2);display:flex">${expanded ? ICON.chevDown({ size: 20 }) : ICON.chevRight({ size: 20 })}</span>${label}${extra}</div>`;
    const row = (y, indent, icon, label, desc = '', style = '') => `<div class="abs" style="left:${SX}px;width:${SB}px;top:${y}px;height:${RH}px;display:flex;align-items:center;gap:10px;padding-left:${indent}px;font-size:21px;color:var(--text);white-space:nowrap;overflow:hidden;${style}">${icon}<span>${label}</span>${desc ? `<span style="font-size:18px;color:var(--text-2)">${desc}</span>` : ''}</div>`;

    if (!inErd) {
      // The Explorer: the repo the earlier scenes built.
      const folder = (c = '#8b9099') => `<span style="color:${c};display:flex">${ICON.folder({ size: 20 })}</span>`;
      html += viewHead(vy.diagrams, 'ACME-ANALYTICS', true);
      html += row(vy.dRows, 26, `<span style="color:var(--text-2);display:flex">${ICON.chevRight({ size: 18 })}</span>${folder('#e8a24a')}`, '.erd-studio');
      html += row(vy.dRows + RH, 26, `<span style="color:var(--text-2);display:flex">${ICON.chevRight({ size: 18 })}</span>${folder()}`, 'sql');
      html += row(vy.dRows + 2 * RH, 52, `<span style="color:var(--blue);display:flex">${ICON.file({ size: 20 })}</span>`, 'README.md');
    } else {
      const sw = `<span style="width:16px;height:16px;border-radius:4px;background:#f6c344;display:inline-block"></span>`;
      const dbml = `<span style="color:${FILE_COL.dbml};display:flex">${ICON.file({ size: 20 })}</span>`;
      const plus = `<span style="margin-left:auto;color:var(--text-2);display:flex">${ICON.plus({ size: 18, sw: 2.2 })}</span>`;
      const fade = appear(t, erdAt, { dy: 0, dur: 0.25 });
      html += viewHead(vy.diagrams, 'DIAGRAMS', true, plus, fade);
      html += row(vy.dRows, 26, `<span style="color:var(--text-2);display:flex">${ICON.chevDown({ size: 18 })}</span>${sw}`, 'Gold', 'Layer · 2 diagrams', fade);
      html += row(vy.dRows + RH, 74, dbml, 'sales', '', fade);
      html += row(vy.dRows + 2 * RH, 74, dbml, 'shop', '', fade);
      // Table Library (expanded by default): the Gold layer and its two tables (compact rows).
      const tbl = `<span style="color:${FILE_COL.dbml};display:flex">${ICON.table({ size: 20 })}</span>`;
      html += viewHead(vy.library, 'TABLE LIBRARY', true, '', fade);
      html += row(vy.lRows, 26, `<span style="color:var(--text-2);display:flex">${ICON.chevDown({ size: 18 })}</span>${sw}`, 'Gold', 'Layer', fade);
      html += row(vy.lRows + RH, 74, tbl, 'dim_customer', '', fade);
      html += row(vy.lRows + 2 * RH, 74, tbl, 'fct_order', '', fade);
      const helpY = lerp(vy.helpShut, vy.helpOpen, open);
      html += viewHead(helpY - VH, 'RELATIONSHIPS', false, '', fade);
      const helpHot = t >= helpAt - 0.5 && t < helpAt + 0.3;
      html += viewHead(helpY, 'HELP &amp; FEEDBACK', open > 0, '', `${fade}${helpHot ? 'background:#22252b;' : ''}`);
      if (open > 0) {
        // The rows keep their spacing and are clipped at the foot of the window while the pane opens.
        html += `<div class="abs" style="left:0;top:0;width:1080px;height:1350px;clip-path:inset(0 0 ${1350 - (Y + H)}px 0)">`;
        HELP.forEach((h, i) => {
          const y = helpY + VH + i * RH;
          const sel = i === 0 && t >= runAt;
          const bg = sel ? `background:${t < runAt + 0.35 ? '#0e639c' : '#04395e'};box-shadow:inset 0 0 0 1px #2f81d1;` : '';
          const col = h.icon === 'sparkle' ? 'var(--text)' : 'var(--text-2)';
          html += row(y, 40, `<span style="color:${col};display:flex">${ROW_ICON[h.icon]}</span>`, h.label, '', `opacity:${open.toFixed(3)};${bg}${i === 0 ? 'font-weight:600;' : ''}`);
        });
        html += '</div>';
      }
    }

    // ---- editor area: what Set Up My AI Helper writes ----
    if (t >= panelAt) {
      const PX = EX + 22, PW = EW - 44, PY = Y + 80;
      const R2 = 92;
      let s = `<div class="abs" style="left:${PX}px;top:${PY}px;width:${PW}px;height:${62 + ASSISTANTS.length * R2 + 10}px;border-radius:16px;background:var(--card-inner);border:1px solid #34363d;box-shadow:0 24px 60px #000b;${appear(t, panelAt, { dy: 16 })}">
        <div style="height:56px;display:flex;align-items:center;gap:10px;padding:0 20px;font-size:21px;font-weight:700;border-bottom:1px solid var(--row-line);white-space:nowrap"><span style="color:var(--text-2)">What it adds</span></div></div>`;
      ASSISTANTS.forEach((a, i) => {
        const at = wordAt(scene, 'setup', a.word);
        const y = PY + 62 + i * R2;
        const done = t >= at;
        s += `<div class="abs" style="left:${PX + 18}px;width:${PW - 36}px;top:${y}px;height:${R2}px;display:flex;align-items:center;gap:16px;white-space:nowrap;${i < ASSISTANTS.length - 1 ? 'border-bottom:1px solid var(--row-line);' : ''}${appear(t, Math.min(at, panelAt + 0.1 + i * 0.08), { dy: 8 })}">
          ${done ? tick('ok') : '<span class="tick" style="border:2px solid #3a3d45"></span>'}
          <div style="min-width:0"><div style="display:flex;align-items:center;gap:10px"><span style="font-size:26px;font-weight:700;color:${done ? 'var(--text)' : 'var(--text-2)'}">${a.name}</span>${a.hook ? '<span class="pill" style="font-size:16px;padding:2px 10px;background:#2a1d17;color:#f3c3ab;border:1px solid #6b3f2a">+ hook</span>' : ''}</div>
          <div class="mono" style="font-size:18px;color:var(--text-3);margin-top:2px">${a.dir}erd-studio/</div></div></div>`;
      });
      html += s;
      const skillAt = wordAt(scene, 'setup', 'a skill');
      if (t >= skillAt) {
        html += `<div class="abs" style="left:${PX}px;width:${PW}px;top:${PY + 62 + ASSISTANTS.length * R2 + 30}px;display:flex;justify-content:center;${appear(t, skillAt, { dy: 10 })}">
          <span class="pill" style="font-size:22px;padding:8px 18px;background:#1b2a40;color:#cfe3ff;border:1px solid #2d4a70">${ICON.sparkle({ size: 20 })}one skill: the <span class="mono" style="font-weight:600">erd-studio</span> format</span></div>`;
      }
    }

    // ---- the pointer: ERD Studio icon → Help & Feedback → Set Up My AI Helper ----
    const ix = X + AB / 2 + 4, iy = erdY + 34;
    const hx = SX + 150, hy = vy.helpShut + VH / 2 + 4;
    const rx = SX + 190, ry = vy.helpOpen + VH + RH / 2 + 4;
    const pts = [
      { t: 0.2, x: EX + 220, y: Y + 520 },
      { t: erdAt - 0.05, x: ix, y: iy }, { t: erdAt + 0.25, x: ix, y: iy },
      { t: helpAt - 0.05, x: hx, y: hy }, { t: helpAt + 0.35, x: hx, y: vy.helpOpen + VH / 2 + 4 },   // rides the header up as the pane opens
      { t: runAt - 0.05, x: rx, y: ry }, { t: runAt + 0.5, x: rx, y: ry },
      { t: runAt + 1.2, x: rx + 160, y: ry + 200 },
    ];
    if (t < runAt + 1.3) {
      const p = path(t, pts);
      const press = [erdAt, helpAt, runAt].map((c) => (t >= c && t < c + 0.35 ? seg(t, c, c + 0.35) : 0)).find((v) => v > 0) ?? 0;
      const op = Math.min(seg(t, 0.1, 0.35), 1 - seg(t, runAt + 0.8, runAt + 1.3));
      html += `<div class="abs" style="left:0;top:0;z-index:5;opacity:${op.toFixed(3)}">${pointer(p.x, p.y, press)}</div>`;
    }
    return html;
  },
};
