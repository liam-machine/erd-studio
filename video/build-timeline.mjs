#!/usr/bin/env node
// Turns script.yaml + the measured voice clips (build/voice/manifest.json, from tts.py) into:
//   build/timeline.json            scene starts/durations and named beats, read by player/ and capture.mjs
//   build/narration.wav            every clip placed on the timeline, loudness-normalised, 48 kHz mono
//   getting-started.vtt            captions (a source artefact: it is not shipped)
//   ../src/types/gettingStartedTranscript.ts   the same cues as a TS constant for the Welcome panel
//
// VARIANT picks the cut (see CUTS below): unset is the default cut, the DBML tour with a short dbt
// beat (script.yaml, build/, the files above); VARIANT=logical is the same tour without it, for a
// folder without dbt (script.logical.yaml, build-logical/, getting-started-logical.vtt and
// src/types/gettingStartedLogicalTranscript.ts).
//
// Timing is derived from the real audio, never guessed: change a line, re-run tts + timeline,
// and every beat that hangs off it moves with it.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

/**
 * Every cut the pipeline renders, keyed by VARIANT ('' is the default cut). `mp4` is the
 * shipped video the cues belong to; the two constant names are what the generated module exports.
 */
export const CUTS = {
  '': {
    script: 'script.yaml', build: 'build', vtt: 'getting-started.vtt', ts: 'gettingStartedTranscript.ts',
    mp4: 'getting-started.mp4', cues: 'GETTING_STARTED_CUES', transcript: 'GETTING_STARTED_TRANSCRIPT',
  },
  logical: {
    script: 'script.logical.yaml', build: 'build-logical', vtt: 'getting-started-logical.vtt', ts: 'gettingStartedLogicalTranscript.ts',
    mp4: 'getting-started-logical.mp4', cues: 'LOGICAL_GETTING_STARTED_CUES', transcript: 'LOGICAL_GETTING_STARTED_TRANSCRIPT',
  },
};
/** The cut VARIANT names; an unknown name fails rather than overwriting the default cut's files. */
export function cutOf(variant = '') {
  const cut = CUTS[variant];
  if (!cut) throw new Error(`unknown VARIANT ${variant} (known: ${Object.keys(CUTS).filter(Boolean).join(', ')})`);
  return cut;
}
/** The npm command `script` runs for `cut`, with its VARIANT when it is not the default cut: `npm run tts`, `VARIANT=logical npm run tts`. */
export function cutCommand(cut, script) {
  const variant = Object.keys(CUTS).find((k) => CUTS[k] === cut) ?? '';
  return variant ? `VARIANT=${variant} npm run ${script}` : `npm run ${script}`;
}

/** The error when `cut`'s voice manifest is missing: the cut's own path and the tts command that writes it. */
export function missingManifestMessage(cut) {
  return `${cut.build}/voice/manifest.json missing — run \`${cutCommand(cut, 'tts')}\` first`;
}
const round = (x) => Math.round(x * 1000) / 1000;

/** Cue text limit: two caption rows of ~42 characters. */
export const MAX_CUE_CHARS = 84;

/** Lays scenes and lines out on the clock. Pure: exported for the self-check at the bottom. */
export function buildTimeline(script, durations) {
  const { lead, gap, tail, fade } = script.timing;
  let clock = 0;
  const scenes = script.scenes.map((sc) => {
    const beats = {};
    const lines = [];
    let t = lead;
    (sc.lines ?? []).forEach((ln, i) => {
      const dur = durations[ln.id];
      if (dur === undefined) throw new Error(`no voice clip for line ${ln.id} — run tts.py first`);
      if (i > 0) t += ln.pause ?? gap;
      const line = { id: ln.id, beat: ln.beat, caption: ln.caption, t: round(t), end: round(t + dur), dur };
      lines.push(line);
      if (ln.beat) {
        if (beats[ln.beat]) throw new Error(`duplicate beat ${ln.beat} in scene ${sc.id}`);
        beats[ln.beat] = { t: line.t, end: line.end };
      }
      t += dur;
    });
    const dur = round(Math.max(sc.minDur ?? 0, t + tail));
    const scene = {
      id: sc.id, module: sc.module, chapter: sc.chapter ?? 0, start: round(clock), dur,
      accent: sc.accent ?? 'blue', accentAfter: sc.accentAfter ?? null,
      headline: sc.headline ?? null, props: sc.props ?? {}, beats, lines,
    };
    clock += dur;
    return scene;
  });
  // A recorded cut (script.yaml `recording`) carries the inset its footage plays in: record/ and
  // capture/composite read it from here.
  return { fps: 30, width: 1920, height: 1080, fade, total: round(clock), chapters: script.chapters, recording: script.recording ?? null, scenes };
}

/** Splits text into caption-sized pieces at sentence, then clause, boundaries. */
export function splitCaption(text, max = MAX_CUE_CHARS) {
  if (text.length <= max) return [text];
  const cut = (re) => {
    let best = -1;
    for (const m of text.matchAll(re)) {
      const at = m.index + m[0].length;
      if (at <= max && Math.abs(at - text.length / 2) < Math.abs(best - text.length / 2)) best = at;
    }
    return best;
  };
  let at = cut(/[.?!]\s/g);
  if (at < 0) at = cut(/[,:;]\s/g);
  if (at < 0) at = text.lastIndexOf(' ', max) + 1;
  return [text.slice(0, at).trim(), ...splitCaption(text.slice(at).trim(), max)];
}

/** Absolute-time cues. A lower-case continuation line joins the cue before it when it fits. */
export function buildCues(timeline) {
  const cues = [];
  for (const sc of timeline.scenes) {
    const groups = [];
    for (const ln of sc.lines) {
      const prev = groups[groups.length - 1];
      if (prev && /^[a-z]/.test(ln.caption) && prev.text.length + 1 + ln.caption.length <= MAX_CUE_CHARS) {
        prev.text += ' ' + ln.caption;
        prev.end = ln.end;
      } else groups.push({ text: ln.caption, t: ln.t, end: ln.end });
    }
    for (const g of groups) {
      const parts = splitCaption(g.text);
      const chars = parts.reduce((n, p) => n + p.length, 0);
      let t = g.t;
      for (const p of parts) {
        const d = ((g.end - g.t) * p.length) / chars;
        cues.push({ start: round(sc.start + t), end: round(sc.start + t + d), text: p });
        t += d;
      }
    }
  }
  // Let each cue linger a little (reading time) without overlapping the next one.
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1]?.start ?? timeline.total;
    cues[i].end = round(Math.min(cues[i].end + 0.35, next - 0.05, timeline.total));
  }
  return cues;
}

const vttTime = (s) => {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
};

export function toVtt(cues) {
  return 'WEBVTT\n\n' + cues.map((c, i) => `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}\n`).join('\n');
}

/** Single-quoted TS string literal (the codebase's quote style). */
const tsString = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

/** The generated transcript module; `cut` (default: the dbt cut) names its source, video and constants. */
export function toTranscriptTs(timeline, cues, cut = CUTS['']) {
  const paragraphs = timeline.scenes.map((sc) => sc.lines.map((l) => l.caption).join(' ')).filter(Boolean);
  const cueLines = cues.map((c) => `  { start: ${c.start}, end: ${c.end}, text: ${tsString(c.text)} },`);
  const regen = `\`${cutCommand(cut, 'timeline')}\``;
  return `// GENERATED by video/build-timeline.mjs from video/${cut.script} — do not edit by hand.
// Regenerate with ${regen} in video/ (see video/README.md). Pure data: no imports,
// so it is safe in both tsconfigs and the mcp-server build.

/** Caption cues for media/onboarding/${cut.mp4}, in seconds. */
export const ${cut.cues}: { start: number; end: number; text: string }[] = [
${cueLines.join('\n')}
];

/** The narration as plain text, one paragraph per scene, for the Welcome panel's Transcript. */
export const ${cut.transcript}: string = [
${paragraphs.map((p) => `  ${tsString(p)},`).join('\n')}
].join('\\n\\n');
`;
}

function mixNarration(timeline, manifest, BUILD) {
  const clips = timeline.scenes.flatMap((sc) => sc.lines.map((l) => ({ at: sc.start + l.t, file: join(HERE, manifest[l.id].file) })));
  const args = ['-v', 'error', '-y'];
  clips.forEach((c) => args.push('-i', c.file));
  const chains = clips.map((c, i) => `[${i}:a]aresample=48000,adelay=${Math.round(c.at * 1000)}:all=1[a${i}]`);
  const raw = join(BUILD, 'narration.raw.wav');
  const graph = `${chains.join(';')};${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0:duration=longest,apad=whole_dur=${timeline.total}[m]`;
  execFileSync('ffmpeg', [...args, '-filter_complex', graph, '-map', '[m]', '-ac', '1', '-ar', '48000', '-t', String(timeline.total), raw]);
  // Two-pass loudnorm (linear): measure, then apply — no pumping between lines.
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-i', raw, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const m = JSON.parse(probe.slice(probe.lastIndexOf('{'), probe.lastIndexOf('}') + 1));
  const ln = `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-af', `${ln},aresample=48000`, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', join(BUILD, 'narration.wav')]);
}

function main() {
  const cut = cutOf(process.env.VARIANT ?? '');
  const BUILD = join(HERE, cut.build);
  const script = parse(readFileSync(join(HERE, cut.script), 'utf8'));
  const mpath = join(BUILD, 'voice', 'manifest.json');
  if (!existsSync(mpath)) throw new Error(missingManifestMessage(cut));
  const manifest = Object.fromEntries(JSON.parse(readFileSync(mpath, 'utf8')).lines.map((l) => [l.id, l]));
  const durations = Object.fromEntries(Object.values(manifest).map((l) => [l.id, l.dur]));

  const timeline = buildTimeline(script, durations);
  if (timeline.total > script.maxDuration) {
    console.error(`timeline is ${timeline.total}s — over the ${script.maxDuration}s budget; shorten the narration`);
    process.exit(1);
  }
  const cues = buildCues(timeline);
  mkdirSync(BUILD, { recursive: true });
  writeFileSync(join(BUILD, 'timeline.json'), JSON.stringify({ ...timeline, cues }, null, 1));
  writeFileSync(join(HERE, cut.vtt), toVtt(cues));
  writeFileSync(join(REPO, 'src', 'types', cut.ts), toTranscriptTs(timeline, cues, cut));
  if (!process.argv.includes('--no-audio')) mixNarration(timeline, manifest, BUILD);

  for (const sc of timeline.scenes) {
    const beats = Object.entries(sc.beats).map(([k, b]) => `${k}@${b.t}`).join(' ');
    console.log(`${sc.start.toFixed(2).padStart(6)}s  ${sc.dur.toFixed(2).padStart(5)}s  ${sc.id.padEnd(9)} ${beats}`);
  }
  console.log(`total ${timeline.total}s, ${cues.length} cues`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
