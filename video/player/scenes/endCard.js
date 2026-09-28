// 11 · End card: icon, name, the flow in four chips, "free & open source", the assistants it
// works with and where to rewatch. Everything is on screen within ~1 s so the poster
// (end-card start + 1.5 s) is complete.
import { appear, appIcon, ICON } from '../lib.js';

export default {
  render(t) {
    const chip = (label, green, at) => `<span class="pill" style="background:${green ? '#13301f' : '#1c1e23'};border:2px solid ${green ? '#1f6b3a' : '#34363d'};color:${green ? 'var(--green)' : 'var(--text)'};font-size:28px;padding:14px 26px;border-radius:16px;${appear(t, at, { dy: 10 })}">${green ? ICON.check({ size: 24 }) : ''}${label}</span>`;
    const arrow = (at) => `<span style="color:var(--text-3);${appear(t, at, { dy: 0 })}">${ICON.arrow({ size: 30 })}</span>`;
    return `
      <div class="abs" style="left:0;right:0;top:160px;display:flex;justify-content:center;${appear(t, 0.05, { dy: 16 })}">${appIcon(176)}</div>
      <div class="abs" style="left:0;right:0;top:372px;text-align:center;font-size:104px;font-weight:800;letter-spacing:-.035em;${appear(t, 0.15, { dy: 16 })}">ERD Studio</div>
      <div class="abs" style="left:0;right:0;top:502px;text-align:center;font-size:40px;font-weight:700;letter-spacing:-.01em;color:var(--text);${appear(t, 0.3)}">Your dbt project, <span style="color:var(--text-2)">as a data model you can see.</span></div>
      <div class="abs" style="left:0;right:0;top:606px;display:flex;justify-content:center;align-items:center;gap:20px">
        ${chip('dbt project', false, 0.45)}${arrow(0.5)}${chip('<span class="mono" style="font-size:26px">/erd-studio-setup</span>', false, 0.55)}${arrow(0.6)}${chip('logical model', false, 0.65)}${arrow(0.7)}${chip('diff clean', true, 0.75)}</div>
      <div class="abs" style="left:0;right:0;top:744px;text-align:center;font-size:32px;font-weight:600;${appear(t, 0.85)}"><span style="color:var(--green);font-weight:700">Free &amp; open source</span><span style="color:var(--text-2)"> · VS Code extension</span></div>
      <div class="abs" style="left:0;right:0;top:806px;text-align:center;font-size:25px;color:var(--text-2);${appear(t, 0.9)}">Works with <span style="color:var(--text)">Claude Code, GitHub Copilot, Codex, Gemini CLI</span> and <span style="color:var(--text)">Cursor</span></div>
      <div class="abs" style="left:0;right:0;top:868px;display:flex;justify-content:center;align-items:center;gap:12px;font-size:26px;color:var(--text-2);white-space:nowrap;${appear(t, 0.95)}">Rewatch: ERD Studio sidebar <span style="color:var(--text);display:inline-flex">${ICON.playCircle({ size: 30 })}</span></div>`;
  },
};
