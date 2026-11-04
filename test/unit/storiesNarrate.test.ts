/**
 * `node test/stories/run.mjs --record --narrate` speaks each story's captions
 * (test/stories/lib/narrate.mjs). The voice itself needs uv and Kokoro and is
 * never run here; these checks hold the pure parts: what a caption says, and
 * where each line goes on the video's timeline (a frame held, never a voice
 * overlapped or sped up).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error: a plain .mjs module of the story harness (no types).
import { TIMING, VOICE, frameDurations, lineFor, planNarration, readWav, spoken, writeWav } from '../stories/lib/narrate.mjs';

type Line = { text: string; start: number; seconds: number };

describe('story narration', () => {
  it('uses the getting-started tour\'s voice (video/script.yaml)', () => {
    const script = fs.readFileSync(path.join(__dirname, '../../video/script.yaml'), 'utf8');
    expect(script).toMatch(new RegExp(`kokoro: ${VOICE.voice}\\b`));
    expect(script).toMatch(new RegExp(`speed: ${VOICE.speed}\\b`));
  });

  it('reads a caption the way a person would say it', () => {
    expect(spoken('Then I see "Open an example" in the empty Diagrams view')).toBe('Then I see Open an example in the empty Diagrams view.');
    expect(spoken('And the ERD Studio sidebar leads with "Convert to DBML…"')).toBe('And the ERD Studio sidebar leads with Convert to DBML.');
    expect(spoken('When I open the ERD Studio sidebar and press its ▶ button')).toBe('When I open the ERD Studio sidebar and press its play button.');
    expect(spoken('And it shows my design (Logical) beside what dbt built (Physical)')).toBe('And it shows my design, Logical, beside what dbt built, Physical.');
    expect(spoken('Done?')).toBe('Done?');
  });

  it('a step\'s say wins (empty: silent); the title card says the title; Done says done', () => {
    expect(lineFor({ kind: 'step', text: 'And it is its own file under .erd-studio/', say: 'And it is saved as its own file.' })).toBe('And it is saved as its own file.');
    expect(lineFor({ kind: 'step', text: 'Given a folder', say: '' })).toBe('');
    expect(lineFor({ kind: 'intro', text: 'Draw my dbt project\nAs an analytics engineer,\n…' })).toBe('Draw my dbt project.');
    expect(lineFor({ kind: 'pass', text: 'Done: Draw my dbt project' })).toBe('Done.');
  });

  it('holds the frame before the next caption for as long as a line runs over, and moves everything after it', () => {
    const T = 1_000_000;
    const frames = Array.from({ length: 100 }, (_, i) => ({ t: T + i * 100 })); // 10 s of frames
    const marks = [
      { t: T, text: 'Title\nAs …', kind: 'intro' },
      { t: T + 2000, text: 'A long line', kind: 'step' },
      { t: T + 3000, text: 'Short', kind: 'step' },
    ];
    const voiced = new Map([['Title.', { file: 't.wav', seconds: 1 }], ['A long line.', { file: 'l.wav', seconds: 4 }], ['Short.', { file: 's.wav', seconds: 0.5 }]]);
    const plan = planNarration({ marks, frames, tEnd: T + 10_000, voiced });
    const need = TIMING.lead + 4 + TIMING.gap; // the long line, in a 1 s window
    expect(plan.holds).toEqual([{ at: T + 3000, seconds: expect.closeTo(need - 1, 5) }]);
    expect(plan.lines.map((l: Line) => l.text)).toEqual(['Title.', 'A long line.', 'Short.']);
    expect(plan.lines[1].start).toBeCloseTo(2 + TIMING.lead);
    // The next line waits for the long one to finish (and its gap).
    expect(plan.lines[2].start).toBeCloseTo(plan.lines[1].start + 4 + TIMING.gap + TIMING.lead);
    expect(plan.seconds).toBeCloseTo(10 + need - 1);
    // The hold extends the one frame shown just before the next caption.
    const d = frameDurations(frames, T + 10_000, plan.holds);
    expect(d[29]).toBeCloseTo(0.1 + need - 1);
    expect(d.filter((x: number) => x > 0.11)).toHaveLength(1);
    expect(d.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(plan.seconds);
  });

  it('writes and reads back a 16-bit mono WAV', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'narr-')), 'x.wav');
    writeWav(file, Float32Array.from([0, 0.5, -0.5, 1]), 24000);
    const { rate, samples } = readWav(file);
    expect(rate).toBe(24000);
    expect([...samples].map((x) => Math.round(x * 100) / 100)).toEqual([0, 0.5, -0.5, 1]);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});
