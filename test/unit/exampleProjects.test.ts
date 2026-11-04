/**
 * The example projects bundled for Open an Example Project…
 * (`__ERD_EXAMPLES__`, read by scripts/exampleBundle.cjs for esbuild.js and
 * vitest.config.ts): the bundle is exactly docs/examples on disk, the catalog
 * matches it, it stays small, and the new window's hand-off
 * (`takePendingExample`) opens only a fresh record for its own folder.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  EXAMPLE_PROJECTS,
  PENDING_EXAMPLE_OPEN_KEY,
  PENDING_EXAMPLE_TTL_MS,
  availableExampleProjects,
  bundledExampleIds,
  exampleFiles,
  exampleProject,
  takePendingExample,
} from '../../src/services/exampleProjects';
import { FEATURES } from '../../src/services/telemetryPayload';

const EXAMPLES = path.resolve(__dirname, '../../docs/examples');

const onDisk = fs.readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(EXAMPLES, e.name, '.erd-studio')))
  .map((e) => e.name)
  .sort();

/** Every file under `dir`, relative to it, posix (dotfiles included, OS junk not). */
function filesUnder(dir: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    if (e.name === '.DS_Store') return [];
    const p = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? filesUnder(dir, p) : [p];
  });
}

describe('the bundled example projects', () => {
  it('are exactly the example folders in docs/examples', () => {
    expect(onDisk.length).toBeGreaterThanOrEqual(8);
    expect(bundledExampleIds()).toEqual(onDisk);
  });

  it.each(onDisk)('%s: the same files, byte for byte, as on disk', (id) => {
    const files = exampleFiles(id);
    const root = path.join(EXAMPLES, id);
    expect(Object.keys(files).sort()).toEqual(filesUnder(root).sort());
    for (const [rel, text] of Object.entries(files)) {
      expect(Buffer.from(text, 'utf-8').equals(fs.readFileSync(path.join(root, ...rel.split('/')))), rel).toBe(true);
    }
    expect(files['.erd-studio/layers.json']).toBeDefined();
    expect(files['README.md']).toBeDefined();
  });

  it('includes dotfolders: enterprise-warehouse keeps its .github/CODEOWNERS', () => {
    expect(exampleFiles('enterprise-warehouse')['.github/CODEOWNERS']).toBeDefined();
  });

  it('stays small: under 400 KB in all', () => {
    const bytes = bundledExampleIds()
      .flatMap((id) => Object.entries(exampleFiles(id)))
      .reduce((n, [rel, text]) => n + Buffer.byteLength(rel) + Buffer.byteLength(text), 0);
    expect(bytes).toBeLessThan(400 * 1024);
  });

  it('gives nothing for an id that is not bundled', () => {
    expect(exampleFiles('no-such-example')).toEqual({});
    expect(exampleFiles('__proto__')).toEqual({});
  });
});

describe('the catalog', () => {
  it('lists every example once, enterprise-warehouse first and marked as the place to start', () => {
    expect(EXAMPLE_PROJECTS.map((e) => e.id).sort()).toEqual(onDisk);
    expect(EXAMPLE_PROJECTS[0].id).toBe('enterprise-warehouse');
    expect(EXAMPLE_PROJECTS.filter((e) => e.recommended).map((e) => e.id)).toEqual(['enterprise-warehouse']);
    expect(availableExampleProjects()).toEqual(EXAMPLE_PROJECTS);
    expect(exampleProject('medallion')?.feature).toBe('exampleMedallion');
  });

  it('then follows the examples index table', () => {
    const index = fs.readFileSync(path.join(EXAMPLES, 'README.md'), 'utf-8');
    const tableOrder = [...index.matchAll(/^\| \[([\w-]+)\]\(/gm)].map((m) => m[1]).filter((id) => id !== 'enterprise-warehouse');
    expect(EXAMPLE_PROJECTS.slice(1).map((e) => e.id)).toEqual(tableOrder);
  });

  it('counts each example under its own telemetry key', () => {
    const keys = EXAMPLE_PROJECTS.map((e) => e.feature);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(FEATURES).toContain(key);
  });

  it.each(EXAMPLE_PROJECTS.map((e) => [e.id, e] as const))('%s: its start diagram is one of its diagrams', (id, example) => {
    expect(example.startDiagram).toMatch(/^\.erd-studio\/[\w-]+\/diagrams\/[\w-]+\.dbml$/);
    expect(exampleFiles(id)[example.startDiagram]).toBeDefined();
  });

  it.each(EXAMPLE_PROJECTS.map((e) => [e.id, e] as const))('%s: the description is its layers, in order', (id, example) => {
    const layers = (JSON.parse(exampleFiles(id)['.erd-studio/layers.json']) as { layers: Array<{ label: string }> }).layers;
    expect(example.description).toBe(layers.map((l) => l.label).join(', '));
  });

  it('enterprise-warehouse starts on the diagram its walkthrough opens first', () => {
    const readme = exampleFiles('enterprise-warehouse')['README.md'];
    const firstOpen = /Open \*\*Landing → ([\w-]+)\*\*/.exec(readme);
    expect(firstOpen?.[1]).toBe('source-systems');
    expect(exampleProject('enterprise-warehouse')?.startDiagram).toBe('.erd-studio/landing/diagrams/source-systems.dbml');
  });

  it('says no dbt word, never "an open standard", and "diagram" rather than "subject area"', () => {
    for (const e of EXAMPLE_PROJECTS) {
      for (const text of [e.label, e.description, e.detail]) {
        expect(text, e.id).not.toMatch(/\bdbt(?:\b|_)/i);
        expect(text, e.id).not.toMatch(/open standard/i);
        expect(text, e.id).not.toMatch(/subject\s+area/i);
      }
    }
  });
});

describe('takePendingExample', () => {
  const now = 1_800_000_000_000;
  const record = { folder: '/Users/me/examples/medallion', diagram: '.erd-studio/gold/diagrams/sales.dbml', at: now - 5_000 };

  it('uses the key erdStudio.pendingExampleOpen', () => {
    expect(PENDING_EXAMPLE_OPEN_KEY).toBe('erdStudio.pendingExampleOpen');
  });

  it('gives the absolute diagram path for a fresh record of this folder', () => {
    expect(takePendingExample(record, '/Users/me/examples/medallion', now, 'linux'))
      .toBe('/Users/me/examples/medallion/.erd-studio/gold/diagrams/sales.dbml');
    // A trailing separator on either side is the same folder.
    expect(takePendingExample({ ...record, folder: '/Users/me/examples/medallion/' }, '/Users/me/examples/medallion', now, 'linux'))
      .toBe('/Users/me/examples/medallion/.erd-studio/gold/diagrams/sales.dbml');
  });

  it('compares case-insensitively where the file system does', () => {
    expect(takePendingExample(record, '/users/ME/examples/Medallion', now, 'darwin')).toBeDefined();
    expect(takePendingExample(record, '/users/ME/examples/Medallion', now, 'linux')).toBeUndefined();
    expect(takePendingExample(
      { ...record, folder: 'C:\\Users\\me\\medallion' },
      'c:\\users\\me\\medallion',
      now,
      'win32',
    )).toBe('c:\\users\\me\\medallion\\.erd-studio\\gold\\diagrams\\sales.dbml');
  });

  it('ignores a record for another folder', () => {
    expect(takePendingExample(record, '/Users/me/examples/data-vault', now, 'linux')).toBeUndefined();
    expect(takePendingExample(record, '/Users/me/examples', now, 'linux')).toBeUndefined();
    expect(takePendingExample(record, '', now, 'linux')).toBeUndefined();
  });

  it('ignores a stale record (ten minutes or older) and one from the future', () => {
    expect(takePendingExample({ ...record, at: now - PENDING_EXAMPLE_TTL_MS + 1 }, record.folder, now, 'linux')).toBeDefined();
    expect(takePendingExample({ ...record, at: now - PENDING_EXAMPLE_TTL_MS }, record.folder, now, 'linux')).toBeUndefined();
    expect(takePendingExample({ ...record, at: now + 5 * 60_000 }, record.folder, now, 'linux')).toBeUndefined();
  });

  it('ignores a malformed record', () => {
    for (const bad of [
      undefined, null, 'x', 42, [], {},
      { ...record, folder: 1 },
      { ...record, folder: '' },
      { ...record, diagram: undefined },
      { ...record, at: '1' },
      { ...record, at: Number.NaN },
      { ...record, diagram: '../outside.dbml' },
      { ...record, diagram: '.erd-studio/../../x.dbml' },
      { ...record, diagram: '/etc/passwd' },
      { ...record, diagram: 'C:/x.dbml' },
      { ...record, diagram: '.erd-studio\\gold\\x.dbml' },
      { ...record, diagram: '' },
    ]) {
      expect(takePendingExample(bad, record.folder, now, 'linux'), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('the example descriptions read plainly', () => {
  it('say what you will see in a sentence or two, without modelling jargon', () => {
    const JARGON = /\b(Inmon|PIT|conformed|role-playing|CODEOWNERS|normali[sz]ed|composite|satellites?|hubs?|fact types?|warehouse name|dataset suffix|marts?)\b/i;
    for (const e of EXAMPLE_PROJECTS) {
      expect(e.detail, e.id).not.toMatch(JARGON);
      expect(e.detail.split(/\s+/).length, e.id).toBeLessThanOrEqual(26);
    }
  });
});
