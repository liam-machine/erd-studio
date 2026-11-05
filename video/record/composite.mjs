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
// to the scene's end. The footage fades in and out with the frame's own fades (main.js: only
// where the recording starts and ends). A cut without `recording` has nothing to composite:
// capture wrote its master.mkv already.
//
//   node record/composite.mjs            VARIANT picks the cut, as everywhere else
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VARIANT = process.env.VARIANT ?? '';
const BUILD = join(HERE, '..', VARIANT ? `build-${VARIANT}` : 'build');

/** Frames the footage cross-fades over where it jumps (1/3 s at 30 fps). Even: half each side of the cut. */
export const XFADE = 10;
/** A cut in the footage: consecutive scenes from different takes, or more than this far apart in one. */
const JUMP_S = 0.35;
/** The pointer image (driver.mjs POINTER: a 24 px arrow, its tip at 4,2), drawn PAD px in from its PNG's corner. */
const CURSOR = { size: 24, tip: { x: 4, y: 2 }, pad: 8 };

const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
const clip = (v, a, b) => Math.min(b, Math.max(a, v));

/** Where each recorded scene sits: in the timeline (start, dur) and in its take (name, t0). */
function layout(tl, takes) {
  const rec = tl.scenes.filter((s) => s.module.startsWith('rec/'));
  if (!rec.length) return null;
  const first = tl.scenes.indexOf(rec[0]);
  const last = tl.scenes.indexOf(rec.at(-1));
  for (let i = first; i <= last; i++) if (!tl.scenes[i].module.startsWith('rec/')) throw new Error(`scene ${tl.scenes[i].id} interrupts the recording`);
  const where = {};
  for (const [name, take] of Object.entries(takes)) for (const s of take.scenes) where[s.id] = { name, ...s };
  for (const s of rec) {
    if (!where[s.id]) throw new Error(`scene ${s.id} was never recorded: run \`node record/record.mjs\``);
    if (Math.abs(where[s.id].dur - s.dur) > 0.01) throw new Error(`scene ${s.id} was filmed for ${where[s.id].dur}s but the timeline gives it ${s.dur}s: record again`);
  }
  const start = rec[0].start;
  const end = rec.at(-1).start + rec.at(-1).dur;
  return { rec, where, start, end, n: Math.round((end - start) * tl.fps) };
}

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
  const sceneOf = (t) => rec.find((x) => t < x.start + x.dur) ?? rec.at(-1);
  const pick = (i, s) => { const t = start + (i + 0.5) / fps; const w = where[s.id]; return frameAt(takes, w.name, w.t0 + (t - s.start)); };
  const frames = [];
  for (let i = 0; i < n; i++) frames.push(pick(i, sceneOf(start + (i + 0.5) / fps)));
  // the cuts: where the next scene is not the take's next stretch of film
  const cuts = [];
  for (let k = 1; k < rec.length; k++) {
    const a = where[rec[k - 1].id], b = where[rec[k].id];
    if (a.name !== b.name || Math.abs(b.t0 - (a.t0 + a.dur)) > JUMP_S) cuts.push({ at: Math.round((rec[k].start - start) * fps), before: rec[k - 1], after: rec[k] });
  }
  const H = XFADE / 2;
  const segments = [];
  for (let k = 0; k <= cuts.length; k++) {
    const a = k === 0 ? 0 : cuts[k - 1].at, b = k === cuts.length ? n : cuts[k].at;
    const from = k === 0 ? 0 : a - H, to = k === cuts.length ? n : b + H;
    const list = [];
    for (let i = from; i < to; i++) {
      if (i < a) list.push(pick(i, cuts[k - 1].after));          // the incoming scene, filmed before its mark
      else if (i >= b) list.push(pick(i, cuts[k].before));       // the outgoing scene, filmed on past its end
      else list.push(frames[i]);
    }
    segments.push({ from, to, frames: list });
  }
  return { frames, start, end, cuts, segments };
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
    const shift = o - w.t0;               // take time + shift = output time
    const p = pointerAt(trail, w.t0);
    terms.push({ at: o, dx: p.x - (cur?.x ?? 0), dy: p.y - (cur?.y ?? 0) });
    cur = p;
    for (const g of trail) {
      if (g.d <= 0 || g.s + g.d <= w.t0 || g.s >= w.t0 + s.dur) continue;
      const from = Math.max(g.s, w.t0) + shift, to = Math.min(g.s + g.d, w.t0 + s.dur) + shift;
      terms.push({ s: g.s + shift, d: g.d, from, to, dx: g.x1 - g.x0, dy: g.y1 - g.y0 });
    }
    cur = pointerAt(trail, w.t0 + s.dur);   // where its glides, held to the scene, leave it
  }
  return terms;
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

async function main() {
  const timeline = JSON.parse(readFileSync(join(BUILD, 'timeline.json'), 'utf8'));
  if (!timeline.recording) { console.log('composite: this cut has no recording; capture wrote master.mkv'); return; }
  const recDir = join(BUILD, 'rec');
  if (!existsSync(recDir)) throw new Error('no build/rec: run `node record/record.mjs` first');
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
    g.push(`[za][zz]overlay=0:0:format=auto,format=yuv444p[z]`);
    last = 'z';
  }
  g.push(`[${last}]setparams=range=tv[v]`);
  const script = join(BUILD, 'recording.filter');
  writeFileSync(script, g.join(';\n') + '\n');
  const recording = join(BUILD, 'recording.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-/filter_complex', script, '-map', '[v]',
    '-frames:v', String(frames.length), '-c:v', 'libx264', '-preset', 'medium', '-crf', '8', '-pix_fmt', 'yuv444p', '-color_range', 'tv', recording], { stdio: 'inherit' });
  const fade = timeline.fade;
  const graph = `[1:v]setpts=PTS+${start}/TB,format=yuva444p,fade=t=in:st=${start}:d=${fade}:alpha=1,fade=t=out:st=${(end - fade).toFixed(3)}:d=${fade}:alpha=1[r];`
    + `[0:v][r]overlay=x=${x}:y=${y}:eof_action=pass:format=auto,format=yuv444p,setparams=range=tv[v]`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(BUILD, 'chrome.mkv'), '-i', recording, '-filter_complex', graph, '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv444p', '-color_range', 'tv', '-r', String(fps), join(BUILD, 'master.mkv')], { stdio: 'inherit' });
  console.log(`composite: ${frames.length} recorded frames (${start}s–${end}s), ${cuts.length} cross-fades (${cuts.map((c) => `${c.before.id}→${c.after.id}`).join(', ')}), pointer from ${terms.length} terms${zoom ? `, punch-in on ${zoom.scene}` : ''}, at ${x},${y} ${w}x${h} -> ${join(BUILD, 'master.mkv')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
