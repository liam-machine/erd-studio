// Frame driver. window.render(t) paints the whole frame for time t (seconds) and nothing else
// mutates the DOM, so any frame can be rendered at any time in any order.
//
// Persistent chrome (kicker, chapter bar) lives here; each scene module only returns the HTML
// for its own content: `render(localT, ctx) -> string`, ctx = { beats, dur, t }.
import { clamp, seg, easeOut, lerp, mix, ACCENT } from './lib.js';

const MODULES = ['intro', 'twoWays', 'helper', 'claude', 'checks', 'noDbt', 'areas', 'modelling', 'writes', 'verify', 'explore', 'sample', 'endCard'];
const scenesByName = Object.fromEntries(
  await Promise.all(MODULES.map(async (m) => [m, (await import(`./scenes/${m}.js`)).default])),
);

const params = new URLSearchParams(location.search);
const timeline = await (await fetch('/video/build/timeline.json', { cache: 'no-store' })).json();
window.TIMELINE = timeline;

const $ = (id) => document.getElementById(id);
const els = { kicker: $('kicker'), headline: $('headline'), stage: $('stage'), chapters: $('chapters'), hud: $('hud') };

// Chapter spans: first scene start -> last scene end, per chapter number.
const spans = {};
// Scenes after the last chaptered one (the sample-project scene, the end card) show every
// chapter done; scenes before the first one (intro, two-ways) show none.
const lastChaptered = timeline.scenes.findLastIndex((s) => s.chapter);
for (const sc of timeline.scenes) {
  if (!sc.chapter) continue;
  const s = (spans[sc.chapter] ??= { start: sc.start, end: sc.start + sc.dur });
  s.end = sc.start + sc.dur;
}

function headlineHtml(lines, accent) {
  const hl = (s) => s.replace(/\{([^}]+)\}/g, `<span style="color:${accent}">$1</span>`);
  return `<div class="headline__l1">${hl(lines[0])}</div><div class="headline__l2">${hl(lines[1] ?? '')}</div>`;
}

let last = { stage: null, headline: null, chapters: null, kicker: null };
const put = (key, el, html) => { if (last[key] !== html) { el.innerHTML = html; last[key] = html; } };

window.render = function render(t) {
  const scs = timeline.scenes;
  let i = scs.findIndex((s) => t < s.start + s.dur);
  if (i < 0) i = scs.length - 1;
  const sc = scs[i];
  const lt = t - sc.start;
  const fade = timeline.fade;
  const pin = easeOut(seg(lt, 0, fade));
  const pout = i === scs.length - 1 ? 0 : seg(lt, sc.dur - fade, sc.dur);
  const op = pin * (1 - pout);
  const rise = lerp(14, 0, pin);

  // Accent (with an optional change on a beat, cross-faded over 0.4 s).
  let accent = ACCENT[sc.accent];
  if (sc.accentAfter) {
    const b = sc.beats[sc.accentAfter.beat];
    const at = b.t + (sc.accentAfter.offset ?? 0);
    accent = mix(accent, ACCENT[sc.accentAfter.accent], seg(lt, at, at + 0.4));
  }

  const isEnd = sc.module === 'endCard';
  const chromeOp = isEnd ? 1 - seg(lt, 0, 0.5) : 1;
  const kick = `ERD STUDIO${sc.chapter ? ` · <b>${sc.chapter} / ${timeline.chapters.length}</b>` : ''}`;
  put('kicker', els.kicker, kick);
  els.kicker.style.opacity = chromeOp.toFixed(3);

  put('headline', els.headline, sc.headline ? headlineHtml(sc.headline, accent) : '');
  els.headline.style.opacity = op.toFixed(3);
  els.headline.style.transform = `translateY(${rise.toFixed(1)}px)`;

  const html = scenesByName[sc.module].render(lt, { beats: sc.beats, dur: sc.dur, t, scene: sc });
  put('stage', els.stage, html);
  els.stage.style.opacity = op.toFixed(3);
  els.stage.style.transform = `translateY(${rise.toFixed(1)}px)`;

  // Chapter bar: done chapters full, the current one fills across its scenes, intro scenes show
  // none, outro scenes (after the last chapter) show all done.
  const current = sc.chapter;
  const allDone = isEnd || (!current && i > lastChaptered);
  const bars = timeline.chapters.map((label, k) => {
    const n = k + 1;
    const span = spans[n];
    const fill = allDone ? 1 : !current ? 0 : n < current ? 1 : n > current ? 0 : seg(t, span.start, span.end);
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
if (params.has('t')) window.render(parseFloat(params.get('t')));
else window.render(0);

if (params.has('preview')) {
  els.hud.hidden = false;
  const audio = new Audio('/video/build/narration.wav');
  const loop = () => { window.render(audio.currentTime); requestAnimationFrame(loop); };
  document.body.addEventListener('click', () => (audio.paused ? audio.play() : audio.pause()));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') audio.currentTime += 5;
    if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
  });
  requestAnimationFrame(loop);
}
window.__ready = true;
