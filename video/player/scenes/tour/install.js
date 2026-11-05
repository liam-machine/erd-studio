// 2 · "Install ERD Studio, open your folder, and click its icon." One VS Code window: the
// Extensions view with ERD Studio's listing (the pointer clicks Install on "Install ERD Studio",
// and its icon joins the activity bar); on "…open your folder" the side bar becomes the Explorer of
// a plain folder (no dbt_project.yml). On "…click its icon" the pointer clicks the ERD Studio
// icon: the side bar shows the
// Diagrams view's start entry for a folder with nothing to import ("No diagrams yet.", New
// Diagram…, "Or: More ways to start…"), and the first visit's automatic draft, the coffee-shop
// example, opens in the editor (src/services/draftTriggers.ts autoDraftDue: a blank folder, the
// first time on this machine), its primary button New Diagram… too. The walkthrough does not
// open by itself in a folder: the draft takes its place. The newDiagram scene continues from this
// exact frame. Shared by both cuts.
import { appear, appIcon, easeOut, ICON, path, pointer, seg, spinner } from '../../lib.js';
import { ACT, ACT_Y, BODY, ED, EXAMPLE_DRAFT, EXTENSION, PLAIN_EXPLORER, SIDE, activityBar, descriptionWithoutDbt, draftPage, editorWindow, erdSide, explorerSide } from '../../editor.js';

/** The frame the newDiagram scene starts from (and draws itself, with the pointer on top). */
export function installedWindow({ startGlow = 0, startPress = 0, draftOp = 1, sideOp = 1, tabs = null } = {}) {
  let body = '';
  const side = erdSide({ startGlow, startPress, op: sideOp });
  body += draftPage(EXAMPLE_DRAFT, { op: draftOp }).html;
  body += side.html;
  body += activityBar('erd');
  const html = editorWindow({ tabs: tabs ?? [{ label: 'Extension: ERD Studio' }, { label: EXAMPLE_DRAFT.tab, on: true }], crumb: PLAIN_EXPLORER.root.toLowerCase(), body });
  return { html, geo: side.geo };
}

export default {
  render(t, { beats }) {
    const description = descriptionWithoutDbt();
    const I = beats.install.t;
    // i_install: "Install ERD Studio,"(+0.0–1.5) "open your folder,"(+1.8–2.6) "and click its icon."(+2.8–3.76)
    const click = I + 0.95;               // the pointer clicks Install on "…ERD Studio"
    const installed = click + 0.5;        // "Installing" spinner, then "Installed"
    const openAt = I + 1.85;              // "…open your folder"
    const S = I + 2.6;                    // the pointer heads for the icon
    const iconClick = I + 3.35;           // "…its icon"
    const sideAt = iconClick + 0.15;
    const draftAt = iconClick + 0.6;      // the example draft opens by itself
    const glowAt = iconClick + 1.5;       // then the start entry's New Diagram… lights

    // ---- after the icon click: ERD Studio's side bar and the example draft ----
    if (t >= sideAt) {
      const { html } = installedWindow({
        startGlow: easeOut(seg(t, glowAt, glowAt + 0.4)),
        draftOp: easeOut(seg(t, draftAt, draftAt + 0.45)),
        sideOp: easeOut(seg(t, sideAt, sideAt + 0.25)),
        tabs: t >= draftAt ? null : [{ label: 'Extension: ERD Studio', on: true }],
      });
      let out = html;
      if (t < sideAt + 0.6) {
        const ic = { x: BODY.x + ACT / 2, y: BODY.y + ACT_Y.erd + 24 };
        const op = 1 - seg(t, sideAt + 0.1, sideAt + 0.5);
        out += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(ic.x, ic.y, seg(t, iconClick, iconClick + 0.4))}</div>`;
      }
      return out;
    }

    let body = '';
    // ---- editor: the extension's page ----
    const btn = { x: ED + 40, y: 292, w: 180, h: 58 };
    let b;
    if (t < click + 0.05) b = `<div class="abs" style="left:${btn.x}px;top:${btn.y}px;width:${btn.w}px;height:${btn.h}px;border-radius:6px;background:#0e639c;color:#fff;font-size:25px;font-weight:600;display:flex;align-items:center;justify-content:center">Install</div>`;
    else if (t < installed) b = `<div class="abs" style="left:${btn.x}px;top:${btn.y}px;width:${btn.w + 50}px;height:${btn.h}px;border-radius:6px;background:#0b4f7d;color:#cfe3ff;font-size:25px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:12px">${spinner(t, 26, '#cfe3ff')}Installing</div>`;
    else b = `<div class="abs" style="left:${btn.x}px;top:${btn.y}px;height:${btn.h}px;padding:0 24px 0 14px;border-radius:999px;background:#13301f;border:2px solid var(--green);color:#dff7e8;font-size:25px;font-weight:700;display:flex;align-items:center;gap:12px;white-space:nowrap;${appear(t, installed, { dy: 0, dur: 0.25 })}"><span class="tick tick--ok">${ICON.check({ size: 22 })}</span>Installed</div>`;
    const edOp = 1 - 0.5 * easeOut(seg(t, openAt, openAt + 0.4));
    body += `<div class="abs" style="left:${ED}px;top:0;right:0;bottom:0;opacity:${edOp.toFixed(3)}">
      <div class="abs" style="left:40px;top:36px">${appIcon(112, 'box-shadow:none')}</div>
      <div class="abs" style="left:176px;top:42px;font-size:42px;font-weight:800;letter-spacing:-.01em;white-space:nowrap">${EXTENSION.name}</div>
      <div class="abs" style="left:176px;top:100px;font-size:24px;color:#3794ff;white-space:nowrap">${EXTENSION.publisher}</div>
      <div class="abs" style="left:40px;top:180px;width:1100px;font-size:25px;line-height:36px;color:var(--text-2)">${description}</div>
      <div class="abs" style="left:40px;top:400px;right:40px;height:48px;display:flex;gap:30px;border-bottom:1px solid var(--card-border);font-size:22px;font-weight:600;white-space:nowrap">
        <span style="color:var(--text);box-shadow:inset 0 -3px 0 #3794ff;padding-top:6px">Details</span><span style="color:var(--text-3);padding-top:6px">Features</span><span style="color:var(--text-3);padding-top:6px">Changelog</span></div>
    </div>`;
    body += `<div class="abs" style="left:0;top:0;right:0;bottom:0;opacity:${edOp.toFixed(3)}">${b}</div>`;

    // ---- side bar: Extensions, then (sequentially) the Explorer ----
    const extOut = seg(t, openAt, openAt + 0.15);
    const sw = easeOut(seg(t, openAt + 0.15, openAt + 0.4));
    body += `<div class="abs" style="left:${ACT}px;top:0;width:${SIDE}px;bottom:0;background:#16181b;border-right:1px solid var(--card-border)"></div>`;
    if (extOut < 1) {
      body += `<div class="abs" style="left:${ACT}px;top:0;width:${SIDE}px;bottom:0;opacity:${(1 - extOut).toFixed(3)}">
        <div class="abs" style="left:24px;top:20px;font-size:20px;font-weight:700;letter-spacing:.08em;color:var(--text-2)">EXTENSIONS</div>
        <div class="abs" style="left:18px;top:60px;width:364px;height:50px;border-radius:5px;background:#202126;border:2px solid #0e639c;display:flex;align-items:center;padding-left:16px;font-size:23px">ERD Studio</div>
        <div class="abs" style="left:0;top:128px;width:${SIDE}px;height:112px;background:#04395e88"></div>
        <div class="abs" style="left:18px;top:146px">${appIcon(58, 'box-shadow:none')}</div>
        <div class="abs" style="left:92px;top:138px;font-size:24px;font-weight:700;white-space:nowrap">${EXTENSION.name}</div>
        <div class="abs" style="left:92px;top:172px;width:290px;font-size:20px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${description}</div>
        <div class="abs" style="left:92px;top:204px;font-size:20px;color:var(--text-2);white-space:nowrap">${EXTENSION.publisher}</div>
      </div>`;
    }
    if (sw > 0) body += explorerSide({ op: sw, tree: PLAIN_EXPLORER });

    body += activityBar(t < openAt ? 'ext' : 'files', { erd: t >= installed, erdOp: easeOut(seg(t, installed, installed + 0.4)) });

    let html = editorWindow({ tabs: [{ label: 'Extension: ERD Studio', on: true }], body, style: appear(t, 0, { dy: 16 }), crumb: PLAIN_EXPLORER.root.toLowerCase() });

    // ---- pointer: in, clicks Install, rests, then onto the ERD Studio icon ----
    const bcx = BODY.x + btn.x + btn.w / 2, bcy = BODY.y + btn.y + btn.h / 2;
    const ic = { x: BODY.x + ACT / 2, y: BODY.y + ACT_Y.erd + 24 };
    const pt = path(t, [
      { t: I - 0.1, x: 1500, y: 880 }, { t: click - 0.1, x: bcx, y: bcy },
      { t: installed + 0.25, x: bcx, y: bcy }, { t: iconClick - 0.1, ...ic },
    ]);
    const op = seg(t, I - 0.2, I + 0.1);
    if (op > 0) html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, t < S ? seg(t, click, click + 0.4) : seg(t, iconClick, iconClick + 0.4))}</div>`;
    return html;
  },
};
