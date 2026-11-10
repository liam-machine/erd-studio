// End card: the icon, the name, one line, and where to get it. Little to read, so it lands at once:
// everything is on screen within ~0.6 s. Shared by both cuts.
import { appear, appIcon, ICON } from '../../lib.js';
import { EXTENSION } from '../../editor.js';

/** The one line: what it is, in the hook's words (its headline is "Your data model, in your repo."). The `{…}` part is in the accent. */
export const LINE = 'Your data model, {in Git}.';
/** Where and on what terms: free to use, in VS Code (never a word about the Confluence app here). */
export const FREE = 'Free to use in VS Code';

export default {
  render(t) {
    const line = LINE.replace(/\{([^}]+)\}/, '<span style="color:var(--blue)">$1</span>');
    return `
      <div class="abs" style="left:0;right:0;top:196px;display:flex;justify-content:center;${appear(t, 0.05, { dy: 16 })}">${appIcon(168)}</div>
      <div class="abs" style="left:0;right:0;top:396px;text-align:center;font-size:112px;font-weight:800;letter-spacing:-.035em;${appear(t, 0.15, { dy: 16 })}">${EXTENSION.name}</div>
      <div class="abs" style="left:0;right:0;top:546px;text-align:center;font-size:56px;font-weight:700;letter-spacing:-.02em;color:var(--text);${appear(t, 0.3)}">${line}</div>
      <div class="abs" style="left:0;right:0;top:690px;display:flex;justify-content:center;${appear(t, 0.5)}">
        <span class="pill" style="font-size:28px;padding:12px 24px;gap:10px;background:var(--chip-green);border:2px solid var(--chip-green-border);color:var(--green);font-weight:700">${ICON.check({ size: 24 })}${FREE}</span></div>
      <div class="abs mono" style="left:0;right:0;top:784px;text-align:center;font-size:24px;color:var(--text-2);${appear(t, 0.6)}">${EXTENSION.id}</div>`;
  },
};
