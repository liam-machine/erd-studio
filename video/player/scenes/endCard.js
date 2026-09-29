// 9 · End card: icon, name, the promise, the three steps as chips, "free, source on GitHub" and where
// to find it. Everything is on screen within ~1 s so the poster (end-card start + 1.5 s) is complete.
import { appear, appIcon, ICON } from '../lib.js';
import { EXTENSION, WALKTHROUGH } from '../editor.js';

// The chips name the real steps: the extension, the walkthrough's "Open your dbt project" and
// the Draw from dbt button.
export const STEPS = ['Install ERD Studio', 'Open your dbt project', 'Draw from dbt'];

export default {
  render(t) {
    const chip = (label, green, at) => `<span class="pill" style="background:${green ? '#13301f' : '#1c1e23'};border:2px solid ${green ? '#1f6b3a' : '#34363d'};color:${green ? 'var(--green)' : 'var(--text)'};font-size:30px;padding:16px 28px;border-radius:16px;${appear(t, at, { dy: 10 })}">${green ? ICON.check({ size: 26 }) : ''}${label}</span>`;
    const arrow = (at) => `<span style="color:var(--text-3);${appear(t, at, { dy: 0 })}">${ICON.arrow({ size: 32 })}</span>`;
    const [a, b, c] = STEPS;
    return `
      <div class="abs" style="left:0;right:0;top:150px;display:flex;justify-content:center;${appear(t, 0.05, { dy: 16 })}">${appIcon(176)}</div>
      <div class="abs" style="left:0;right:0;top:362px;text-align:center;font-size:104px;font-weight:800;letter-spacing:-.035em;${appear(t, 0.15, { dy: 16 })}">${EXTENSION.name}</div>
      <div class="abs" style="left:0;right:0;top:492px;text-align:center;font-size:42px;font-weight:700;letter-spacing:-.01em;color:var(--text);${appear(t, 0.3)}">Your dbt project, <span style="color:var(--text-2)">drawn in a minute.</span></div>
      <div class="abs" style="left:0;right:0;top:600px;display:flex;justify-content:center;align-items:center;gap:22px">
        ${chip(a, false, 0.45)}${arrow(0.5)}${chip(b, false, 0.55)}${arrow(0.6)}${chip(c, true, 0.65)}</div>
      <div class="abs" style="left:0;right:0;top:744px;text-align:center;font-size:32px;font-weight:600;${appear(t, 0.8)}"><span style="color:var(--green);font-weight:700">Free</span><span style="color:var(--text-2)"> · source on GitHub</span><span style="color:var(--text-2)"> · VS Code extension · no AI needed</span></div>
      <div class="abs" style="left:0;right:0;top:808px;text-align:center;font-size:26px;color:var(--text-2);${appear(t, 0.9)}">Search the Extensions view for <span style="color:var(--text);font-weight:600">${EXTENSION.name}</span>, then follow <span style="color:var(--text);font-weight:600">${WALKTHROUGH.title}</span></div>`;
  },
};
