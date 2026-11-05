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

const ROOT = path.join(__dirname, '..', '..');

/**
 * MP3 and AAC share the `mp4a` sample entry; the esds DecoderConfigDescriptor's
 * objectTypeIndication tells them apart (0x6B = MPEG-1 audio / MP3, 0x40 = AAC).
 */
function audioObjectType(head: Buffer): number | undefined {
  const esds = head.indexOf(Buffer.from('esds'));
  if (esds < 0) return undefined;
  const dcd = head.indexOf(0x04, esds + 4 + 4 + 2); // after box type, version/flags, ES_Descriptor tag+len
  let i = dcd + 1;
  while (head[i] & 0x80) { i++; } // variable-length size field
  return head[i + 1];
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
    expect(prevEnd).toBeLessThanOrEqual(130); // the scripts' maxDuration (video/script*.yaml): "Watch the Tour" names no length
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
  it('ships exactly the two cuts, each an mp4 and a jpeg poster: no other file or folder (the per-start clips are gone)', () => {
    expect(fs.readdirSync(MEDIA).filter((f) => f !== '.DS_Store').sort()).toEqual([
      'getting-started-logical-poster.jpg',
      'getting-started-logical.mp4',
      'getting-started-poster.jpg',
      'getting-started.mp4',
    ]);
    expect(fs.existsSync(path.join(MEDIA, 'stories'))).toBe(false);
  });

  // Each check runs on whichever of the agreed files exist; the listing above requires all four.
  const present = (file: string) => fs.existsSync(path.join(MEDIA, file));

  describe.each(CUTS)('$name', (cut) => {
    it.runIf(present(cut.video))('keeps the mp4 under the 9 MiB ceiling and fast-start (moov before mdat)', () => {
      const buf = fs.readFileSync(path.join(MEDIA, cut.video));
      // 9 MiB (video/encode.sh): the recorded default cut is ~120 s of real UI, whose small text needs CRF 20
      expect(buf.length).toBeLessThanOrEqual(9 * 1024 * 1024);
      const moov = buf.indexOf('moov');
      const mdat = buf.indexOf('mdat');
      expect(moov).toBeGreaterThan(0);
      expect(moov).toBeLessThan(mdat);
    });

    it.runIf(present(cut.video))('uses MP3 audio, never AAC (VS Code documents MP3 and has no AAC decoder)', () => {
      const head = fs.readFileSync(path.join(MEDIA, cut.video)).subarray(0, 64 * 1024);
      expect(head.includes(Buffer.from('avc1'))).toBe(true);
      // MP3 and AAC share the `mp4a` sample entry: audioObjectType reads which (0x6B = MP3).
      expect(head.includes(Buffer.from('mp4a'))).toBe(true);
      expect(head.indexOf(Buffer.from('esds'))).toBeGreaterThan(0);
      expect(audioObjectType(head)).toBe(0x6b);
    });

    it.runIf(present(cut.video))('lasts the tour (50–130 s), and its last caption ends inside it', () => {
      // mvhd (version 0): size, 'mvhd', version/flags, creation, modification, timescale, duration
      const buf = fs.readFileSync(path.join(MEDIA, cut.video));
      const mvhd = buf.indexOf('mvhd');
      expect(buf[mvhd + 4]).toBe(0);
      const seconds = buf.readUInt32BE(mvhd + 20) / buf.readUInt32BE(mvhd + 16);
      expect(seconds).toBeGreaterThanOrEqual(50);
      expect(seconds).toBeLessThanOrEqual(130);
      expect(cut.cues[cut.cues.length - 1].end).toBeLessThanOrEqual(seconds);
    });

    it.runIf(present(cut.poster))('poster is a JPEG', () => {
      const buf = fs.readFileSync(path.join(MEDIA, cut.poster));
      expect(buf[0]).toBe(0xff);
      expect(buf[1]).toBe(0xd8);
    });
  });
});
