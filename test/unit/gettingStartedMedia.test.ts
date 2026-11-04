/**
 * The getting-started video ships as two cuts — the dbt tour (the dbt page) and the
 * logical-first cut (the no-folder and logical pages) — each an mp4, a poster and a generated
 * caption module. These checks guard the shipped artefacts only — the render pipeline under
 * video/ has its own tests and is never loaded here (video/README.md).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { GETTING_STARTED_CUES, GETTING_STARTED_TRANSCRIPT } from '../../src/types/gettingStartedTranscript';
import {
  LOGICAL_GETTING_STARTED_CUES,
  LOGICAL_GETTING_STARTED_TRANSCRIPT,
} from '../../src/types/gettingStartedLogicalTranscript';
import { HOW_TO_CLIPS, HOW_TO_CLIP_DIR, HOW_TO_CLIP_KEYS } from '../../src/types/startActions';

const ROOT = path.join(__dirname, '..', '..');

/** The boxes of an MP4 a test needs, read from its `moov` (no ffprobe in CI). */
function readMp4(buf: Buffer): {
  faststart: boolean; codec: string; profile: number; chromaFormat: number; width: number; seconds: number; handlers: string[];
} {
  const moov = buf.indexOf('moov');
  const mdat = buf.indexOf('mdat');
  // Every lookup below is inside moov, which a fast-start file puts before mdat.
  const box = (type: string, from = moov): number => buf.indexOf(type, from) - 4; // the box's size field
  const mvhd = box('mvhd');
  const version = buf[mvhd + 8];
  const timescale = version === 1 ? buf.readUInt32BE(mvhd + 28) : buf.readUInt32BE(mvhd + 20);
  const duration = version === 1 ? Number(buf.readBigUInt64BE(mvhd + 32)) : buf.readUInt32BE(mvhd + 24);
  const handlers: string[] = [];
  for (let at = buf.indexOf('hdlr', moov); at > 0 && at < mdat; at = buf.indexOf('hdlr', at + 4)) {
    const handler = buf.toString('latin1', at + 12, at + 16);
    if (handler !== 'mdir') handlers.push(handler); // 'mdir' is udta metadata, not a track
  }
  const avc1 = box('avc1');
  const avcC = box('avcC') + 8; // its body
  let at = avcC + 5;
  const sps = buf[at] & 0x1f; at += 1;
  for (let i = 0; i < sps; i++) at += 2 + buf.readUInt16BE(at);
  const pps = buf[at]; at += 1;
  for (let i = 0; i < pps; i++) at += 2 + buf.readUInt16BE(at);
  return {
    faststart: moov > 0 && moov < mdat,
    codec: avc1 > 0 && avc1 < mdat ? 'avc1' : 'none',
    profile: buf[avcC + 1],
    chromaFormat: buf[at] & 0x03,
    width: buf.readUInt16BE(avc1 + 8 + 24),
    seconds: duration / timescale,
    handlers,
  };
}
const MEDIA = path.join(ROOT, 'media', 'onboarding');

const CUTS = [
  {
    name: 'dbt tour',
    video: 'getting-started.mp4',
    poster: 'getting-started-poster.jpg',
    module: 'gettingStartedTranscript.ts',
    cues: GETTING_STARTED_CUES,
    transcript: GETTING_STARTED_TRANSCRIPT,
  },
  {
    name: 'logical-first cut',
    video: 'getting-started-logical.mp4',
    poster: 'getting-started-logical-poster.jpg',
    module: 'gettingStartedLogicalTranscript.ts',
    cues: LOGICAL_GETTING_STARTED_CUES,
    transcript: LOGICAL_GETTING_STARTED_TRANSCRIPT,
  },
] as const;

describe.each(CUTS)('getting-started captions: $name', (cut) => {
  it('has ordered, non-overlapping cues of caption size', () => {
    expect(cut.cues.length).toBeGreaterThan(10);
    let prevEnd = 0;
    for (const cue of cut.cues) {
      expect(cue.start).toBeGreaterThanOrEqual(prevEnd);
      expect(cue.end).toBeGreaterThan(cue.start);
      expect(cue.text.trim()).toBe(cue.text);
      expect(cue.text.length).toBeLessThanOrEqual(84);
      prevEnd = cue.end;
    }
    expect(prevEnd).toBeLessThanOrEqual(65); // the script's maxDuration: the panel calls it a one-minute video
  });

  it('transcript carries every cue, in order', () => {
    let from = 0;
    const flat = cut.transcript.replace(/\s+/g, ' ');
    for (const cue of cut.cues) {
      const at = flat.indexOf(cue.text, from);
      expect(at, cue.text).toBeGreaterThanOrEqual(0);
      from = at + cue.text.length;
    }
  });

  it('is pure data (safe in both tsconfigs and the mcp-server build)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'types', cut.module), 'utf8');
    expect(src).toMatch(/do not edit/);
    expect(src).not.toMatch(/^import /m);
  });
});

describe('getting-started media', () => {
  it('ships exactly the two cuts, each an mp4 and a jpeg poster (and, optionally, the "Watch how" clips folder)', () => {
    expect(fs.readdirSync(MEDIA).filter((f) => f !== 'stories').sort()).toEqual([
      'getting-started-logical-poster.jpg',
      'getting-started-logical.mp4',
      'getting-started-poster.jpg',
      'getting-started.mp4',
    ]);
  });

  // The Welcome panel's "Watch how" clips (HOW_TO_CLIPS): onboarding stories published by
  // `node test/stories/run.mjs --record --publish` (test/stories/lib/publish.mjs). Every one
  // ships: the panel shows a clip only when its file is here, and each counts toward the VSIX's
  // 60-file cap (so no poster files: the clip's first frame is its poster).
  const STORIES = path.join(MEDIA, ...HOW_TO_CLIP_DIR.slice(2));
  const clipFiles = fs.existsSync(STORIES) ? fs.readdirSync(STORIES).filter((f) => f !== '.DS_Store') : [];
  it('the clips folder holds exactly the clips HOW_TO_CLIPS names: one per start a page leads with (Convert has none)', () => {
    expect(HOW_TO_CLIP_DIR.slice(0, 2)).toEqual(['media', 'onboarding']);
    expect([...HOW_TO_CLIP_KEYS].sort()).toEqual(['blank', 'drawFromDbt', 'example', 'importDbmlFile', 'importSemanticModel', 'importSqlDdl']);
    expect(clipFiles.sort()).toEqual(HOW_TO_CLIP_KEYS.map((k) => HOW_TO_CLIPS[k]).sort());
  });
  it.each(HOW_TO_CLIP_KEYS.map((k) => [k, HOW_TO_CLIPS[k]]))('%s (%s): H.264 High yuv420p, 1280 px wide, fast-start, silent, at most 45 s and 2 MB', (_key, file) => {
    const buf = fs.readFileSync(path.join(STORIES, file));
    const clip = readMp4(buf);
    expect(buf.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(clip.faststart).toBe(true);
    expect(clip.codec).toBe('avc1');
    expect(clip.profile).toBe(100); // High
    expect(clip.chromaFormat).toBe(1); // 4:2:0
    expect(clip.width).toBe(1280);
    expect(clip.seconds).toBeGreaterThan(10);
    expect(clip.seconds).toBeLessThanOrEqual(45.05);
    expect(clip.handlers).toEqual(['vide']); // no sound track, no subtitle track
  });

  // Each check runs on whichever of the agreed files exist; the listing above requires all four.
  const present = (file: string) => fs.existsSync(path.join(MEDIA, file));

  describe.each(CUTS)('$name', (cut) => {
    it.runIf(present(cut.video))('keeps the mp4 under the 8 MB ceiling and fast-start (moov before mdat)', () => {
      const buf = fs.readFileSync(path.join(MEDIA, cut.video));
      expect(buf.length).toBeLessThanOrEqual(8 * 1024 * 1024);
      const moov = buf.indexOf('moov');
      const mdat = buf.indexOf('mdat');
      expect(moov).toBeGreaterThan(0);
      expect(moov).toBeLessThan(mdat);
    });

    it.runIf(present(cut.video))('uses MP3 audio, never AAC (VS Code documents MP3 and has no AAC decoder)', () => {
      const head = fs.readFileSync(path.join(MEDIA, cut.video)).subarray(0, 64 * 1024);
      expect(head.includes(Buffer.from('avc1'))).toBe(true);
      // MP3 and AAC share the `mp4a` sample entry; the esds DecoderConfigDescriptor's
      // objectTypeIndication tells them apart (0x6B = MPEG-1 audio / MP3, 0x40 = AAC).
      expect(head.includes(Buffer.from('mp4a'))).toBe(true);
      const esds = head.indexOf(Buffer.from('esds'));
      expect(esds).toBeGreaterThan(0);
      const dcd = head.indexOf(0x04, esds + 4 + 4 + 2); // after box type, version/flags, ES_Descriptor tag+len
      let i = dcd + 1;
      while (head[i] & 0x80) { i++; } // variable-length size field
      expect(head[i + 1]).toBe(0x6b);
    });

    it.runIf(present(cut.poster))('poster is a JPEG', () => {
      const buf = fs.readFileSync(path.join(MEDIA, cut.poster));
      expect(buf[0]).toBe(0xff);
      expect(buf[1]).toBe(0xd8);
    });
  });
});
