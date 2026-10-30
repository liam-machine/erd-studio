/**
 * The background read of the table library (`LibraryWarmUp`): it reads every
 * unread table file a slice at a time, giving the event loop back between
 * slices (the host never blocks for long), steps aside while foreground
 * work runs, works out the relationships once at the end, and stops when
 * disposed. Against a real library, the next open of a diagram finds its
 * tables read.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LibraryWarmUp, yieldToEventLoop } from '../../src/services/libraryWarmUp';
import { TableLibraryService } from '../../src/services/logicalModelService';

/** A fake library whose every read advances a fake clock by `costMs`. */
function fakeLibrary(count: number, clock: { t: number }, costMs = 1) {
  const unread = Array.from({ length: count }, (_, i) => `t${i}`);
  const read: string[] = [];
  let attached = 0;
  return {
    read,
    attached: () => attached,
    unreadTableFiles: () => unread.filter((n) => !read.includes(n)),
    warmTableFile: (name: string) => { read.push(name); clock.t += costMs; },
    warmLibraryAttachment: () => { attached++; },
  };
}

describe('LibraryWarmUp', () => {
  it('reads every unread file in slices no longer than the slice budget, then attaches once', async () => {
    const clock = { t: 0 };
    const library = fakeLibrary(100, clock, 1);
    const warmUp = new LibraryWarmUp(library, { sliceMs: 10, quietMs: 50, now: () => clock.t });
    expect(await warmUp.start(0)).toBe('done');
    expect(library.read).toHaveLength(100);
    expect(warmUp.filesRead).toBe(100);
    // 10 ms of reads per slice at 1 ms a file: 10 slices.
    expect(warmUp.slices).toBe(10);
    expect(library.attached()).toBe(1);
  });

  it('reads each relationships file in a slice of its own, before the attach', async () => {
    const clock = { t: 0 };
    const order: string[] = [];
    const library = {
      ...fakeLibrary(4, clock, 1),
      listRelationshipsFiles: () => ['gold/relationships/gold.dbml', 'silver/relationships/silver.dbml'],
      readRelationshipsFile: (file: string) => { order.push(file); clock.t += 50; },
      warmLibraryAttachment: () => { order.push('attach'); },
    };
    const warmUp = new LibraryWarmUp(library, { sliceMs: 10, quietMs: 0, now: () => clock.t });
    await warmUp.start(0);
    expect(order).toEqual(['gold/relationships/gold.dbml', 'silver/relationships/silver.dbml', 'attach']);
    // One slice of table files, then one per relationships file.
    expect(warmUp.slices).toBe(3);
  });

  it('a slice always reads at least one file, however slow', async () => {
    const clock = { t: 0 };
    const library = fakeLibrary(3, clock, 100);
    const warmUp = new LibraryWarmUp(library, { sliceMs: 10, quietMs: 50, now: () => clock.t });
    await warmUp.start(0);
    expect(warmUp.slices).toBe(3);
  });

  it('steps aside while foreground work is noted, and carries on once the host has been quiet', async () => {
    const clock = { t: 0 };
    const library = fakeLibrary(40, clock, 0);
    const firstReadAt: number[] = [];
    const warmTableFile = library.warmTableFile;
    library.warmTableFile = (name: string) => { if (firstReadAt.length === 0) firstReadAt.push(performance.now()); warmTableFile(name); };
    const warmUp = new LibraryWarmUp(library, { sliceMs: 5, quietMs: 80 });
    const noted = performance.now();
    warmUp.noteForegroundWork();
    const done = warmUp.start(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(library.read).toHaveLength(0);
    // More foreground work pushes it back again.
    warmUp.noteForegroundWork();
    const notedAgain = performance.now();
    expect(await done).toBe('done');
    expect(library.read).toHaveLength(40);
    expect(firstReadAt[0] - notedAgain).toBeGreaterThanOrEqual(70);
    expect(firstReadAt[0] - noted).toBeGreaterThanOrEqual(100);
  });

  it('dispose stops it at the next slice', async () => {
    const clock = { t: 0 };
    const library = fakeLibrary(1000, clock, 1);
    const warmUp = new LibraryWarmUp(library, { sliceMs: 5, quietMs: 0, now: () => clock.t });
    const done = warmUp.start(0);
    await yieldToEventLoop();
    await yieldToEventLoop();
    warmUp.dispose();
    expect(await done).toBe('cancelled');
    expect(library.read.length).toBeLessThan(1000);
    expect(library.attached()).toBe(0);
  });

  it('start twice is one pass', async () => {
    const clock = { t: 0 };
    const library = fakeLibrary(5, clock);
    const warmUp = new LibraryWarmUp(library, { now: () => clock.t });
    const a = warmUp.start(0);
    const b = warmUp.start(0);
    expect(a).toBe(b);
    await a;
    expect(library.read).toHaveLength(5);
  });
});

describe('LibraryWarmUp over a real library', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-warm-up-'));
    const tables = path.join(root, '.erd-studio', 'gold', 'tables', 'gold');
    const relationships = path.join(root, '.erd-studio', 'gold', 'relationships');
    fs.mkdirSync(tables, { recursive: true });
    fs.mkdirSync(relationships, { recursive: true });
    const refs: string[] = [];
    for (let i = 0; i < 300; i++) {
      fs.writeFileSync(path.join(tables, `t${i}.dbml`), `Table gold.t${i} {\n  id INT [pk]\n  parent_id INT\n  name VARCHAR [note: 'Table ${i}']\n}\n`);
      if (i > 0) refs.push(`Ref: gold.t${i}.parent_id > gold.t${i - 1}.id`);
    }
    fs.writeFileSync(path.join(relationships, 'gold.dbml'), `// ERD Studio relationships: Refs only.\n${refs.join('\n')}\n`);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads every table file without blocking the event loop for long, and the next read finds them read', async () => {
    const library = new TableLibraryService(root, '.erd-studio');
    expect(library.unreadTableFiles()).toHaveLength(300);
    const warmUp = new LibraryWarmUp(library, { sliceMs: 8, quietMs: 0 });
    // The longest gap between ticks of a 1 ms timer while it runs.
    let last = performance.now();
    let longest = 0;
    const tick = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 1);
    const outcome = await warmUp.start(0);
    clearInterval(tick);
    expect(outcome).toBe('done');
    expect(library.unreadTableFiles()).toHaveLength(0);
    expect(warmUp.slices).toBeGreaterThan(1);
    // A slice is 8 ms of reads (plus one file and the final attach); generous for a loaded CI machine.
    expect(longest).toBeLessThan(250);
    // The relationships were worked out too: a table's read attaches from the memo.
    expect(library.getTable('t5')?.relationships).toEqual([
      expect.objectContaining({ fromColumn: 'parent_id', toModel: 't4', toColumn: 'id' }),
    ]);
  });

  it('a file changed after it was read is read again by whoever needs it', async () => {
    const library = new TableLibraryService(root, '.erd-studio');
    await new LibraryWarmUp(library, { quietMs: 0 }).start(0);
    const file = path.join(root, '.erd-studio', 'gold', 'tables', 'gold', 't7.dbml');
    fs.writeFileSync(file, 'Table gold.t7 {\n  id INT [pk]\n  parent_id INT\n  extra INT\n}\n');
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
    expect(library.unreadTableFiles().map((e) => e.name)).toEqual(['t7']);
    expect(library.getTable('t7')?.columns.map((c) => c.name)).toEqual(['id', 'parent_id', 'extra']);
  });
});
