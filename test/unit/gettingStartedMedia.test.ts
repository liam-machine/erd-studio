/**
 * The getting-started video ships as two files plus a generated caption module. These checks
 * guard the shipped artefacts only — the render pipeline under video/ has its own tests and is
 * never loaded here (video/README.md).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { GETTING_STARTED_CUES, GETTING_STARTED_TRANSCRIPT } from '../../src/types/gettingStartedTranscript';

const ROOT = path.join(__dirname, '..', '..');
const MEDIA = path.join(ROOT, 'media', 'onboarding');

describe('getting-started captions', () => {
  it('has ordered, non-overlapping cues of caption size', () => {
    expect(GETTING_STARTED_CUES.length).toBeGreaterThan(10);
    let prevEnd = 0;
    for (const cue of GETTING_STARTED_CUES) {
      expect(cue.start).toBeGreaterThanOrEqual(prevEnd);
      expect(cue.end).toBeGreaterThan(cue.start);
      expect(cue.text.trim()).toBe(cue.text);
      expect(cue.text.length).toBeLessThanOrEqual(84);
      prevEnd = cue.end;
    }
    expect(prevEnd).toBeLessThanOrEqual(140); // video/script.yaml maxDuration
  });

  it('transcript carries every cue, in order', () => {
    let from = 0;
    const flat = GETTING_STARTED_TRANSCRIPT.replace(/\s+/g, ' ');
    for (const cue of GETTING_STARTED_CUES) {
      const at = flat.indexOf(cue.text, from);
      expect(at, cue.text).toBeGreaterThanOrEqual(0);
      from = at + cue.text.length;
    }
  });

  it('is pure data (safe in both tsconfigs and the mcp-server build)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'types', 'gettingStartedTranscript.ts'), 'utf8');
    expect(src).toMatch(/do not edit/);
    expect(src).not.toMatch(/^import /m);
  });
});

describe('getting-started media', () => {
  it('ships exactly the mp4 and the jpeg poster', () => {
    expect(fs.readdirSync(MEDIA).sort()).toEqual(['getting-started-poster.jpg', 'getting-started.mp4']);
  });

  it('keeps the mp4 under the 8 MB ceiling and fast-start (moov before mdat)', () => {
    const buf = fs.readFileSync(path.join(MEDIA, 'getting-started.mp4'));
    expect(buf.length).toBeLessThanOrEqual(8 * 1024 * 1024);
    const moov = buf.indexOf('moov');
    const mdat = buf.indexOf('mdat');
    expect(moov).toBeGreaterThan(0);
    expect(moov).toBeLessThan(mdat);
  });

  it('uses MP3 audio, never AAC (VS Code documents MP3 and has no AAC decoder)', () => {
    const head = fs.readFileSync(path.join(MEDIA, 'getting-started.mp4')).subarray(0, 64 * 1024);
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

  it('poster is a JPEG', () => {
    const buf = fs.readFileSync(path.join(MEDIA, 'getting-started-poster.jpg'));
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
  });
});
