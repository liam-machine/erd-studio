// readme · 11 · skill — "The skill is just markdown." `md`: the skill Set Up My AI Helper writes,
// open as what it is — .claude/skills/erd-studio/SKILL.md, a markdown file (its real frontmatter
// and opening, from src/services/harnessService.ts; the same text lands in .agents/skills/ for
// the other assistants). "just markdown" tags it on its word, "the model loads" names who reads
// it, and on "renders as a diagram" the strip below shows the point: DBML written to the format
// in the skill → a table on the canvas.
// `hook`: the pre-tool hook Set Up My AI Helper registers in Claude Code, GitHub Copilot, Codex and
// Gemini CLI (the assistant-hooks PR, docs/ai-assistants.md → "The safety check"; Cursor has no
// hook yet and relies on the skill alone). The narration names the four and a "pre-tool hook in"
// row at the foot of the transcript lights each on its name; the conditions (Codex asks you to
// trust a new hook in /hooks, the Windows limits) are left to docs/ai-assistants.md;
// the transcript itself is Claude Code's (.claude/settings.local.json →
// .claude/skills/erd-studio/enforce-skill.sh), as the example: the first Edit to a .erd-studio file in the session is denied with the hook's own
// reason (load the /erd-studio skill first), the skill loads, and the Edit goes through. The hook
// only ever denies — once per session — and never approves anything (src/harness/CLAUDE.md); it
// does not check that the skill was loaded, so the narration says it "tells your AI to load the
// skill first", not that it waits for it.
import { appear, card, easeOut, ICON, node, seg, tick } from '../../lib.js';
import { dbmlLine, FILE_COL, R, wordAt } from './story.js';

const X = 64, W = 952;
const MD = [
  ['---', 'p'],
  ['name: erd-studio', 'kv'],
  ['description: >-', 'kv'],
  ['  Schema rules for ERD Studio data model files — the .erd-studio/', 'v'],
  ['  directory holds DBML tables, relationships and diagrams …', 'v'],
  ['---', 'p'],
  ['', ''],
  ['# ERD Studio — AI Data Modeling Guide', 'h'],
  ['', ''],
  ["ERD Studio keeps a project's logical data model in .erd-studio/", ''],
  ['as plain text files you read and write: tables, the relationships …', ''],
  ['', ''],
  ['## Layout (DBML)', 'h'],
];
function mdLine([s, k]) {
  if (k === 'h') return `<span style="color:#5ca2f8;font-weight:700">${s}</span>`;
  if (k === 'p') return `<span style="color:var(--text-3)">${s}</span>`;
  if (k === 'kv') { const [a, b] = s.split(/:(.*)/); return `<span class="k">${a}</span><span class="p">:</span><span class="s">${b}</span>`; }
  if (k === 'v') return `<span class="s">${s}</span>`;
  return `<span style="color:var(--text)">${s}</span>`;
}
const DIM_DATE = ['Table gold.dim_date [', "  grain: 'One row per day'", '] {', '  date_day   DATE [pk]', '  month_name VARCHAR', '  year       INT', '}'];

export default {
  render(t, { beats, scene }) {
    const H = beats.hook.t;
    const mdAt = wordAt(scene, 'md', 'markdown');
    const loadsAt = wordAt(scene, 'md', 'loads');
    const rendersAt = wordAt(scene, 'md', 'renders') - 0.2;
    const hookAt = wordAt(scene, 'hook', 'pre-tool') - 0.1;
    const heldAt = wordAt(scene, 'hook', 'pauses');
    const loadedAt = wordAt(scene, 'hook', 'to load') + 0.2;
    const toHook = easeOut(seg(t, H - 0.3, H + 0.2));

    let html = '';
    // ---- SKILL.md ----
    // Shrinks to end exactly on a line boundary (head 64 + top 16 + 8 lines of 29, ending y 612 above the transcript at 650), and the lines
    // below it fade as it shrinks, so no line is ever cut through.
    const KEEP = 8;
    const mdH = Math.round(470 - (470 - (64 + 16 + KEEP * 29)) * toHook);
    const lines = MD.map((l, i) => `<div style="height:29px;white-space:pre;overflow:hidden;text-overflow:ellipsis;${i >= KEEP ? `opacity:${(1 - toHook).toFixed(3)};` : ''}">${l[0] ? `<span style="display:inline-block;width:40px;color:var(--line-no);text-align:right;margin-right:18px">${i + 1}</span>` : ''}${mdLine(l)}</div>`).join('');
    html += card({
      x: X, y: 300, w: W, h: mdH, tabs: [{ label: 'SKILL.md', on: true, icon: `<span style="color:${FILE_COL.md}">${ICON.file({ size: 20 })}</span>` }],
      crumb: '.claude › skills › erd-studio', headStyle: 'font-size:22px',
      body: `<div class="abs mono" style="left:10px;right:410px;top:16px;font-size:21px">${lines}</div>`,
      style: appear(t, 0.05, { dy: 16 }),
    });
    if (t >= mdAt - 0.1) {
      html += `<div class="abs" style="right:${1080 - X - W + 22}px;top:384px;display:flex;flex-direction:column;align-items:flex-end;gap:10px">
        <span class="pill" style="font-size:27px;padding:8px 20px;gap:10px;background:#1b2a40;color:#cfe3ff;border:2px solid #2d4a70;${appear(t, mdAt - 0.1, { dy: 8 })}">${ICON.file({ size: 22 })}just markdown</span>
        ${t >= loadsAt - 0.1 ? `<span class="pill" style="font-size:23px;padding:6px 16px;gap:10px;background:#1c1e23;color:var(--text);border:1px solid #3a3d45;${appear(t, loadsAt - 0.1, { dy: 8 })}">${ICON.sparkle({ size: 20 })}loaded by your assistant</span>` : ''}</div>`;
    }

    // ---- md: renders as a diagram ----
    if (t >= rendersAt && toHook < 1) {
      const op = 1 - toHook;
      const SY = 790;
      let s = `<div class="abs" style="left:${X}px;top:${SY}px;width:${W}px;height:${1088 - SY}px;border-radius:16px;background:var(--card);border:1px solid var(--card-border);box-shadow:0 24px 60px #000a;overflow:hidden">
        <div class="abs mono" style="left:24px;top:22px;font-size:19px;line-height:1.45;white-space:pre;color:var(--text-2)">${DIM_DATE.map(dbmlLine).join('\n')}</div></div>`;
      s += `<div class="abs" style="left:${X + 410}px;top:${SY + 118}px;color:var(--text-2);${appear(t, rendersAt + 0.3, { dy: 0, dx: -10 })}">${ICON.arrow({ size: 44 })}</div>`;
      s += `<div class="abs" style="left:0;top:0;${appear(t, rendersAt + 0.5, { dy: 12 })}">${node({ x: X + 488, y: SY + 22, w: 430, name: R.dim_date.name, layer: R.badge, grain: R.dim_date.grain, cols: R.dim_date.cols, style: 'box-shadow:0 0 0 5px rgba(96,165,250,.3),0 18px 44px #0009' })}</div>`;
      html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)};${appear(t, rendersAt, { dy: 16 })}">${s}</div>`;
    }

    // ---- hook: a Claude Code transcript ----
    if (t >= H - 0.3) {
      const TY = 650;
      const row = (y, html2, at) => `<div class="abs mono" style="left:26px;right:26px;top:${y}px;display:flex;align-items:center;gap:12px;font-size:21px;white-space:nowrap;${appear(t, at, { dy: 0, dx: -10, dur: 0.3 })}">${html2}</div>`;
      const dot = (c) => `<span class="dot" style="background:${c}"></span>`;
      let b = '';
      const editPath = '.erd-studio/gold/tables/gold/dim_date.dbml';
      b += row(18, `${dot('var(--text)')}<span style="color:var(--text)">Edit</span><span style="color:var(--text-2)">(${editPath})</span>`, H - 0.1);
      if (t >= hookAt) {
        const held = t >= heldAt;
        b += `<div class="abs" style="left:26px;right:26px;top:66px;padding:12px 16px;border-radius:10px;background:${held ? '#2b230f' : '#1c1e23'};border:1px solid ${held ? '#6b5418' : '#3a3d45'};${appear(t, hookAt, { dy: 8, dur: 0.3 })}">
          <div style="display:flex;align-items:center;gap:12px;font-size:22px;font-weight:700;white-space:nowrap"><span style="color:var(--claude);display:flex">${ICON.lock({ size: 20 })}</span>PreToolUse hook<span class="mono" style="font-weight:400;font-size:19px;color:var(--text-2)">enforce-skill.sh</span>
            ${held ? `<span class="pill" style="margin-left:auto;font-size:19px;padding:3px 12px;background:#3d3113;color:var(--amber);${appear(t, heldAt, { dy: 0 })}">${ICON.warn({ size: 18 })}first edit paused</span>` : ''}</div>
          ${held ? `<div class="mono" style="margin-top:8px;font-size:18px;color:#e9d6a6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${appear(t, heldAt, { dy: 0 })}">load the /erd-studio skill (file-format rules) before editing .erd-studio files</div>` : ''}</div>`;
      }
      if (t >= loadedAt - 0.5) b += row(198, `${dot('var(--green)')}<span style="color:var(--text)">Skill</span><span style="color:var(--text-2)">(/erd-studio)</span><span style="color:var(--green);font-family:Inter;font-size:20px">loaded</span>${tick('ok')}`, loadedAt - 0.5);
      if (t >= loadedAt + 0.15) b += row(250, `${dot('var(--green)')}<span style="color:var(--text)">Edit</span><span style="color:var(--text-2)">(${editPath})</span>${tick('ok')}`, loadedAt + 0.15);
      // The assistants that get the hook, each on its name.
      const chip = (name, word) => {
        const at = wordAt(scene, 'hook', word);
        const on = t >= at;
        return `<span class="pill" style="font-size:19px;padding:4px 14px;background:${on ? '#2a1d17' : 'transparent'};color:${on ? '#f3c3ab' : 'var(--text-3)'};border:1px solid ${on ? '#6b3f2a' : '#34363d'};${appear(t, Math.min(at, H), { dy: 0, dur: 0.25 })}">${name}</span>`;
      };
      b += `<div class="abs" style="left:26px;right:26px;top:316px;display:flex;align-items:center;gap:10px;white-space:nowrap;padding-top:12px;border-top:1px solid var(--row-line);${appear(t, H - 0.1, { dy: 0 })}"><span style="font-size:19px;color:var(--text-2);margin-right:4px">pre-tool hook in</span>${chip('Claude Code', 'Claude')}${chip('GitHub Copilot', 'Copilot')}${chip('Codex', 'Codex')}${chip('Gemini CLI', 'Gemini')}</div>`;
      html += card({
        x: X, y: TY, w: W, h: 1088 - TY, dots: true,
        tabs: [{ label: 'Claude Code', on: true, icon: `<span style="color:var(--claude)">${ICON.claude({ size: 20 })}</span>` }],
        crumb: 'once per session', headStyle: 'font-size:22px', body: b, style: appear(t, H - 0.3, { dy: 24, dur: 0.4 }),
      });
    }
    return html;
  },
};
