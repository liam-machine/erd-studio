/**
 * OwnWriteTracker unit tests — own-write suppression for file watchers (H11).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { OwnWriteTracker } from '../../src/services/ownWriteTracker';

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
    // Consumed — a second event for the same path is external
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

  it('expires records after the TTL', () => {
    const file = path.join(tempDir, 'old.yml');
    fs.writeFileSync(file, 'name: a\n');
    tracker.recordWrite(file);

    now += 10_000;
    expect(tracker.has(file)).toBe(false);
    expect(tracker.consume(file)).toBe(false);
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
