#!/usr/bin/env node
// Lays the recorded footage into the rendered frame (npm run composite, after capture):
//
//   build/rec/<take>/ (record.mjs)  ─┐
//   build/timeline.json             ─┼→ build/recording.mkv  the footage on the video's clock, 30 fps
//   build/chrome.mkv (capture.mjs)  ─┴→ build/master.mkv     the footage over the frame, at recording.inset
//
// The screencast's JPEGs are full-range; they are converted to the limited range the rendered
// frame (and the shipped H.264) uses, so the two match and encode.sh's yuv420p check holds.
// Each recorded scene takes the frames its take filmed from that scene's start mark for exactly
// the scene's duration: at every 1/30 s the latest frame the compositor had painted by then (a
// still window sends no frames, so the last one holds). Where the footage jumps (a scene filmed
// out of order, another take) the two cross-fade over XFADE frames instead of cutting. The pointer
// is drawn here, from the path the driver logged (build/rec/<take>/pointer.json), on the video's
// own clock: the screencast's ~25 frames a second would make a filmed pointer judder. A
// `recording.zoom` punches in on part of the window (a panel whose text is small) from its beat
// to the scene's end. HTML scenes may sit between recorded ones (the AI change and the pull
// request, before the dbt beat): each run of recorded scenes (runsOf) is laid over the frame on its
// own and fades in and out with the frame's own fades (main.js), except into a scene that holds the
// window (holdsWindow: an HTML still of the footage's last frame, props.still), where it cuts with
// no fade. A cut without `recording` has nothing to composite:
// capture wrote its master.mkv already. A cut whose `recording.footage` names another cut (the
// logical cut: `default`) plays that cut's takes (its build/rec/), and only when each of its
// recorded scenes has the same length and beats there (checkFootage): the clicks were timed to them.
//
//   node record/composite.mjs            VARIANT picks the cut, as everywhere else
//   node record/composite.mjs --stills   (npm run still) writes the stills HTML scenes draw
//                                        (player/assets/still-<scene>.jpg/.json), then stops
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cutOf } from '../build-timeline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VARIANT = process.env.VARIANT ?? '';
const BUILD = join(HERE, '..', VARIANT ? `build-${VARIANT}` : 'build');
/** --stills: write the stills the HTML scenes draw (props.still), then stop. */
const STILLS = process.argv.includes('--stills');

/** Frames the footage cross-fades over where it jumps (1/3 s at 30 fps). Even: half each side of the cut. */
export const XFADE = 10;
/** A cut in the footage: consecutive scenes from different takes, or more than this far apart in one. */
const JUMP_S = 0.35;
/** The pointer image (driver.mjs POINTER: a 24 px arrow, its tip at 4,2), drawn PAD px in from its PNG's corner. */
const CURSOR = { size: 24, tip: { x: 4, y: 2 }, pad: 8 };

const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
const clip = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * A scene's clock: output (video) seconds → take seconds, from the scene's start. Without a
 * fast-forward they are the same. With one (`props.fastForward`), the take's [a, b] (marked by the
 * scene's ff.start() / ff.end(), the wait for Claude Code or dbt) plays in the video's [a, o], where
 * o is `until` ([beat, offset]) in the scene's own time, and after it the take runs on in real time.
 */
export function takeClock(ff) {
  if (!ff) return (u) => u;
  const { a, b, o } = ff;
  return (u) => (u <= a ? u : u >= o ? b + (u - o) : a + ((u - a) * (b - a)) / (o - a));
}

/** The VARIANT `recording.footage` names ('default' is the default cut, ''). */
export const footageVariant = (footage) => (footage === 'default' ? '' : footage);

/**
 * A cut that plays another cut's footage (`recording.footage`): every recorded scene of `tl` must be
 * in `src` (that cut's timeline) with the same length and every beat at the same time, because the
 * take's clicks were timed to those beats. Returns the mismatches (empty when the footage fits).
 */
export function checkFootage(tl, src) {
  const bad = [];
  const byId = Object.fromEntries(src.scenes.map((s) => [s.id, s]));
  for (const s of tl.scenes.filter((x) => x.module.startsWith('rec/'))) {
    const o = byId[s.id];
    if (!o || !o.module.startsWith('rec/')) { bad.push(`${s.id}: not a recorded scene of the footage's cut`); continue; }
    if (Math.abs(o.dur - s.dur) > 0.002) bad.push(`${s.id}: ${s.dur}s here, filmed for ${o.dur}s`);
    for (const [k, b] of Object.entries(s.beats)) {
      if (!o.beats[k]) bad.push(`${s.id}: beat ${k} is not in the footage's cut`);
      else if (Math.abs(o.beats[k].t - b.t) > 0.002) bad.push(`${s.id}: beat ${k} at ${b.t}s here, ${o.beats[k].t}s in the footage`);
    }
    for (const k of Object.keys(o.beats)) if (!s.beats[k]) bad.push(`${s.id}: the footage's beat ${k} is missing here`);
  }
  return bad;
}

/**
 * Where each recorded scene sits: in the timeline (start, dur) and in its take (name, t0). HTML
 * scenes may sit between two recorded ones (the AI change and the pull request, before the dbt
 * beat): the footage is hidden there (main() lays each run of recorded scenes over the frame on its
 * own, runsOf), and the recording's clock runs on through them.
 */
function layout(tl, takes) {
  const rec = tl.scenes.filter((s) => s.module.startsWith('rec/'));
  if (!rec.length) return null;
  const where = {};
  for (const [name, take] of Object.entries(takes)) for (const s of take.scenes) where[s.id] = { name, ...s };
  for (const s of rec) {
    if (!where[s.id]) throw new Error(`scene ${s.id} was never recorded: run \`node record/record.mjs\``);
    if (Math.abs(where[s.id].dur - s.dur) > 0.01) throw new Error(`scene ${s.id} was filmed for ${where[s.id].dur}s but the timeline gives it ${s.dur}s: record again`);
  }
  const start = rec[0].start;
  const end = rec.at(-1).start + rec.at(-1).dur;
  // into a still at the very end of the footage (the logical cut's aiRun → aiShow), two frames more of
  // the last one, so main() can run the footage on over the still: never a frame of the empty window
  const tail = holdsWindow(tl.scenes[tl.scenes.indexOf(rec.at(-1)) + 1]) ? 2 : 0;
  return { rec, where, start, end, n: Math.round((end - start) * tl.fps) + tail };
}

/**
 * The runs of consecutive recorded scenes, in seconds from the first one's start: [{ from, to,
 * before, after }], `before` / `after` the scenes either side of the run (null at the video's ends).
 * Each run is laid over the frame on its own, fading in and out with it, except next to a scene
 * that holds the window (holdsWindow): there it cuts, with no fade. Pure (exported for the test).
 */
export function runsOf(tl) {
  const rec = tl.scenes.filter((s) => s.module.startsWith('rec/'));
  if (!rec.length) return [];
  const start = rec[0].start;
  const runs = [];
  tl.scenes.forEach((s, i) => {
    if (!s.module.startsWith('rec/')) return;
    const prev = tl.scenes[i - 1] ?? null;
    const to = +(s.start + s.dur - start).toFixed(3), after = tl.scenes[i + 1] ?? null;
    if (prev && prev.module.startsWith('rec/')) Object.assign(runs.at(-1), { to, after });
    else runs.push({ from: +(s.start - start).toFixed(3), to, before: prev, after });
  });
  return runs;
}

/**
 * Whether a scene carries the window on from the recording: a recorded scene, or an HTML scene
 * that draws a still of the footage's last frame where the footage was (`props.still: <scene>`, the
 * AI change). The footage cuts to such a scene with no fade, and main.js keeps the window's frame
 * still across the change.
 */
export const holdsWindow = (sc) => !!sc && (sc.module.startsWith('rec/') || !!sc.props?.still);

/** The take frame painted by `at` in take `name` (binary search; frames are in time order). */
function frameAt(takes, name, at) {
  const list = takes[name].frames;
  let lo = 0, hi = list.length - 1, best = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].t <= at) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  return { take: name, file: list[best].f };
}

/**
 * For every output frame of the recorded span, the take frame to show: [{ take, file }], one per
 * 1/30 s; `cuts`, the output frames where the footage jumps (a new scene that does not follow on
 * from the one before in its take); and `segments`, the runs between cuts, each with XFADE / 2
 * frames more on either side (the outgoing scene filmed on, the incoming one from before its
 * mark) for the cross-fade. Pure (exported for the pipeline test): `takes` maps a take name to
 * { frames: [{ f, t }], scenes: [{ id, t0, dur }] }.
 */
export function framePlan(tl, takes) {
  const L = layout(tl, takes);
  if (!L) return { frames: [], end: 0, cuts: [], segments: [] };
  const { rec, where, start, end, n } = L;
  const fps = tl.fps;
  // A gap: HTML scenes between two recorded ones, where the footage is hidden. Its first half holds
  // the outgoing scene's last frame, its second the incoming scene's first, and the cut (with its
  // cross-fade) sits in the middle, out of sight.
  const gapAfter = (k) => k + 1 < rec.length && rec[k + 1].start - (rec[k].start + rec[k].dur) > 0.001;
  const sceneOf = (t) => {
    for (let k = 0; k < rec.length; k++) {
      const x = rec[k];
      if (t < x.start + x.dur) return { s: x };
      if (gapAfter(k) && t < rec[k + 1].start) return t < (x.start + x.dur + rec[k + 1].start) / 2 ? { s: x, hold: 'end' } : { s: rec[k + 1], hold: 'start' };
    }
    return { s: rec.at(-1), hold: 'end' };
  };
  const pick = (i, s, hold = null) => {
    const w = where[s.id];
    let u = start + (i + 0.5) / fps - s.start;
    if (hold === 'end') u = Math.min(u, s.dur - 0.5 / fps);
    if (hold === 'start') u = Math.max(u, 0);
    return frameAt(takes, w.name, w.t0 + takeClock(w.ff)(u));
  };
  const frames = [];
  for (let i = 0; i < n; i++) { const o = sceneOf(start + (i + 0.5) / fps); frames.push(pick(i, o.s, o.hold)); }
  // the cuts: where the next scene is not the take's next stretch of film, and in every gap
  const cuts = [];
  for (let k = 1; k < rec.length; k++) {
    const a = where[rec[k - 1].id], b = where[rec[k].id];
    if (gapAfter(k - 1)) cuts.push({ at: Math.round(((rec[k - 1].start + rec[k - 1].dur + rec[k].start) / 2 - start) * fps), before: rec[k - 1], after: rec[k], gap: true });
    else if (a.name !== b.name || Math.abs(b.t0 - (a.t0 + (a.filmed ?? a.dur))) > JUMP_S) cuts.push({ at: Math.round((rec[k].start - start) * fps), before: rec[k - 1], after: rec[k] });
  }
  const H = XFADE / 2;
  const segments = [];
  for (let k = 0; k <= cuts.length; k++) {
    const a = k === 0 ? 0 : cuts[k - 1].at, b = k === cuts.length ? n : cuts[k].at;
    const from = k === 0 ? 0 : a - H, to = k === cuts.length ? n : b + H;
    const list = [];
    for (let i = from; i < to; i++) {
      if (i < a) list.push(pick(i, cuts[k - 1].after, cuts[k - 1].gap ? 'start' : null));   // the incoming scene, filmed before its mark
      else if (i >= b) list.push(pick(i, cuts[k].before, cuts[k].gap ? 'end' : null));      // the outgoing scene, filmed on past its end
      else list.push(frames[i]);
    }
    segments.push({ from, to, frames: list });
  }
  return { frames, start, end, cuts, segments };
}

/**
 * The take frame a still scene draws (`props.still: <scene>`): the last frame that scene's footage
 * shows, so the cut from the footage to the still is invisible. Returns { take, file, at } (at: take seconds).
 */
export function stillFrame(tl, takes, sceneId) {
  const s = tl.scenes.find((x) => x.id === sceneId && x.module.startsWith('rec/'));
  if (!s) throw new Error(`props.still: ${sceneId} is not a recorded scene`);
  const [name, take] = Object.entries(takes).find(([, t]) => t.scenes.some((x) => x.id === sceneId)) ?? [];
  if (!take) throw new Error(`scene ${sceneId} was never recorded: run \`node record/record.mjs\``);
  const w = take.scenes.find((x) => x.id === sceneId);
  if (Math.abs(w.dur - s.dur) > 0.01) throw new Error(`scene ${sceneId} was filmed for ${w.dur}s but the timeline gives it ${s.dur}s: record again`);
  const at = w.t0 + takeClock(w.ff)(s.dur - 0.5 / tl.fps);
  return { ...frameAt(takes, name, at), at };
}

/** The pointer's position at take time T, from a driver trail (glides { s, d, x0, y0, x1, y1 }). */
export function pointerAt(trail, T) {
  let p = { x: trail[0]?.x0 ?? 0, y: trail[0]?.y0 ?? 0 };
  for (const g of trail) {
    if (g.s > T) break;
    const k = g.d > 0 ? ease(clip((T - g.s) / g.d, 0, 1)) : 1;
    p = { x: g.x0 + (g.x1 - g.x0) * k, y: g.y0 + (g.y1 - g.y0) * k };
  }
  return p;
}

/**
 * The pointer on the output clock (seconds from the recording's start), as terms an ffmpeg
 * expression sums: { at, x, y } where the pointer jumps (each scene starts where its take's pointer
 * was), and { s, d, from, to, dx, dy } for a glide, eased over [s, s + d] and held to [from, to]
 * (the part of it inside its scene). x(t) = Σ jumps' dx·[t ≥ at] + Σ glides' dx·(E(clamp(t)) − E(from)).
 */
export function pointerTerms(tl, takes, trails) {
  const L = layout(tl, takes);
  if (!L) return [];
  const { rec, where, start } = L;
  const terms = [];
  let cur = null;
  for (const s of rec) {
    const w = where[s.id];
    const trail = trails[w.name] ?? [];
    const o = s.start - start;            // the scene's start, on the output clock
    // the scene's stretches: real time, and (with a fast-forward) the sped-up wait, where the pointer
    // only jumps to where the take's pointer is at its end (it rests while Claude Code or dbt works)
    const pieces = !w.ff ? [{ u0: 0, u1: s.dur, T0: 0, real: true }]
      : [{ u0: 0, u1: w.ff.a, T0: 0, real: true }, { u0: w.ff.a, u1: w.ff.o, T0: w.ff.a, real: false }, { u0: w.ff.o, u1: s.dur, T0: w.ff.b, real: true }];
    for (const pc of pieces) {
      const T0 = w.t0 + pc.T0;            // take time at the piece's start
      const shift = o + pc.u0 - T0;       // take time + shift = output time (real pieces)
      const p = pointerAt(trail, T0);
      terms.push({ at: o + pc.u0, dx: p.x - (cur?.x ?? 0), dy: p.y - (cur?.y ?? 0) });
      cur = p;
      if (!pc.real) continue;
      const T1 = T0 + (pc.u1 - pc.u0);
      for (const g of trail) {
        if (g.d <= 0 || g.s + g.d <= T0 || g.s >= T1) continue;
        const from = Math.max(g.s, T0) + shift, to = Math.min(g.s + g.d, T1) + shift;
        terms.push({ s: g.s + shift, d: g.d, from, to, dx: g.x1 - g.x0, dy: g.y1 - g.y0 });
      }
      cur = pointerAt(trail, T1);         // where its glides, held to the piece, leave it
    }
  }
  return terms;
}

/** The sped-up stretches on the output clock (seconds from the recording's start) and how fast: [{ from, to, speed }]. */
export function fastForwards(tl, takes) {
  const L = layout(tl, takes);
  if (!L) return [];
  return L.rec.filter((s) => L.where[s.id].ff).map((s) => {
    const { a, b, o } = L.where[s.id].ff;
    return { scene: s.id, from: s.start - L.start + a, to: s.start - L.start + o, speed: (b - a) / (o - a) };
  }).filter((f) => f.speed > 1.05);
}

/** Evaluates pointerTerms at output time t (what the ffmpeg expression computes; for the test and checks). */
export function pointerFromTerms(terms, t) {
  let x = 0, y = 0;
  for (const q of terms) {
    if (q.at !== undefined) { if (t >= q.at) { x += q.dx; y += q.dy; } continue; }
    const k = ease(clip((clip(t, q.from, q.to) - q.s) / q.d, 0, 1)) - ease(clip((q.from - q.s) / q.d, 0, 1));
    x += q.dx * k; y += q.dy * k;
  }
  return { x, y };
}

/** One axis of pointerTerms as an ffmpeg expression in t, mapped to inset px: (v − tip − pad) · scale. */
function axisExpr(terms, axis, scale) {
  const n = (v) => +v.toFixed(4);
  const off = (axis === 'x' ? CURSOR.tip.x : CURSOR.tip.y) + CURSOR.pad;
  const parts = [`${n(-off * scale)}`];
  const E = (u) => `(st(0,clip(${u},0,1));if(lt(ld(0),0.5),2*ld(0)*ld(0),1-pow(2-2*ld(0),2)/2))`;
  for (const q of terms) {
    const d = (axis === 'x' ? q.dx : q.dy) * scale;
    if (Math.abs(d) < 0.01) continue;
    if (q.at !== undefined) { parts.push(`${n(d)}*gte(t,${n(q.at)})`); continue; }
    const e0 = ease(clip((q.from - q.s) / q.d, 0, 1));
    parts.push(`${n(d)}*(${E(`(clip(t,${n(q.from)},${n(q.to)})-${n(q.s)})/${n(q.d)}`)}-${n(e0)})`);
  }
  return parts.join('+').replace(/\+-/g, '-');
}

/** Draws the pointer (driver.mjs's arrow) at `scale` into a PNG with room for its shadow. */
async function cursorPng(file, scale) {
  const { chromium } = await import('playwright');
  const box = CURSOR.size + 2 * CURSOR.pad;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: box, height: box }, deviceScaleFactor: scale });
    await page.setContent(`<html><body style="margin:0;background:transparent"><svg style="position:absolute;left:${CURSOR.pad}px;top:${CURSOR.pad}px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))" width="24" height="24" viewBox="0 0 24 24">
      <path d="M4 2l15 11.5-6.6 1.1 3.9 7.2-2.9 1.5-3.9-7.3L4 21z" fill="#fff" stroke="#000" stroke-width="1.4"/></svg></body></html>`);
    await page.screenshot({ path: file, omitBackground: true });
  } finally { await browser.close(); }
}

/** The "sped up" badge (light, as the frame is): a pill with a fast-forward mark and the real speed, to one decimal (2.4×, never rounded down to 2×; 5× for 5.0). */
export const badgeLabel = (speed) => `Sped up ${+speed.toFixed(1)}×`;
async function badgePng(file, label, scale) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 80 }, deviceScaleFactor: scale });
    await page.setContent(`<html><body style="margin:0;background:transparent;font-family:-apple-system,'Helvetica Neue',sans-serif">
      <div id="b" style="display:inline-flex;align-items:center;gap:8px;margin:6px;padding:7px 14px 7px 11px;border-radius:999px;background:#1f2328;color:#fff;font-size:16px;font-weight:700;box-shadow:0 4px 14px rgba(0,0,0,.25)">
      <svg width="18" height="18" viewBox="0 0 24 24"><path d="M3 5.5v13l8.5-6.5zM12 5.5v13l8.5-6.5z" fill="#fbbf24"/></svg>${label}</div></body></html>`);
    const box = await page.locator('#b').boundingBox();
    await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: box.x + box.width + 6, height: box.y + box.height + 6 } });
  } finally { await browser.close(); }
}

async function main() {
  const timeline = JSON.parse(readFileSync(join(BUILD, 'timeline.json'), 'utf8'));
  if (!timeline.recording) { console.log('composite: this cut has no recording; capture wrote master.mkv'); return; }
  // the takes: this cut's own, or (recording.footage) another cut's, if they fit this timeline
  const footage = timeline.recording.footage;
  const SRC = footage ? join(HERE, '..', cutOf(footageVariant(footage)).build) : BUILD;
  if (footage) {
    const src = JSON.parse(readFileSync(join(SRC, 'timeline.json'), 'utf8'));
    const bad = checkFootage(timeline, src);
    if (bad.length) throw new Error(`recording.footage ${footage}: this cut's scenes do not match the footage's (record the default cut again, or match script.yaml):\n  ${bad.join('\n  ')}`);
  }
  const recDir = join(SRC, 'rec');
  if (!existsSync(recDir)) throw new Error(`no ${recDir}: run \`node record/record.mjs\` first`);
  const takes = {}, trails = {};
  for (const name of readdirSync(recDir)) {
    const dir = join(recDir, name);
    if (!existsSync(join(dir, 'scenes.json'))) continue;
    takes[name] = {
      scenes: JSON.parse(readFileSync(join(dir, 'scenes.json'), 'utf8')),
      frames: readFileSync(join(dir, 'frames.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).sort((a, b) => a.t - b.t),
    };
    if (!existsSync(join(dir, 'pointer.json'))) throw new Error(`no ${join(dir, 'pointer.json')}: record again (the pointer is drawn from it)`);
    trails[name] = JSON.parse(readFileSync(join(dir, 'pointer.json'), 'utf8'));
  }
  // npm run still: the still a scene with props.still draws (player/assets/still-<scene>.jpg, committed;
  // capture renders it, so run this after every new take of that scene and before capture)
  if (STILLS) {
    for (const sc of timeline.scenes.filter((s) => s.props?.still)) {
      const f = stillFrame(timeline, takes, sc.props.still);
      const out = join(HERE, '..', 'player', 'assets', `still-${sc.props.still}.jpg`);
      copyFileSync(join(recDir, f.take, f.file), out);
      // where composite's pointer is on that frame (its tip, inset px), so the still can draw it and move it away
      const { WINDOW } = await import('./vscode.mjs');
      const k = timeline.recording.inset.w / WINDOW.width;
      const p = pointerAt(trails[f.take] ?? [], f.at);
      writeFileSync(out.replace(/\.jpg$/, '.json'), JSON.stringify({ frame: `${f.take}/${f.file}`, pointer: { x: +(p.x * k).toFixed(1), y: +(p.y * k).toFixed(1) } }) + '\n');
      console.log(`still: ${sc.id} draws ${sc.props.still}'s last frame (${f.take}/${f.file}) -> ${out}`);
    }
    return;
  }
  const { frames, start, end, cuts, segments } = framePlan(timeline, takes);
  const fps = timeline.fps;
  const { x, y, w, h } = timeline.recording.inset;
  const { WINDOW } = await import('./vscode.mjs');
  const scale = w / WINDOW.width;

  // one concat list per run between cuts
  const inputs = [];
  segments.forEach((seg, k) => {
    const list = join(BUILD, `recording.${k}.ffconcat`);
    const lines = ['ffconcat version 1.0'];
    for (const f of seg.frames) lines.push(`file '${join(recDir, f.take, f.file)}'`, `duration ${(1 / fps).toFixed(6)}`);
    lines.push(`file '${join(recDir, seg.frames.at(-1).take, seg.frames.at(-1).file)}'`);
    writeFileSync(list, lines.join('\n') + '\n');
    inputs.push('-f', 'concat', '-safe', '0', '-i', list);
  });
  const cursor = join(BUILD, 'cursor.png');
  await cursorPng(cursor, scale);
  inputs.push('-loop', '1', '-framerate', String(fps), '-i', cursor);

  const g = [];
  segments.forEach((seg, k) => g.push(`[${k}:v]fps=${fps},scale=${w}:${h}:flags=lanczos:in_range=full:out_range=limited,format=yuv444p,setparams=range=tv,setsar=1,trim=end_frame=${seg.to - seg.from},setpts=N/${fps}/TB[s${k}]`));
  let last = 's0', acc = segments[0].to - segments[0].from;
  for (let k = 1; k < segments.length; k++) {
    g.push(`[${last}][s${k}]xfade=transition=fade:duration=${(XFADE / fps).toFixed(6)}:offset=${((acc - XFADE) / fps).toFixed(6)}[x${k}]`);
    acc += segments[k].to - segments[k].from - XFADE;
    last = `x${k}`;
  }
  if (acc !== frames.length) throw new Error(`cross-fades: ${acc} frames, expected ${frames.length}`);
  // the pointer, from the driver's path, on this clock
  const terms = pointerTerms(timeline, takes, trails);
  g.push(`[${segments.length}:v]format=rgba[cur]`);
  g.push(`[${last}][cur]overlay=x='${axisExpr(terms, 'x', scale)}':y='${axisExpr(terms, 'y', scale)}':eval=frame:shortest=1:format=auto,format=yuv444p[p]`);
  last = 'p';
  // the punch-in: from its beat to the end of its scene, the focus region scaled up to fill the window
  const zoom = timeline.recording.zoom;
  if (zoom) {
    const sc = timeline.scenes.find((s) => s.id === zoom.scene);
    if (!sc) throw new Error(`recording.zoom: no scene ${zoom.scene}`);
    const at = sc.start - start + (zoom.beat ? sc.beats[zoom.beat].t : 0) + (zoom.offset ?? 0);
    const zw = Math.round(w / zoom.scale / 2) * 2, zh = Math.round(h / zoom.scale / 2) * 2;
    const zx = Math.round(clip(zoom.focus[0] - zw / 2, 0, w - zw)), zy = Math.round(clip(zoom.focus[1] - zh / 2, 0, h - zh));
    g.push(`[${last}]split[za][zb]`);
    g.push(`[zb]crop=${zw}:${zh}:${zx}:${zy},scale=${w}:${h}:flags=lanczos,format=yuva444p,fade=t=in:st=${at.toFixed(3)}:d=${zoom.dur}:alpha=1[zz]`);
    g.push(`[za][zz]overlay=0:0:enable='between(t,${at.toFixed(3)},${(sc.start - start + sc.dur).toFixed(3)})':format=auto,format=yuv444p[z]`);
    last = 'z';
  }
  // the "sped up" badge while the footage runs faster than real time (in the window's empty title bar, top left)
  const ffs = fastForwards(timeline, takes);
  for (const [k, f] of ffs.entries()) {
    const file = join(BUILD, `badge.${k}.png`);
    await badgePng(file, badgeLabel(f.speed), scale);
    inputs.push('-loop', '1', '-framerate', String(fps), '-i', file);
    const idx = segments.length + 1 + k;
    g.push(`[${idx}:v]format=rgba[bd${k}]`);
    g.push(`[${last}][bd${k}]overlay=x=${Math.round(56 * scale)}:y=${Math.round(1 * scale)}:enable='between(t,${f.from.toFixed(3)},${f.to.toFixed(3)})':shortest=1:format=auto,format=yuv444p[f${k}]`);
    last = `f${k}`;
  }
  g.push(`[${last}]setparams=range=tv[v]`);
  const script = join(BUILD, 'recording.filter');
  writeFileSync(script, g.join(';\n') + '\n');
  const recording = join(BUILD, 'recording.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-/filter_complex', script, '-map', '[v]',
    '-frames:v', String(frames.length), '-c:v', 'libx264', '-preset', 'medium', '-crf', '8', '-pix_fmt', 'yuv444p', '-color_range', 'tv', recording], { stdio: 'inherit' });
  // each run of recorded scenes over the frame on its own, fading in and out where the frame does
  // (main.js), or cutting with no fade next to a scene that holds the window (the AI change's still)
  const fade = timeline.fade;
  const runs = runsOf(timeline);
  const og = [`[1:v]split=${runs.length}${runs.map((_, k) => `[rs${k}]`).join('')}`];
  let base = '0:v';
  runs.forEach((r, k) => {
    const a = start + r.from, b = start + r.to;
    const fin = holdsWindow(r.before) ? '' : `,fade=t=in:st=${a.toFixed(3)}:d=${fade}:alpha=1`;
    const fout = holdsWindow(r.after) ? '' : `,fade=t=out:st=${(b - fade).toFixed(3)}:d=${fade}:alpha=1`;
    // into a still, the footage runs on two frames over it (the same picture): never a frame of the empty window between
    const to = holdsWindow(r.after) ? +(r.to + 2 / fps).toFixed(3) : r.to;
    og.push(`[rs${k}]trim=start=${r.from}:end=${to},setpts=PTS-STARTPTS+${a}/TB,format=yuva444p${fin}${fout}[r${k}]`);
    og.push(`[${base}][r${k}]overlay=x=${x}:y=${y}:eof_action=pass:format=auto,format=yuv444p[o${k}]`);
    base = `o${k}`;
  });
  og.push(`[${base}]setparams=range=tv[v]`);
  const graph = og.join(';');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(BUILD, 'chrome.mkv'), '-i', recording, '-filter_complex', graph, '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv444p', '-color_range', 'tv', '-r', String(fps), join(BUILD, 'master.mkv')], { stdio: 'inherit' });
  console.log(`composite: ${footage ? `the ${footage} cut's footage, ` : ''}${frames.length} recorded frames (${start}s–${end}s, ${runs.length} run${runs.length > 1 ? 's' : ''}), ${cuts.length} cross-fades (${cuts.map((c) => `${c.before.id}→${c.after.id}`).join(', ')}), pointer from ${terms.length} terms${zoom ? `, punch-in on ${zoom.scene}` : ''}${ffs.length ? `, sped up: ${ffs.map((f) => `${f.scene} ${f.speed.toFixed(1)}x`).join(', ')}` : ''}, at ${x},${y} ${w}x${h} -> ${join(BUILD, 'master.mkv')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
