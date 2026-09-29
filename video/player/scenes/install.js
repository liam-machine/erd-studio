// 2 · "Install ERD Studio, and open your dbt project. / The Get started guide opens by itself."
// One VS Code window: the Extensions view with ERD Studio's listing (the pointer clicks Install
// on "Install ERD Studio", and its icon joins the activity bar); on "…open your dbt project" the
// side bar becomes the Explorer of the jaffle-shop project with dbt_project.yml lit; on `guide`
// the Welcome editor slides in with the real walkthrough, "Open your dbt project" ticked and
// "Draw your dbt project — no AI needed" open as the next step. The draw scene continues from
// this exact frame.
import { appear, appIcon, easeOut, ICON, path, pointer, seg, spinner } from '../lib.js';
import { ACT, BODY, EXTENSION, SIDE, activityBar, editorWindow, explorerSide, walkthrough } from '../editor.js';

const ED = ACT + SIDE;

export default {
  render(t, { beats }) {
    const I = beats.install.t, G = beats.guide.t;
    // i_install: "Install ERD Studio,"(+0.0–1.5) "and open your dbt project."(+1.8–3.8)
    const click = I + 0.95;               // the pointer clicks Install on "…ERD Studio"
    const installed = click + 0.55;       // "Installing" spinner, then "Installed"
    const openAt = I + 2.0;               // "…and open your dbt project"
    const ymlAt = openAt + 0.7;           // dbt_project.yml lights on "…dbt project"
    // i_guide: "The Get started guide"(+0.0–1.1) "opens by itself."(+1.1–1.96)
    const glowAt = G + 1.1;

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
      <div class="abs" style="left:40px;top:180px;width:1000px;font-size:25px;line-height:36px;color:var(--text-2)">${EXTENSION.description}</div>
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
        <div class="abs" style="left:92px;top:172px;width:290px;font-size:20px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${EXTENSION.description}</div>
        <div class="abs" style="left:92px;top:204px;font-size:20px;color:var(--text-2);white-space:nowrap">${EXTENSION.publisher}</div>
      </div>`;
    }
    if (sw > 0) body += explorerSide({ hot: easeOut(seg(t, ymlAt, ymlAt + 0.35)), op: sw });

    // ---- the Welcome editor: the walkthrough slides in over the editor area ----
    if (t >= G) {
      const p = easeOut(seg(t, G, G + 0.45));
      const glow = easeOut(seg(t, glowAt, glowAt + 0.4));
      body += `<div class="abs" style="left:${ED}px;top:0;right:0;bottom:0;opacity:${p.toFixed(3)};transform:translateX(${(80 * (1 - p)).toFixed(1)}px)">${walkthrough({ glow })}</div>`;
    }

    body += activityBar(t < openAt ? 'ext' : 'files', { erd: t >= installed, erdOp: easeOut(seg(t, installed, installed + 0.4)) });

    const tabs = [{ label: 'Extension: ERD Studio', on: t < G }];
    if (t >= G) tabs.push({ label: 'Welcome', on: true });
    let html = editorWindow({ tabs, body, style: appear(t, 0, { dy: 16 }) });

    // ---- pointer: in, clicks Install, fades on the swap ----
    const bcx = BODY.x + btn.x + btn.w / 2, bcy = BODY.y + btn.y + btn.h / 2;
    if (t < installed + 0.3) {
      const pt = path(t, [{ t: I - 0.1, x: 1500, y: 880 }, { t: click - 0.1, x: bcx, y: bcy }]);
      const op = Math.min(seg(t, I - 0.2, I + 0.1), 1 - seg(t, installed, installed + 0.3));
      if (op > 0) html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, seg(t, click, click + 0.4))}</div>`;
    }
    return html;
  },
};
