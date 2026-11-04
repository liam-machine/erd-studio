// The Welcome panel's "Watch how" clips, published from recorded stories:
// `node test/stories/run.mjs --record --publish` (or `--publish` alone, from
// the recordings already in test/stories/out/). Each clip is its story's
// video, re-encoded for the extension: silent, H.264 High yuv420p, fast-start,
// 1280 px wide, captions as burned in by the recording, at most 45 s (sped up
// evenly when the story ran longer) and at most 2 MB, written to
// media/onboarding/stories/<clip>.mp4. The empty window before the story's
// title card is cut, so the first frame (the panel's poster: there is no
// poster file) is that card, and the window's title bar ("[Extension
// Development Host] <folder>") is cropped off. src/types/startActions.ts HOW_TO_CLIPS names the same files
// (test/unit/storiesPublish.test.ts holds the two together).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findFfmpeg } from './video.mjs';

/** Which story each clip comes from (by `HOW_TO_CLIPS` key). Convert has no clip. */
export const CLIPS = [
  { key: 'example', story: 'empty-window-opens-an-example', clip: 'open-an-example.mp4' },
  { key: 'blank', story: 'plain-folder-new-diagram-add-table', clip: 'start-a-blank-diagram.mp4' },
  { key: 'importSqlDdl', story: 'sql-scripts-import', clip: 'import-sql-scripts.mp4' },
  { key: 'importSemanticModel', story: 'power-bi-model-import', clip: 'import-power-bi-model.mp4' },
  { key: 'importDbmlFile', story: 'dbml-file-import', clip: 'import-a-dbml-file.mp4' },
  { key: 'drawFromDbt', story: 'dbt-project-draw', clip: 'draw-from-dbt.mp4' },
];

export const LIMITS = { width: 1280, maxSeconds: 45, maxBytes: 2 * 1024 * 1024, fps: 25 };

/** The recording's title bar (VS Code's custom title bar, 35 CSS px of the 900 px window), cropped off a clip. */
export const TITLE_BAR = { px: 35, windowHeight: 900 };

/** When the story's first caption (its title card) starts, in seconds, from its .srt; 0 without one. */
export function leadIn(srtText) {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->/.exec(srtText ?? '');
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/** The ffmpeg filter that crops the title bar off a recording of any pixel density (even heights for yuv420p). */
export function cropTitleBarFilter() {
  const off = `trunc(ih*${TITLE_BAR.px}/${TITLE_BAR.windowHeight}/2)*2`;
  return `crop=iw:ih-${off}:0:${off}`;
}

/** Where the clips go, from the repo root (`HOW_TO_CLIP_DIR`). */
export const CLIP_DIR = ['media', 'onboarding', 'stories'];

/**
 * A caption that names a path on the recording machine (its home, a temp
 * folder, a user folder): a published clip must show none.
 */
export function pathInCaption(text, home = os.homedir()) {
  return [home, '/tmp/', '/private/', '/Users/', '/home/', '/var/folders/', 'C:\\', '\\Users\\'].find((p) => p && text.includes(p));
}

function ffprobe(ffmpeg, args) {
  const sibling = path.join(path.dirname(ffmpeg), 'ffprobe');
  const bin = fs.existsSync(sibling) ? sibling : 'ffprobe';
  const r = spawnSync(bin, ['-v', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr || r.error}`);
  return JSON.parse(r.stdout);
}

/** What a clip file is: `{ seconds, bytes, codec, profile, pixFmt, width, height, audio, faststart }`. */
export function probeClip(file, ffmpeg = findFfmpeg()) {
  const info = ffprobe(ffmpeg, ['-show_entries', 'format=duration:stream=codec_type,codec_name,profile,pix_fmt,width,height', '-of', 'json', file]);
  const video = info.streams.find((s) => s.codec_type === 'video') ?? {};
  const buf = fs.readFileSync(file);
  return {
    seconds: Number(info.format.duration),
    bytes: buf.length,
    codec: video.codec_name,
    profile: video.profile,
    pixFmt: video.pix_fmt,
    width: video.width,
    height: video.height,
    audio: info.streams.some((s) => s.codec_type === 'audio'),
    faststart: buf.indexOf('moov') > 0 && buf.indexOf('moov') < buf.indexOf('mdat'),
  };
}

/** Why `p` (a `probeClip`) breaks the limits, or [] when it keeps them. */
export function clipProblems(p) {
  const out = [];
  if (p.codec !== 'h264' || p.profile !== 'High') out.push(`not H.264 High (${p.codec} ${p.profile})`);
  if (p.pixFmt !== 'yuv420p') out.push(`pixel format ${p.pixFmt}, not yuv420p`);
  if (p.width !== LIMITS.width) out.push(`${p.width} px wide, not ${LIMITS.width}`);
  if (p.audio) out.push('has an audio track');
  if (!p.faststart) out.push('not fast-start');
  if (p.seconds > LIMITS.maxSeconds + 0.05) out.push(`${p.seconds.toFixed(1)} s, over ${LIMITS.maxSeconds} s`);
  if (p.bytes > LIMITS.maxBytes) out.push(`${(p.bytes / 1024 / 1024).toFixed(2)} MB, over ${LIMITS.maxBytes / 1024 / 1024} MB`);
  return out;
}

/**
 * Re-encode `source` (a recorded story) into `out`. The story's captions
 * (`srt`) are checked for paths first. Sped up evenly to fit `maxSeconds`;
 * the quality steps down until the file fits `maxBytes`. Returns the probe.
 */
export function publishClip({ source, srt, out, home, workDir }) {
  const ffmpeg = findFfmpeg();
  const srtText = srt && fs.existsSync(srt) ? fs.readFileSync(srt, 'utf8') : '';
  for (const line of srtText.split('\n')) {
    const hit = pathInCaption(line, home);
    if (hit) throw new Error(`${path.basename(srt)}: a caption names a path (${hit}): ${line.trim()}`);
  }
  const src = probeClip(source, ffmpeg);
  // Start on the title card (a moment in, once it is drawn): the first frame is the panel's poster.
  const start = Math.min(leadIn(srtText) + 0.3, Math.max(0, src.seconds - 1));
  // A little under the limit, so rounding to whole frames never tips it over.
  const speed = Math.max(1, (src.seconds - start) / (LIMITS.maxSeconds - 0.5));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const tmp = path.join(workDir, path.basename(out));
  let last;
  for (const crf of [27, 30, 33, 36]) {
    const vf = [cropTitleBarFilter(), `setpts=PTS/${speed.toFixed(4)}`, `fps=${LIMITS.fps}`, `scale=${LIMITS.width}:-2:flags=lanczos:out_range=tv`, 'format=yuv420p'].join(',');
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', start.toFixed(3), '-i', source, '-an', '-sn', '-dn', '-map_metadata', '-1',
      '-vf', vf, '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-color_range', 'tv',
      '-g', String(LIMITS.fps * 4), '-movflags', '+faststart', '-t', String(LIMITS.maxSeconds), tmp];
    const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr || r.error}`);
    last = probeClip(tmp, ffmpeg);
    if (last.bytes <= LIMITS.maxBytes) break;
  }
  const problems = clipProblems(last);
  if (problems.length) throw new Error(`${path.basename(out)}: ${problems.join('; ')}`);
  fs.copyFileSync(tmp, out);
  return { ...last, speed, sourceSeconds: src.seconds };
}
