// Frame driver. window.render(t) paints the whole frame for time t (seconds) and nothing else
// mutates the DOM, so any frame can be rendered at any time in any order.
//
// Portrait 1080x1350 (LinkedIn 4:5). Persistent chrome — kicker, headline, burned-in captions
// and the chapter bar — lives here; each scene module only returns the HTML for its own
// content inside FRAME.stage: `render(localT, ctx) -> string`, ctx = { beats, dur, t, scene }.
import { seg, easeOut, lerp, mix, ACCENT, FRAME } from './lib.js';

const MODULES = ['hook', 'problem', 'ai', 'flip', 'yaml', 'canvas', 'physical', 'diff', 'pr', 'business', 'noDbt', 'stars', 'endCard'];
const scenesByName = Object.fromEntries(
  await Promise.all(MODULES.map(async (m) => [m, (await import(`./scenes/${m}.js`)).default])),
);

const params = new URLSearchParams(location.search);
const timeline = await (await fetch('/social-video/build/timeline.json', { cache: 'no-store' })).json();
window.TIMELINE = timeline;

const $ = (id) => document.getElementById(id);
const els = { kicker: $('kicker'), headline: $('headline'), stage: $('stage'), caption: $('caption'), chapters: $('chapters'), hud: $('hud') };

// Chapter spans: first scene start -> last scene end, per chapter number.
const spans = {};
for (const sc of timeline.scenes) {
  if (!sc.chapter) continue;
  const s = (spans[sc.chapter] ??= { start: sc.start, end: sc.start + sc.dur });
  s.end = sc.start + sc.dur;
}

const hl = (s, accent) => s.replace(/\{([^}]+)\}/g, `<span style="color:${accent}">$1</span>`);
function headlineHtml(lines, accent) {
  return `<div class="headline__l1">${hl(lines[0], accent)}</div><div class="headline__l2">${hl(lines[1] ?? '', accent)}</div>`;
}

let last = {};
const put = (key, el, html) => { if (last[key] !== html) { el.innerHTML = html; last[key] = html; return true; } return false; };

// A headline line wider than the frame is scaled down to fit (measured once per headline;
// deterministic because every font is loaded before the first frame).
function fitHeadline() {
  for (const line of els.headline.children) {
    line.style.fontSize = '';
    const over = line.scrollWidth / FRAME.textW;
    if (over > 1) line.style.fontSize = `${(FRAME.headlinePx / over).toFixed(1)}px`;
  }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Burned-in caption chunk for time t (timeline.chunks, absolute seconds). */
function captionHtml(t, accent) {
  const ch = timeline.chunks.find((c) => t >= c.t && t < c.hold);
  if (!ch) return { html: '', op: 0, pop: 1 };
  const words = ch.words.map((w) => (w.acc ? `<span style="color:${accent}">${esc(w.w)}</span>` : esc(w.w))).join(' ');
  const pin = easeOut(seg(t, ch.t, ch.t + 0.12));
  const out = 1 - seg(t, ch.hold - 0.12, ch.hold);
  return { html: `<span class="caption__box">${words}</span>`, op: pin * out, pop: lerp(0.94, 1, pin) };
}

window.render = function render(t) {
  const scs = timeline.scenes;
  let i = scs.findIndex((s) => t < s.start + s.dur);
  if (i < 0) i = scs.length - 1;
  const sc = scs[i];
  const lt = t - sc.start;
  const fade = timeline.fade;
  // The very first frame is fully drawn: a feed shows frame 0 before anyone presses play.
  const pin = i === 0 ? 1 : easeOut(seg(lt, 0, fade));
  const pout = i === scs.length - 1 ? 0 : seg(lt, sc.dur - fade, sc.dur);
  const op = pin * (1 - pout);
  const rise = lerp(14, 0, pin);

  let accent = ACCENT[sc.accent];
  if (sc.accentAfter) {
    const b = sc.beats[sc.accentAfter.beat];
    const at = b.t + (sc.accentAfter.offset ?? 0);
    accent = mix(accent, ACCENT[sc.accentAfter.accent], seg(lt, at, at + 0.4));
  }

  const isEnd = sc.module === 'endCard';
  const chromeOp = isEnd ? 1 - seg(lt, 0, 0.5) : 1;
  put('kicker', els.kicker, `ERD STUDIO${sc.chapter ? ` · <b>${timeline.chapters[sc.chapter - 1]}</b>` : ''}`);
  els.kicker.style.opacity = chromeOp.toFixed(3);

  if (put('headline', els.headline, sc.headline ? headlineHtml(sc.headline, accent) : '')) fitHeadline();
  els.headline.style.opacity = op.toFixed(3);
  els.headline.style.transform = `translateY(${rise.toFixed(1)}px)`;

  const html = scenesByName[sc.module].render(lt, { beats: sc.beats, dur: sc.dur, t, scene: sc });
  put('stage', els.stage, html);
  els.stage.style.opacity = op.toFixed(3);
  els.stage.style.transform = `translateY(${rise.toFixed(1)}px)`;

  const cap = captionHtml(t, accent);
  put('caption', els.caption, cap.html);
  els.caption.style.opacity = cap.op.toFixed(3);
  els.caption.style.transform = `scale(${cap.pop.toFixed(4)})`;

  // Chapter bar: done chapters full, the current one fills across its scenes, the hook shows none.
  const current = sc.chapter;
  const bars = timeline.chapters.map((label, k) => {
    const n = k + 1;
    const span = spans[n];
    const fill = isEnd ? 1 : !current ? (n === 1 && i > 0 ? 1 : 0) : n < current ? 1 : n > current ? 0 : seg(t, span.start, span.end);
    return `<div class="chapters__seg"><div class="chapters__bar"><i style="width:${(fill * 100).toFixed(2)}%"></i></div><div class="chapters__lbl${n === current ? ' chapters__lbl--on' : ''}">${label}</div></div>`;
  });
  put('chapters', els.chapters, bars.join(''));
  els.chapters.style.opacity = chromeOp.toFixed(3);

  if (els.hud) els.hud.textContent = `${t.toFixed(2)}s  ${sc.id} +${lt.toFixed(2)}`;
};

// ---- modes -------------------------------------------------------------------------------
//   (default)      capture: capture.mjs calls window.render(t) per frame
//   ?t=12.5        freeze on one frame (QA screenshots)
//   ?preview=1     play the narration and drive t from audio.currentTime (click to start)
//   ?guides=1      overlay the FRAME.stage box (layout checks)
if (params.has('t')) window.render(parseFloat(params.get('t')));
else window.render(0);

if (params.has('guides')) {
  const g = document.createElement('div');
  const s = FRAME.stage;
  g.style.cssText = `position:absolute;left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px;outline:2px dashed #f0f8;pointer-events:none;z-index:9`;
  document.body.appendChild(g);
}

if (params.has('preview')) {
  els.hud.hidden = false;
  const audio = new Audio('/social-video/build/narration.wav');
  const loop = () => { window.render(audio.currentTime); requestAnimationFrame(loop); };
  document.body.addEventListener('click', () => (audio.paused ? audio.play() : audio.pause()));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') audio.currentTime += 5;
    if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
  });
  requestAnimationFrame(loop);
}
window.__ready = true;
