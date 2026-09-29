// 8 · "No dbt project? Try the sample project." The walkthrough's "No dbt project? Try the
// sample" step, open with its real image; the pointer clicks its Try the sample project button
// and VS Code's modal confirm (SAMPLE_CONFIRM_MESSAGE, src/providers/GettingStartedPanel.ts)
// appears with Download. The last content scene, just before the end card.
import { easeOut, lerp, path, pointer, seg } from '../lib.js';
import { ACT, activityBar, editorWindow, walkButton, walkthrough } from '../editor.js';

// SAMPLE_CONFIRM_MESSAGE and SAMPLE_DOWNLOAD_ACTION (GettingStartedPanel.ts).
export const CONFIRM = "Download the ERD Studio sample project? It's a small dbt project with fake coffee-shop data from github.com/liam-machine/erd-studio-sample (about 1 MB). You'll choose where to save it.";
export const DOWNLOAD = 'Download';

const MODAL = { x: 420, y: 470, w: 1080 };
const infoIcon = () => '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M12 11v6" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.4" fill="currentColor" stroke="none"/></svg>';

export default {
  render(t, { beats }) {
    const S = beats.sample.t;
    // s_sample: "No dbt project?"(+0.0–1.0) "Try the sample project."(+1.2–3.15)
    const glowAt = S + 0.1;
    const clickAt = S + 2.0;
    const modalAt = clickAt + 0.3;

    let body = `<div class="abs" style="left:${ACT}px;top:0;right:0;bottom:0">${walkthrough({ open: 'sample', done: [], wide: true, glow: easeOut(seg(t, glowAt, glowAt + 0.4)), press: seg(t, clickAt, clickAt + 0.4) })}</div>`;
    body += activityBar('erd');
    let html = editorWindow({ tabs: [{ label: 'Welcome', on: true }], crumb: '', body });

    if (t >= modalAt) {
      const op = easeOut(seg(t, modalAt, modalAt + 0.3));
      html += `<div class="abs" style="left:96px;top:322px;width:1728px;height:600px;border-radius:20px;background:rgba(10,11,14,${(0.5 * op).toFixed(3)})"></div>
        <div class="vsc-modal" style="left:${MODAL.x}px;top:${MODAL.y}px;width:${MODAL.w}px;opacity:${op.toFixed(3)};transform:translateY(${lerp(10, 0, op).toFixed(1)}px)">
          <span style="flex:none;color:var(--blue)">${infoIcon()}</span>
          <div style="flex:1"><div class="vsc-modal__msg">${CONFIRM}</div>
            <div class="vsc-modal__actions"><span class="wp-btn">Cancel</span><span class="wp-btn wp-btn--primary">${DOWNLOAD}</span></div></div>
        </div>`;
    }

    const btn = walkButton({ wide: true, open: 'sample', left: ACT });
    if (t < modalAt + 0.4) {
      const pt = path(t, [{ t: S, x: 1100, y: 880 }, { t: clickAt - 0.1, x: btn.x, y: btn.y }]);
      const op = Math.min(seg(t, S - 0.1, S + 0.2), 1 - seg(t, modalAt, modalAt + 0.4));
      if (op > 0) html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, seg(t, clickAt, clickAt + 0.4))}</div>`;
    }
    return html;
  },
};
