// readme · 13 · parse — "If you use dbt, run dbt parse." `if`: the caveat first — comparing with
// the physical model is for dbt projects, dbt is the first physical source and more are to follow.
// Below the canvas a PHYSICAL MODEL panel: the dbt tile (its official mark; manifest.json ·
// catalog.json, the files ERD Studio reads) lit on "dbt", "compared with your design" on
// "physical model", and dashed "more to follow" tiles on their words (no source is named: none is
// promised). It gives way to the terminal before Run dbt parse is pressed.
// `parse`: the same sales diagram, now in a dbt project
// (the stage tabs and Compare with dbt appear only there) before dbt has run: the logical stage's
// ManifestHint strip (webview/components/Canvas/ManifestHint.tsx — its own words and its Run dbt
// parse button). The pointer presses Run dbt parse on "Run"; the host runs `dbt parse` in a VS
// Code terminal, and on "manifest.json" target/manifest.json opens below: dbt's description of
// every model the project builds, with its columns and tests (an excerpt; the column types that
// come from the warehouse are catalog.json's, from dbt docs generate — not claimed here). dbt
// parse needs no warehouse connection, so nothing here says it reads one. The terminal's two
// output lines are illustrative (dbt's own opening lines, not a captured run).
import { appear, appearFade, card, caret, easeOut, ICON, jsonLine, path, pointer, seg, typed } from '../../lib.js';
import { FILE_COL, R, toolbar2, viewFileBtn, wordAt } from './story.js';

const X = 64, W = 952;
const CY = 300, CH = 330;
const TBX = X + 24, TBY = CY + 64 + 16;
const TY = 642, TH = 188;               // header 52 + three 34 px rows: nothing clipped
const MY = 846;
const MANIFEST = [
  '{ "nodes": {',
  '    "model.acme_analytics.fct_order": {',
  '      "columns": { "order_id": {…}, "customer_id": {…}, "order_date": {…}, … },',
  '    "model.acme_analytics.dim_customer": { … },',
  '    "test.acme_analytics.unique_fct_order_order_id": { … },',
];

export default {
  render(t, { scene }) {
    const runAt = wordAt(scene, 'parse', 'Run');
    const manAt = wordAt(scene, 'parse', 'manifest');
    const everyAt = wordAt(scene, 'parse', 'every model');
    const pressAt = runAt + 0.15;
    const ran = t >= pressAt + 0.1;
    const dbtAt = wordAt(scene, 'if', 'dbt');
    const physAt = wordAt(scene, 'if', 'physical');
    const moreAt = wordAt(scene, 'if', 'more');
    const firstAt = wordAt(scene, 'if', 'first');

    // ---- the canvas, logical stage, with the hint strip ----
    let body = '';
    const hintOp = 1 - seg(t, manAt + 0.6, manAt + 1.0);
    body += `<div class="abs" style="left:0;right:0;top:150px;padding:14px 22px;background:#3a2f12;border-top:1px solid #5a4818;border-bottom:1px solid #5a4818;display:flex;align-items:center;gap:16px;opacity:${hintOp.toFixed(3)}">
      <span style="color:#f0d48a;font-size:24px">&#9432;</span>
      <span style="flex:1;font-size:20px;line-height:1.35;color:#f3e3b5">dbt hasn't parsed this project yet. Your diagram is fine, but the Physical view can't show columns and tests without it.</span>
      <span class="btn btn--primary" style="font-size:21px;${t >= pressAt && t < pressAt + 0.3 ? 'background:#1177bb;transform:scale(.96);' : ''}">Run dbt parse</span>
      <span style="color:#c9b98a;font-size:24px">&times;</span></div>`;
    if (hintOp < 1) {
      body += `<div class="abs" style="left:24px;top:168px;${appear(t, manAt + 0.8, { dy: 8 })}"><span class="pill" style="font-size:22px;padding:6px 16px;gap:10px;background:#13301f;color:var(--green);border:1px solid #1f5a35">${ICON.check({ size: 18 })}manifest.json found · Physical tab ready</span></div>`;
    }
    let html = card({
      x: X, y: CY, w: W, h: CH, tabs: [{ label: 'sales.dbml', on: true, icon: `<span style="color:${FILE_COL.dbml}">${ICON.file({ size: 20 })}</span>` }],
      crumb: 'a dbt project', bodyCls: 'grid-bg', body,
    });
    html += toolbar2({ x: TBX, y: TBY, stage: 'logical', compare: 'off' });
    html += viewFileBtn(X + W - 24 - 196, TBY + 4);

    // ---- the terminal ----
    const cmdAt = pressAt + 0.25;
    const cmd = 'dbt parse';
    let tb = `<div class="abs mono" style="left:26px;top:18px;font-size:23px;white-space:nowrap"><span style="color:var(--green)">${R.repo}</span><span style="color:var(--text-2)"> $ </span>${ran ? typed(cmd, t, cmdAt, 20) : ''}${t < manAt - 0.2 ? caret(t, cmdAt + cmd.length / 20) : ''}</div>`;
    if (t >= manAt - 0.6) tb += `<div class="abs mono" style="left:26px;top:58px;font-size:20px;color:var(--text-2);white-space:nowrap;${appear(t, manAt - 0.6, { dy: 0 })}">Running with dbt=1.9.4</div>`;
    if (t >= manAt - 0.2) tb += `<div class="abs mono" style="left:26px;top:90px;font-size:20px;color:var(--text-2);white-space:nowrap;${appear(t, manAt - 0.2, { dy: 0 })}">Registered adapter: snowflake=1.9.0</div>`;
    html += card({
      x: X, y: TY, w: W, h: TH, tabs: [{ label: 'Terminal', on: true, icon: `<span style="color:var(--text-2)">${ICON.terminal({ size: 22 })}</span>` }],
      crumb: 'Run dbt parse', headStyle: 'font-size:21px;height:52px', body: tb, style: appear(t, pressAt, { dy: 20, dur: 0.35 }),
    });

    // ---- target/manifest.json ----
    if (t >= manAt - 0.1) {
      const hot = easeOut(seg(t, everyAt, everyAt + 0.3));
      const ml = MANIFEST.map((l, i) => {
        const isModel = /"model\./.test(l);
        const bg = isModel && hot > 0 ? `background:rgba(34,197,94,${(0.14 * hot).toFixed(3)});box-shadow:inset 4px 0 0 rgba(34,197,94,${hot.toFixed(3)});` : '';
        return `<div style="height:33px;padding-left:10px;white-space:pre;overflow:hidden;text-overflow:ellipsis;${bg}">${jsonLine(l)}</div>`;
      }).join('');
      html += card({
        x: X, y: MY, w: W, h: 1088 - MY, tabs: [{ label: 'manifest.json', on: true, icon: `<span style="color:${FILE_COL.json}">${ICON.file({ size: 20 })}</span>` }],
        crumb: 'target · written by dbt parse', headStyle: 'font-size:21px;height:52px',
        body: `<div class="abs mono" style="left:10px;right:16px;top:14px;font-size:19px">${ml}</div>`,
        style: appear(t, manAt - 0.1, { dy: 20, dur: 0.35 }),
      });
      if (t >= everyAt) {
        html += `<div class="abs" style="right:${1080 - X - W + 20}px;top:${MY + 7}px;${appear(t, everyAt, { dy: 6 })}"><span class="pill" style="font-size:21px;padding:4px 14px;background:#13301f;color:var(--green);border:1px solid #1f5a35">every model, its columns and tests</span></div>`;
      }
    }

    // ---- if: the physical model, dbt first, more to follow ----
    if (t < runAt) {
      const gone = seg(t, runAt - 0.5, runAt - 0.1);   // p_parse's pause holds the panel past "more to follow"
      const PY = 660, PH = 1088 - PY;
      const tileBox = (inner, at, { dashed = false, w = 420 } = {}) => `<div style="flex:none;width:${w}px;height:220px;border-radius:16px;${dashed ? 'border:2px dashed #3a3d45;background:transparent;' : 'background:#13301f;border:2px solid #1f6b3a;'}display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;${appear(t, at, { dy: 12 })}">${inner}</div>`;
      const dbtTile = tileBox(`<span style="width:84px;height:84px;border-radius:18px;background:#f4f5f7;display:flex;align-items:center;justify-content:center"><img src="/social-video/player/assets/logos/dbt.svg" width="60" height="60" style="display:block"></span>
          <span style="font-size:30px;font-weight:800">dbt</span><span class="mono" style="font-size:19px;color:var(--text-2)">manifest.json · catalog.json</span>`, dbtAt);
      const moreTile = tileBox(`<span style="width:84px;height:84px;border-radius:18px;border:2px dashed #4a4e53;display:flex;align-items:center;justify-content:center;color:var(--text-3)">${ICON.plus({ size: 36 })}</span>
          <span style="font-size:28px;font-weight:700;color:var(--text-2)">more to follow</span>`, moreAt - 0.1, { dashed: true });
      html += `<div class="abs" style="left:${X}px;top:${PY}px;width:${W}px;height:${PH}px;border-radius:18px;background:var(--card);border:1px solid var(--card-border);box-shadow:0 24px 60px #000a;${appearFade(t, dbtAt - 0.3, 1 - gone, { dy: 16 })}">
        <div style="padding:22px 28px 0;display:flex;align-items:center;gap:14px;white-space:nowrap"><span style="font-size:21px;font-weight:800;letter-spacing:.08em;color:var(--green)">PHYSICAL MODEL</span>
          ${t >= physAt - 0.1 ? `<span style="font-size:22px;color:var(--text-2);${appear(t, physAt - 0.1, { dy: 0, dx: -8 })}">compared with your design</span>` : ''}</div>
        <div style="position:absolute;left:28px;right:28px;top:96px;display:flex;gap:28px;justify-content:center">${dbtTile}${moreTile}</div>
        ${t >= firstAt - 0.1 ? `<div class="abs" style="left:0;right:0;bottom:30px;display:flex;justify-content:center;${appear(t, firstAt - 0.1, { dy: 8 })}"><span class="pill" style="font-size:22px;padding:6px 18px;background:#13301f;color:var(--green);border:1px solid #1f5a35">${ICON.check({ size: 18 })}dbt first</span></div>` : ''}
      </div>`;
    }

    // The pointer onto Run dbt parse. It appears only once the PHYSICAL MODEL panel has gone
    // (gone ends at runAt - 0.1), and from above the panel's box, so it never crosses the
    // "more to follow" tile.
    const bx = X + W - 230, by = CY + 64 + 150 + 44;
    const ptrFrom = runAt - 0.4;
    if (t >= ptrFrom && t < pressAt + 1.0) {
      const pt = path(t, [{ t: ptrFrom, x: 990, y: 612 }, { t: pressAt - 0.02, x: bx, y: by }, { t: pressAt + 0.4, x: bx, y: by }, { t: pressAt + 1.0, x: bx - 120, y: by + 240 }]);
      const op = Math.min(seg(t, ptrFrom, ptrFrom + 0.25), 1 - seg(t, pressAt + 0.5, pressAt + 1.0));
      html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, t >= pressAt ? seg(t, pressAt, pressAt + 0.35) : 0)}</div>`;
    }
    return html;
  },
};
