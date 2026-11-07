// One pull request, the design and the code: "The design change goes in the same pull request as the
// code that builds it, so your team reviews both together." Both cuts'.
//
// A code review's Files changed, drawn light (GitHub's light diff colours; the GitHub mark is used
// nominatively, assets/logos/github.svg): no repo URL, no user name, no PR number. Left, the design:
// the .dbml lines Claude Code wrote in the AI beat (tour/aiChange CHANGE, its own edits, plus the
// `use` line its Ref needs); right, the code: a new pipelines/dim_customer.sql that builds the table,
// and the one-line change to the loader the folder already has (pipelines/load_orders.py, shown
// collapsed) that fills fct_order's new customer_id, so both changed tables have code (pipelines/ is
// the tour folder's own code folder, record/fixtures.mjs). Then the review: approved, ready to merge,
// both together.
import { appear, easeOut, esc, ICON, lerp, seg } from '../../lib.js';
import { phraseAt } from './confluence.js';
import { CHANGE } from './aiChange.js';

/** The pull request's title: what was asked of Claude Code (record/scenes.mjs CLAUDE_REQUEST). */
export const TITLE = 'Add a dim_customer table, linked to fct_order';
/** The design side: the .dbml files the change touched (path, lines added; null lines: shown collapsed). */
export const DESIGN = [
  { path: CHANGE.table.path, badge: 'new file', lines: CHANGE.table.lines },
  { path: CHANGE.ref.path, badge: '+2', lines: [CHANGE.ref.use, CHANGE.ref.line] },
  { path: '.erd-studio/main/tables/main/fct_order.dbml', badge: '+1', lines: null },
  { path: '.erd-studio/main/diagrams/sales.dbml', badge: '+2', lines: null },
];
/** The code side: the SQL that builds the new table, beside the code the project already has. */
export const CODE = {
  path: 'pipelines/dim_customer.sql',
  lines: ['create or replace table dim_customer as', 'select', '    customer_id,', '    customer_name,', '    email,', '    city,', '    region', 'from raw.customers;'],
};
/** The code that already loads fct_order (record/fixtures.mjs PLAIN), one line changed to fill its new customer_id: shown collapsed. */
export const CODE_ALSO = { path: 'pipelines/load_orders.py', badge: '+1', lines: null };

const X = 96, Y = 240, W = 1728, H = 720;          // the page: where the window was
const COLW = (W - 3 * 24) / 2;
const C = { line: '#d0d7de', head: '#f6f8fa', text: '#1f2328', text2: '#57606a', add: '#e6ffec', gutter: '#ccffd8', sign: '#1a7f37', kw: '#cf222e', str: '#0a3069', attr: '#8250df', green: '#1f883d', tab: '#fd8c73' };
const LOGO = '/video/player/assets/logos/github.svg';
/** An open pull request's mark (drawn here: two branches joining). */
const prMark = (size) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5.5" r="2.5"/><circle cx="6" cy="18.5" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M6 8v8M18 16V9.5a3 3 0 0 0-3-3h-4M13 4l-2.5 2.5L13 9"/></svg>`;
export const FILES = DESIGN.length + 2;
export const ADDED = DESIGN.reduce((n, f) => n + (f.badge === 'new file' ? f.lines.length : +f.badge.slice(1)), 0) + CODE.lines.length + +CODE_ALSO.badge.slice(1);

/** Light syntax colours for a .dbml or .sql line (escaped first; keywords, strings, settings). */
const KW = /\b(Table|Ref|use|from|table|create|or|replace|as|select)\b/g;
function hl(line) {
  return esc(line)
    .replace(/("[^"]*"|'[^']*')/g, `<span style="color:${C.str}">$1</span>`)
    .replace(/(\[pk\])/g, `<span style="color:${C.attr}">$1</span>`)
    .replace(KW, (m, _w, at, src) => (/<span[^>]*$/.test(src.slice(0, at)) ? m : `<span style="color:${C.kw}">${m}</span>`));
}

const fileHead = (path, badge, ring) => `<div style="display:flex;align-items:center;gap:10px;height:40px;padding:0 14px;background:${C.head};border-bottom:1px solid ${C.line};white-space:nowrap">
    <span style="color:${C.text2};display:flex">${ICON.chevDown({ size: 16 })}</span><span class="mono" style="font-size:16px;font-weight:600;color:${C.text}">${path}</span><span style="flex:1"></span>
    <span class="pill" style="font-size:14px;padding:3px 10px;background:${ring > 0.5 ? '#abf2bc' : '#dafbe1'};color:${C.sign};font-weight:700">${badge}</span></div>`;
const addRow = (text) => `<div style="display:flex;height:26px;align-items:center;white-space:pre;background:${C.add}">
    <span style="width:30px;flex:none;align-self:stretch;display:flex;align-items:center;justify-content:center;background:${C.gutter};color:${C.sign}">+</span><span style="padding-left:10px">${hl(text)}</span></div>`;
const fileCard = (f, at, t, ring = 0) => `<div style="border:1.5px solid ${ring > 0 ? `rgba(31,136,61,${(0.35 + 0.65 * ring).toFixed(3)})` : C.line};border-radius:8px;overflow:hidden;background:#fff;${appear(t, at, { dy: 10 })}">
    ${fileHead(f.path, f.badge === 'new file' ? `new file · +${f.lines.length}` : f.badge, ring)}
    ${f.lines ? `<div class="mono" style="font-size:16px;color:${C.text};padding:4px 0">${f.lines.map(addRow).join('')}</div>` : ''}</div>`;
const sideLabel = (label, sub, at, t) => `<div style="display:flex;align-items:baseline;gap:12px;height:34px;white-space:nowrap;${appear(t, at, { dy: 6 })}">
    <span style="font-size:24px;font-weight:800;color:${C.text}">${label}</span><span style="font-size:18px;color:${C.text2}">${sub}</span></div>`;

export default {
  render(t, { scene }) {
    const designAt = phraseAt(scene, 'one', 'design change');
    const codeAt = phraseAt(scene, 'one', 'the code');
    const reviewAt = scene.beats.review.t;
    const togetherAt = phraseAt(scene, 'review', 'both together');
    // both sides light together on "reviews both together"
    const both = Math.sin(Math.PI * seg(t, togetherAt - 0.1, togetherAt + 1.1));

    let html = `<div class="abs" style="left:${X}px;top:${Y}px;width:${W}px;height:${H}px;border-radius:14px;background:#fff;overflow:hidden;box-shadow:0 0 0 1px #c3cad3,0 24px 60px rgba(31,35,40,.18);${appear(t, 0.05, { dy: 14 })}">
      <div style="display:flex;align-items:center;gap:14px;height:72px;padding:0 24px;border-bottom:1px solid ${C.line};white-space:nowrap">
        <img src="${LOGO}" width="30" height="30" style="display:block;width:30px;height:30px">
        <span class="pill" style="font-size:18px;padding:6px 14px;gap:7px;background:${C.green};color:#fff;font-weight:700">${prMark(18)}Open</span>
        <span style="font-size:28px;font-weight:700;color:${C.text};letter-spacing:-.01em">${esc(TITLE)}</span>
        <span style="flex:1"></span>
        <span class="mono" style="font-size:19px;font-weight:700;color:${C.sign}">+${ADDED}</span><span class="mono" style="font-size:19px;font-weight:700;color:${C.kw}">−0</span></div>
      <div style="display:flex;align-items:flex-end;gap:6px;height:52px;padding:0 20px;border-bottom:1px solid ${C.line};font-size:19px;color:${C.text2};white-space:nowrap">
        ${['Conversation', 'Commits', 'Checks'].map((l) => `<span style="padding:0 14px 13px">${l}</span>`).join('')}
        <span style="padding:0 14px 11px;color:${C.text};font-weight:700;border-bottom:3px solid ${C.tab};display:flex;align-items:center;gap:8px">Files changed<span style="font-size:15px;padding:1px 9px;border-radius:999px;background:#eaeef2;color:${C.text}">${FILES}</span></span></div>`;

    // the design (left) and the code (right)
    const dRing = Math.max(easeOut(seg(t, designAt, designAt + 0.4)) * (1 - seg(t, codeAt, codeAt + 0.6)) * 0.9, both);
    const cRing = Math.max(easeOut(seg(t, codeAt, codeAt + 0.4)) * 0.9 * (1 - seg(t, reviewAt, reviewAt + 0.6)), both);
    const left = `<div class="abs" style="left:24px;top:146px;width:${COLW}px;display:flex;flex-direction:column;gap:12px">
        ${sideLabel('The design', 'DBML, in .erd-studio/', designAt - 0.15, t)}
        ${DESIGN.map((f, i) => fileCard(f, designAt + i * 0.12, t, i < 2 ? dRing : 0)).join('')}</div>`;
    const right = `<div class="abs" style="left:${48 + COLW}px;top:146px;width:${COLW}px;display:flex;flex-direction:column;gap:12px">
        ${sideLabel('The code', 'SQL and Python, in pipelines/', codeAt - 0.15, t)}
        ${fileCard({ path: CODE.path, badge: 'new file', lines: CODE.lines }, codeAt, t, cRing)}
        ${fileCard(CODE_ALSO, codeAt + 0.12, t)}</div>`;
    html += left + right;

    // the review: approved, both sides in one merge
    if (t >= reviewAt - 0.1) {
      const m = easeOut(seg(t, togetherAt, togetherAt + 0.4));
      html += `<div class="abs" style="left:${48 + COLW}px;top:${146 + 34 + 12 + 40 + CODE.lines.length * 26 + 8 + 3 + 12 + 43 + 26}px;width:${COLW}px;border:1.5px solid ${C.line};border-radius:8px;background:#fff;padding:18px 20px;display:flex;align-items:center;gap:14px;white-space:nowrap;${appear(t, reviewAt - 0.1, { dy: 10 })}">
        <span style="width:34px;height:34px;border-radius:50%;background:${C.green};color:#fff;display:flex;align-items:center;justify-content:center">${ICON.check({ size: 20 })}</span>
        <span style="display:flex;flex-direction:column;gap:3px"><span style="font-size:21px;font-weight:700;color:${C.text}">Changes approved</span><span style="font-size:17px;color:${C.text2}">${FILES} files: the design and the code, reviewed together</span></span>
        <span style="flex:1"></span>
        <span style="font-size:19px;font-weight:700;color:#fff;background:${C.green};padding:11px 18px;border-radius:8px;transform:scale(${lerp(1, 1.06, Math.sin(Math.PI * m)).toFixed(3)});box-shadow:0 0 0 ${(6 * Math.sin(Math.PI * m)).toFixed(1)}px rgba(31,136,61,.18)">Merge pull request</span></div>`;
    }
    return html + '</div>';
  },
};
