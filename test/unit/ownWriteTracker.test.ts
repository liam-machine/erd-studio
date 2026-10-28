/**
 * OwnWriteTracker unit tests — own-write suppression for file watchers (H11).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CONSUMED_GRACE_MS,
  MAX_PENDING_MS,
  MAX_RECORD_AGE_MS,
  MAX_RECORDS_PER_PATH,
  OwnWriteTracker,
} from '../../src/services/ownWriteTracker';

describe('OwnWriteTracker', () => {
  let tempDir: string;
  let now: number;
  let tracker: OwnWriteTracker;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-ownwrite-'));
    now = 1_000_000;
    tracker = new OwnWriteTracker(() => now);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('matches a recorded write while the file is unchanged, then consumes it', () => {
    const file = path.join(tempDir, 'model.yml');
    fs.writeFileSync(file, 'name: a\n');
    tracker.recordWrite(file);

    expect(tracker.has(file)).toBe(true);
    expect(tracker.consume(file)).toBe(true);
    // A duplicate event for the same save, moments later, is still ours…
    now += 500;
    expect(tracker.consume(file)).toBe(true);
    // …but once the grace has passed the next event for the path is reported.
    now += CONSUMED_GRACE_MS + 1;
    expect(tracker.consume(file)).toBe(false);
  });

  it('reports an external change made right after a consumed own write', () => {
    const file = path.join(tempDir, 'model.yml');
    fs.writeFileSync(file, 'name: a\n');
    tracker.recordWrite(file);
    expect(tracker.consume(file)).toBe(true);
    fs.writeFileSync(file, 'name: b\n');
    expect(tracker.consume(file)).toBe(false);
    // The mismatch forgot the record: going back to our bytes is a change too.
    fs.writeFileSync(file, 'name: a\n');
    expect(tracker.consume(file)).toBe(false);
  });

  it('still matches after the host was busy for longer than the old 5 s TTL', () => {
    const file = path.join(tempDir, 'sales.dbdiagram');
    fs.writeFileSync(file, '{"tablePositions":[]}');
    tracker.recordWrite(file);
    now += 12_000; // the watcher's debounced callback ran 12 s after the save
    expect(tracker.consume(file)).toBe(true);
  });

  it('matches by content: same size, different bytes is an external change', () => {
    const file = path.join(tempDir, 'same-size.yml');
    fs.writeFileSync(file, 'name: a\n');
    tracker.recordWrite(file);
    fs.writeFileSync(file, 'name: b\n');
    // Keep the mtime too, as a coarse-clock file system would.
    const stat = fs.statSync(file);
    fs.utimesSync(file, stat.atime, stat.mtime);
    expect(tracker.consume(file)).toBe(false);
  });

  it('matches the latest of several writes and drops the older ones', () => {
    const file = path.join(tempDir, 'layout.dbdiagram');
    fs.writeFileSync(file, 'one');
    tracker.recordWrite(file);
    fs.writeFileSync(file, 'two!');
    tracker.recordWrite(file);
    expect(tracker.consume(file)).toBe(true);
    now += CONSUMED_GRACE_MS + 1;
    fs.writeFileSync(file, 'one');
    expect(tracker.consume(file)).toBe(false);
  });

  it('keeps at most MAX_RECORDS_PER_PATH records per path', () => {
    const file = path.join(tempDir, 'many.yml');
    for (let i = 0; i <= MAX_RECORDS_PER_PATH; i++) {
      fs.writeFileSync(file, `v${i}`);
      tracker.recordWrite(file);
    }
    fs.writeFileSync(file, 'v0');
    expect(tracker.consume(file)).toBe(false);
  });

  it('does not match when the file changed after the recorded write', () => {
    const file = path.join(tempDir, 'model.yml');
    fs.writeFileSync(file, 'name: a\n');
    tracker.recordWrite(file);

    // External edit lands before the watcher fires: different size
    fs.writeFileSync(file, 'name: a\ndescription: changed externally\n');

    expect(tracker.consume(file)).toBe(false);
  });

  it('matches a recorded delete while the file is still gone', () => {
    const file = path.join(tempDir, 'gone.json');
    tracker.recordDelete(file);
    expect(tracker.consume(file)).toBe(true);
  });

  it('does not match a recorded delete when the file reappeared', () => {
    const file = path.join(tempDir, 'back.json');
    tracker.recordDelete(file);
    fs.writeFileSync(file, '{}');
    expect(tracker.consume(file)).toBe(false);
  });

  it('drops a record no event consumed after MAX_RECORD_AGE_MS (a memory bound)', () => {
    const file = path.join(tempDir, 'old.yml');
    fs.writeFileSync(file, 'name: a\n');
    tracker.recordWrite(file);

    now += 10_000;
    expect(tracker.has(file)).toBe(true);
    now += MAX_RECORD_AGE_MS;
    expect(tracker.has(file)).toBe(false);
    expect(tracker.consume(file)).toBe(false);
  });

  describe('expected writes', () => {
    it('is pending from expectWrite until the write is recorded', () => {
      const file = path.join(tempDir, 'x.dbml');
      tracker.expectWrite([file]);
      expect(tracker.isPending(file)).toBe(true);
      fs.writeFileSync(file, 'Table x {}');
      tracker.recordWrite(file);
      expect(tracker.isPending(file)).toBe(false);
    });

    it('counts each announcement, and settleWrites clears what is left (a save that failed)', () => {
      const file = path.join(tempDir, 'y.dbml');
      tracker.expectWrite([file]);
      tracker.expectWrite([file]);
      tracker.recordWrite(file);
      expect(tracker.isPending(file)).toBe(true);
      tracker.settleWrites([file]);
      expect(tracker.isPending(file)).toBe(false);
    });

    it('stops holding a watcher back after MAX_PENDING_MS', () => {
      const file = path.join(tempDir, 'z.dbml');
      tracker.expectWrite([path.join(tempDir, '.', 'z.dbml')]);
      expect(tracker.isPending(file)).toBe(true);
      now += MAX_PENDING_MS + 1;
      expect(tracker.isPending(file)).toBe(false);
    });
  });

  it('returns false for paths never recorded', () => {
    expect(tracker.consume(path.join(tempDir, 'never.json'))).toBe(false);
  });

  it('normalises paths so equivalent spellings match', () => {
    const file = path.join(tempDir, 'model.yml');
    fs.writeFileSync(file, 'name: a\n');
    tracker.recordWrite(file);
    expect(tracker.consume(path.join(tempDir, '.', 'model.yml'))).toBe(true);
  });
});
