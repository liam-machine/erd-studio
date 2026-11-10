// Frames + marks → an MP4 with burned-in captions, one caption per step.
//
// Captions are an ASS subtitle file rendered by ffmpeg's `ass` filter (libass:
// in Homebrew's ffmpeg and in Ubuntu's apt ffmpeg). When this ffmpeg has no
// libass, the video is written without burned captions and the same captions
// go in as a soft subtitle track (mov_text) plus a .srt next to it, with a warning.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { frameDurations, lineFor, mixNarration, planNarration, voiceLines } from './narrate.mjs';

export function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) if (fs.existsSync(p)) return p;
  return 'ffmpeg';
}

function hasFilter(ffmpeg, name) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' });
  return r.status === 0 && new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(r.stdout);
}

const assTime = (ms) => {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const srtTime = (ms) => assTime(ms).replace(/^(\d+):/, (_, h) => `${h.padStart(2, '0')}:`).replace('.', ',') + '0';
const assText = (s) => s.replace(/\\/g, '/').replace(/[{}]/g, (c) => (c === '{' ? '(' : ')')).replace(/\r?\n/g, '\\N');

/**
 * The caption cues: each mark shows from its time to the next mark's (the last
 * one to the end). `marks` = [{ t, text, kind: 'intro'|'step'|'fail'|'pass', at? }];
 * `at: 'left'` puts a step's caption bottom-left, clear of the notification
 * toasts VS Code stacks bottom-right (a step about a notification).
 */
export function cues(marks, t0, tEnd, toVideoMs = (t) => t - t0) {
  const sorted = [...marks].sort((a, b) => a.t - b.t);
  return sorted.map((m, i) => ({
    start: Math.max(0, toVideoMs(m.t)),
    end: Math.max(0, toVideoMs(i + 1 < sorted.length ? sorted[i + 1].t : tEnd)),
    text: m.text,
    kind: m.kind ?? 'step',
    ...(m.at === 'left' ? { at: 'left' } : {}),
  })).filter((c) => c.end > c.start);
}

export function assFile(list, { width, height }) {
  const font = process.platform === 'darwin' ? 'Helvetica Neue' : 'DejaVu Sans';
  // BorderStyle 3 = an opaque box behind the text, coloured by OutlineColour (&HAABBGGRR).
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: step,${font},30,&H00FFFFFF,&H00FFFFFF,&H30201810,&H00000000,1,0,0,0,100,100,0,0,3,14,0,2,120,120,56,1
Style: stepLeft,${font},30,&H00FFFFFF,&H00FFFFFF,&H30201810,&H00000000,1,0,0,0,100,100,0,0,3,14,0,1,120,${Math.round(width * 0.36)},56,1
Style: intro,${font},34,&H00FFFFFF,&H00FFFFFF,&H18402010,&H00000000,1,0,0,0,100,100,0,0,3,22,0,5,160,160,40,1
Style: fail,${font},30,&H00FFFFFF,&H00FFFFFF,&H202020B0,&H00000000,1,0,0,0,100,100,0,0,3,14,0,2,120,120,56,1
Style: pass,${font},30,&H00FFFFFF,&H00FFFFFF,&H20286018,&H00000000,1,0,0,0,100,100,0,0,3,14,0,2,120,120,56,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  return head + list.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},${c.kind === 'step' && c.at === 'left' ? 'stepLeft' : c.kind},,0,0,0,,${assText(c.text)}`).join('\n') + '\n';
}

export function srtFile(list) {
  return list.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

/**
 * Encode `frames` ([{ file, t }]) with `marks` into `outFile` (.mp4); with
 * `narrate`, spoken too. Returns `{ file, seconds, burned, srt, narration? }`
 * (`narration`: `{ lines, speechSeconds, heldSeconds, holds }`). Throws when
 * ffmpeg (or, narrating, the voice) fails.
 */
export function encode({ frames, marks, outFile, workDir, tailMs = 1500, narrate = false, log = () => {} }) {
  if (frames.length === 0) throw new Error('no frames were recorded');
  const ffmpeg = findFfmpeg();
  fs.mkdirSync(workDir, { recursive: true });
  const t0 = frames[0].t;
  const tEnd = frames[frames.length - 1].t + tailMs;

  let plan = null;
  let narration;
  if (narrate) {
    const voiced = voiceLines(marks.map(lineFor), { log });
    plan = planNarration({ marks, frames, tEnd, voiced });
    const mixed = mixNarration(plan.lines, plan.seconds, path.join(workDir, 'narration.wav'));
    const heldSeconds = plan.holds.reduce((sum, h) => sum + h.seconds, 0);
    narration = { lines: plan.lines.length, speechSeconds: mixed.speechSeconds, heldSeconds, holds: plan.holds.length, wav: mixed.file };
  }

  // Constant frame rate: each frame lasts until the next one was taken (real
  // time), plus, narrating, any hold before the next caption.
  const durations = frameDurations(frames, tEnd, plan?.holds);
  const lines = ['ffconcat version 1.0'];
  frames.forEach((f, i) => {
    lines.push(`file '${f.file.replace(/'/g, "'\\''")}'`, `duration ${durations[i].toFixed(3)}`);
  });
  lines.push(`file '${frames[frames.length - 1].file.replace(/'/g, "'\\''")}'`);
  const list = path.join(workDir, 'frames.ffconcat');
  fs.writeFileSync(list, lines.join('\n') + '\n');

  const probe = spawnSync(findFfprobe(ffmpeg), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', frames[0].file], { encoding: 'utf8' });
  const [width, height] = (probe.stdout.trim() || '1440,900').split(',').map(Number);

  const captions = cues(marks, t0, tEnd, plan ? (t) => plan.toVideo(t) * 1000 : undefined);
  fs.writeFileSync(path.join(workDir, 'captions.ass'), assFile(captions, { width, height }));
  const srt = outFile.replace(/\.mp4$/, '.srt');
  fs.writeFileSync(srt, srtFile(captions));

  const burn = hasFilter(ffmpeg, 'ass');
  const vf = ['scale=trunc(iw/2)*2:trunc(ih/2)*2', ...(burn ? ['ass=captions.ass'] : [])].join(',');
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list];
  if (narration) args.push('-i', narration.wav);
  if (!burn) args.push('-i', srt);
  args.push('-vf', vf, '-fps_mode', 'cfr', '-r', '25', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
  if (narration) args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '1', '-ar', '48000');
  args.push('-map', '0:v');
  if (narration) args.push('-map', '1:a');
  if (!burn) args.push('-c:s', 'mov_text', '-map', `${narration ? 2 : 1}:s`);
  args.push(outFile);
  // cwd = workDir, so the ass filter's path needs no escaping.
  const r = spawnSync(ffmpeg, args, { cwd: workDir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr || r.error}`);
  if (!burn) console.warn(`[stories] this ffmpeg has no libass: captions are a subtitle track and ${path.basename(srt)}, not burned in`);
  return { file: outFile, seconds: plan ? plan.seconds : (tEnd - t0) / 1000, burned: burn, srt, narration };
}

function findFfprobe(ffmpeg) {
  const sibling = path.join(path.dirname(ffmpeg), 'ffprobe');
  return fs.existsSync(sibling) ? sibling : 'ffprobe';
}
