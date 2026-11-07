// --narrate: a voice for each caption. Every mark (the title card, each step,
// Done) gets one spoken line: the step's `say` when it has one
// (s.step(caption, fn, { say })), else its caption made speakable
// (`spoken`). Each line is voiced once by lib/tts.py (Kokoro, the getting-started
// tour's voice) and cached under test/stories/.cache/voice/ by voice + speed +
// text. `planNarration` places each line just after its caption appears; when
// a line is longer than the time to the next caption, the last frame before
// that caption is held (a freeze) for the difference, so the voice is never
// overlapped, cut or sped up. video.mjs encodes the frames on that timeline.
//
// Only --narrate needs uv (and Python): a plain run never loads any of this.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TTS = path.join(HERE, 'tts.py');
export const CACHE_DIR = path.join(HERE, '..', '.cache', 'voice');

/** The getting-started tour's voice (video/script.yaml `voice`), so ERD Studio sounds the same everywhere. */
export const VOICE = { voice: 'af_heart', speed: 1.04 };

/** Seconds: a line starts `lead` after its caption appears, and leaves `gap` of quiet before the next caption. */
export const TIMING = { lead: 0.35, gap: 0.3 };

/** Is the narrator there (uv on PATH)? */
export function narratorProblem() {
  const r = spawnSync('uv', ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? null : '--narrate needs uv (https://docs.astral.sh/uv/) on PATH: it runs test/stories/lib/tts.py (Kokoro)';
}

/**
 * A caption as a voice reads it: no quotes, ellipses or arrows, a bracket as a
 * pause, ▶ as "play", ending in a full stop. A caption with a file name, a
 * path or a symbol the voice would read badly gets its own `say` instead.
 */
export function spoken(caption) {
  let s = String(caption)
    .replace(/▶/g, 'play')
    .replace(/\s*→\s*/g, ' to ')
    .replace(/…/g, '')
    .replace(/["“”]/g, '')
    .replace(/\s*\(([^)]*)\)/g, ', $1,')
    .replace(/\s*;\s*/g, '. ')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*([.,:!?]|$)/g, '$1')
    .trim();
  if (s && !/[.!?]$/.test(s)) s += '.';
  return s;
}

/** What a mark says: its `say` ('' or null: nothing), else by kind. */
export function lineFor(mark) {
  if (mark.say !== undefined) return mark.say ? String(mark.say) : '';
  if (mark.kind === 'intro') return spoken(String(mark.text).split('\n')[0]);
  if (mark.kind === 'pass') return 'Done.';
  if (mark.kind === 'fail') return 'This step failed.';
  return spoken(mark.text);
}

const keyOf = (text, v = VOICE) => crypto.createHash('sha1').update(`${v.voice}|${v.speed}|${text}`).digest('hex').slice(0, 16);

/** A 16-bit PCM WAV's samples as floats, with its rate. */
export function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error(`${file}: not a WAV file`);
  let at = 12;
  let rate = 0;
  let channels = 1;
  let bits = 16;
  for (; at + 8 <= buf.length;) {
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error(`${file}: ${bits}-bit, not 16-bit PCM`);
      const n = Math.floor(Math.min(size, buf.length - body) / 2 / channels);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += buf.readInt16LE(body + (i * channels + c) * 2);
        samples[i] = sum / channels / 32768;
      }
      return { rate, samples };
    }
    at = body + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

/** Write mono float samples as a 16-bit PCM WAV. */
export function writeWav(file, samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

/**
 * Voice `texts` (cached): returns Map text → { file, seconds }. Only the
 * lines not in the cache go to tts.py, in one call.
 */
export function voiceLines(texts, { cacheDir = CACHE_DIR, voice = VOICE, log = () => {} } = {}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const unique = [...new Set(texts.filter(Boolean))];
  const want = unique.map((text) => ({ text, file: `${keyOf(text, voice)}.wav` }));
  const missing = want.filter((w) => !fs.existsSync(path.join(cacheDir, w.file)));
  if (missing.length) {
    log(`narration: voicing ${missing.length} new line(s) of ${unique.length}`);
    const r = spawnSync('uv', ['run', '--quiet', '--script', TTS, '--voice', voice.voice, '--speed', String(voice.speed), '--out', cacheDir], {
      input: JSON.stringify(missing), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`tts.py failed: ${(r.stderr || String(r.error)).trim().split('\n').slice(-4).join(' | ')}`);
    for (const l of (r.stderr ?? '').split('\n').filter((x) => x.startsWith('[tts]'))) log(`narration: ${l.slice(6).trim()}`);
  }
  const out = new Map();
  for (const w of want) {
    const file = path.join(cacheDir, w.file);
    const { rate, samples } = readWav(file);
    out.set(w.text, { file, seconds: samples.length / rate });
  }
  return out;
}

/**
 * The narrated timeline. `marks` [{ t, text, kind, say? }] and `frames` [{ t }]
 * are in epoch ms; `tEnd` is when the video ends (ms); `voiced` is
 * voiceLines' map. Returns:
 *   holds   [{ at, seconds }]  freeze `seconds` just before real time `at` (ms)
 *   toVideo (ms) => seconds    real time → time in the narrated video
 *   lines   [{ text, file, start, seconds }]  each line's start in the video
 *   seconds the narrated video's length
 */
export function planNarration({ marks, frames, tEnd, voiced, timing = TIMING }) {
  const t0 = frames[0].t;
  const sorted = [...marks].filter((m) => m.t <= tEnd).sort((a, b) => a.t - b.t);
  const holds = [];
  const pending = [];
  sorted.forEach((m, i) => {
    const text = lineFor(m);
    const v = text ? voiced.get(text) : undefined;
    if (!v) return;
    const next = i + 1 < sorted.length ? sorted[i + 1].t : tEnd;
    const from = Math.max(m.t, t0);
    const need = (timing.lead + v.seconds + timing.gap) * 1000;
    const short = need - (next - from);
    if (short > 0) holds.push({ at: next, seconds: short / 1000 });
    pending.push({ text, file: v.file, seconds: v.seconds, from });
  });
  const toVideo = (t) => (t - t0) / 1000 + holds.reduce((sum, h) => sum + (h.at <= t ? h.seconds : 0), 0);
  const lines = pending.map((p) => ({ text: p.text, file: p.file, seconds: p.seconds, start: toVideo(p.from) + timing.lead }));
  return { holds, toVideo, lines, seconds: toVideo(tEnd) };
}

/** Each frame's duration (s) on the narrated timeline: real time plus any hold that falls before the next frame. */
export function frameDurations(frames, tEnd, holds = []) {
  return frames.map((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : tEnd;
    const held = holds.reduce((sum, h) => sum + (h.at > f.t && h.at <= next ? h.seconds : 0), 0);
    return (next - f.t) / 1000 + held;
  });
}

/**
 * Mix the placed lines into one mono WAV of `seconds` (the voice's own rate),
 * peak-normalised to -1 dBFS. Returns `{ file, speechSeconds }`.
 */
export function mixNarration(lines, seconds, file) {
  if (lines.length === 0) throw new Error('nothing to narrate');
  const rate = readWav(lines[0].file).rate;
  const out = new Float32Array(Math.ceil(seconds * rate));
  let speech = 0;
  for (const l of lines) {
    const { rate: r, samples } = readWav(l.file);
    if (r !== rate) throw new Error(`${l.file}: ${r} Hz, the others ${rate} Hz`);
    const at = Math.round(l.start * rate);
    for (let i = 0; i < samples.length && at + i < out.length; i++) out[at + i] += samples[i];
    speech += l.seconds;
  }
  let peak = 0;
  for (const x of out) peak = Math.max(peak, Math.abs(x));
  const gain = peak > 0 ? Math.min(4, 0.89 / peak) : 1;
  for (let i = 0; i < out.length; i++) out[i] *= gain;
  writeWav(file, out, rate);
  return { file, speechSeconds: speech };
}
