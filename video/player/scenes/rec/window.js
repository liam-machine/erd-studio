// A recorded scene's frame: the bezel the real VS Code footage plays in (record/composite.mjs lays
// build/recording.mkv over the timeline's `recording.inset`, exactly inside this bezel), plus
// optional claim pills right of the headline (`props.claims`: [label, beat, seconds after it]).
// The footage itself is never drawn here: until composite runs, the inset is VS Code's own
// editor background.
import { appear, ICON } from '../../lib.js';

export const BEZEL = 6;

export default {
  render(t, { beats, scene }) {
    const inset = globalThis.TIMELINE?.recording?.inset ?? { x: 96, y: 240, w: 1728, h: 720 };
    const b = BEZEL;
    const win = `<div class="abs" style="left:${inset.x - b}px;top:${inset.y - b}px;width:${inset.w + 2 * b}px;height:${inset.h + 2 * b}px;border-radius:14px;background:#2b2d33;box-shadow:0 0 0 1px #3a3d44,0 30px 80px rgba(0,0,0,.55)"></div>
      <div class="abs" style="left:${inset.x}px;top:${inset.y}px;width:${inset.w}px;height:${inset.h}px;background:#1f1f1f"></div>`;
    const claims = (scene.props?.claims ?? []).map(([label, beat, offset]) =>
      `<span class="pill" style="font-size:26px;padding:12px 24px;background:#13301f;border:2px solid #1f6b3a;color:#dff7e8;${appear(t, beats[beat].t + offset, { dy: 10 })}"><span style="color:var(--green);display:flex">${ICON.check({ size: 24 })}</span>${label}</span>`).join('');
    const pills = claims ? `<div class="abs" style="right:96px;top:150px;display:flex;gap:16px">${claims}</div>` : '';
    return win + pills;
  },
};
