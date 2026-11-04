/**
 * `node test/stories/run.mjs --publish` writes the Welcome panel's "Watch how"
 * clips from the onboarding stories (test/stories/lib/publish.mjs). These
 * checks hold it to what the extension looks for (HOW_TO_CLIPS) and to the
 * limits the clips must keep; the clips themselves are checked in
 * gettingStartedMedia.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { HOW_TO_CLIPS, HOW_TO_CLIP_DIR, HOW_TO_CLIP_KEYS } from '../../src/types/startActions';
// @ts-expect-error: a plain .mjs module of the story harness (no types).
import { AUDIO, CLIPS, CLIP_DIR, LIMITS, clipProblems, cropTitleBarFilter, leadIn, pathInCaption } from '../stories/lib/publish.mjs';

type Clip = { key: string; story: string; clip: string };
const STORIES = path.join(__dirname, '../stories/stories');

describe('publishing the "Watch how" clips', () => {
  it('publishes exactly the clips the extension looks for, where it looks', () => {
    expect((CLIPS as Clip[]).map((c) => c.key).sort()).toEqual([...HOW_TO_CLIP_KEYS].sort());
    for (const c of CLIPS as Clip[]) expect(c.clip, c.key).toBe(HOW_TO_CLIPS[c.key as keyof typeof HOW_TO_CLIPS]);
    expect(CLIP_DIR).toEqual([...HOW_TO_CLIP_DIR]);
  });

  it('each clip comes from a story that exists', () => {
    const ids = fs.readdirSync(STORIES).filter((f) => f.endsWith('.story.mjs'))
      .map((f) => /id: '([^']+)'/.exec(fs.readFileSync(path.join(STORIES, f), 'utf8'))?.[1]);
    for (const c of CLIPS as Clip[]) expect(ids, c.story).toContain(c.story);
  });

  it('keeps to the limits: 1280 px, 60 s, 2 MB, narrated in MP3 mono 44.1 kHz (never AAC)', () => {
    expect(LIMITS).toMatchObject({ width: 1280, maxSeconds: 60, maxBytes: 2 * 1024 * 1024 });
    expect(AUDIO).toEqual({ codec: 'mp3', bitrate: '64k', channels: 1, sampleRate: 44100 });
    const good = { codec: 'h264', profile: 'High', pixFmt: 'yuv420p', width: 1280, audio: true, audioCodec: 'mp3', sampleRate: 44100, channels: 1, streams: 2, faststart: true, seconds: 58.5, bytes: 1_800_000 };
    expect(clipProblems(good)).toEqual([]);
    expect(clipProblems({ ...good, pixFmt: 'yuvj420p', seconds: 61, bytes: 3 * 1024 * 1024, faststart: false, profile: 'Main' })).toHaveLength(5);
    expect(clipProblems({ ...good, audio: false, audioCodec: undefined, streams: 1 })).toEqual(['has no narration (record it with --narrate)', '1 tracks, not a video and its narration']);
    expect(clipProblems({ ...good, audioCodec: 'aac' })).toEqual(['audio is aac 44100 Hz 1 ch, not MP3 44.1 kHz mono']);
  });

  it('starts on the story\'s title card (the poster) and crops the dev-host title bar off', () => {
    expect(leadIn('1\n00:00:00,190 --> 00:00:04,190\nImport a database\n\n2\n00:00:04,190 --> 00:00:06,700\nGiven…')).toBeCloseTo(0.19);
    expect(leadIn('1\n00:01:02.500 --> 00:01:04,000\nx')).toBeCloseTo(62.5);
    expect(leadIn('')).toBe(0);
    expect(cropTitleBarFilter()).toBe('crop=iw:ih-trunc(ih*35/900/2)*2:0:trunc(ih*35/900/2)*2');
  });

  it('refuses a caption that names a path on the recording machine', () => {
    expect(pathInCaption('I pick "Medallion lakehouse" and save it in my Projects folder', '/tmp/erds-ab12/home')).toBeUndefined();
    expect(pathInCaption('Saved in /tmp/erds-ab12/home/shop', '/tmp/erds-ab12/home')).toBeTruthy();
    expect(pathInCaption('Open /Users/someone/project', '/x')).toBe('/Users/');
  });
});
