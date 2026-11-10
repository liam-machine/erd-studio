/**
 * The example projects in docs/examples/ (one per modelling pattern, explained
 * in docs/modelling-patterns.md) are what a reader copies, so each must be a
 * clean DBML project: doctor finds nothing to fix, every file is in the
 * canonical layout, every diagram draws exactly the relationships its files
 * hold, and the folder tree in its README is the one on disk.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatDbml } from '@erd-studio/core/dbml';
import { FIELDS_FILE_NAME, parseFieldsText } from '@erd-studio/core';
import Ajv from 'ajv';
import { parse as parseYaml } from 'yaml';

import { runDoctor } from '../../src/cli/doctor';
import { buildCliContext } from '../../src/cli/context';
import { runExportAll } from '../../src/cli/export';

const REPO = path.resolve(__dirname, '../..');
const EXAMPLES = path.join(REPO, 'docs', 'examples');
const SEMANTIC_DIR = '.erd-studio';

const examples = fs.readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(EXAMPLES, e.name, SEMANTIC_DIR)))
  .map((e) => e.name)
  .sort();

/** Every file under `dir`, relative to it, posix. */
function filesUnder(dir: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? filesUnder(dir, p) : [p];
  });
}

/** The README's tree: README.md, layers.json and fields.yml first, layers in layers.json order, then tables, relationships, diagrams. */
function expectedTree(semantic: string): string {
  const layers = (JSON.parse(fs.readFileSync(path.join(semantic, 'layers.json'), 'utf-8')) as { layers: Array<{ id: string }> }).layers.map((l) => l.id);
  const order = (dir: string, names: string[]): string[] => {
    if (dir === semantic) {
      return [...['README.md', 'layers.json', FIELDS_FILE_NAME, 'modelling-approach.md'].filter((n) => names.includes(n)), ...layers.filter((id) => names.includes(id))];
    }
    if (layers.some((id) => path.join(semantic, id) === dir)) return ['tables', 'relationships', 'diagrams'].filter((n) => names.includes(n));
    return [...names].sort();
  };
  const out = [`${SEMANTIC_DIR}/`];
  const walk = (dir: string, prefix: string): void => {
    const entries = order(dir, fs.readdirSync(dir));
    entries.forEach((name, i) => {
      const last = i === entries.length - 1;
      const full = path.join(dir, name);
      const isDir = fs.statSync(full).isDirectory();
      out.push(`${prefix}${last ? '└── ' : '├── '}${name}${isDir ? '/' : ''}`);
      if (isDir) walk(full, prefix + (last ? '    ' : '│   '));
    });
  };
  walk(semantic, '');
  return out.join('\n');
}

/** The two table names a Ref line joins (`Ref role: s.a.col >? s.b.(x, y)`). */
function refTables(line: string): [string, string] | null {
  const end = String.raw`[\w"]+\.([\w"]+)\.(?:\([^)]*\)|[\w"]+)`;
  const m = new RegExp(String.raw`^Ref[^:]*:\s*${end}\s+\S+\s+${end}\s*$`).exec(line.trim());
  return m ? [m[1].replace(/"/g, ''), m[2].replace(/"/g, '')] : null;
}

let home: string;
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-doc-examples-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the example projects in docs/examples', () => {
  it('include one project with a fields.yml, so the field list is part of the corpus', () => {
    expect(examples.filter((name) => fs.existsSync(path.join(EXAMPLES, name, SEMANTIC_DIR, FIELDS_FILE_NAME)))).toEqual(['data-mesh']);
  });

  it('spell every field the way ERD Studio writes a new one: no rationale_ or meta_ prefix (meta_ only for a key a built-in shadows)', () => {
    const old: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.dbml')) {
          for (const m of fs.readFileSync(full, 'utf-8').matchAll(/\b((?:erd_)?(?:rationale|meta)_[a-z0-9_]+)\s*:/g)) {
            // meta_retention: a metadata key named like the built-in Retention keeps its prefix, so it never reads as that field.
            if (m[1] !== 'meta_retention') old.push(`${path.relative(EXAMPLES, full)}: ${m[1]}`);
          }
        }
      }
    };
    walk(EXAMPLES);
    expect(old).toEqual([]);
  });

  it('are all listed in the examples index and the modelling patterns guide', () => {
    expect(examples.length).toBeGreaterThanOrEqual(7);
    const index = fs.readFileSync(path.join(EXAMPLES, 'README.md'), 'utf-8');
    const guide = fs.readFileSync(path.join(REPO, 'docs', 'modelling-patterns.md'), 'utf-8');
    for (const name of examples) {
      expect(index, name).toContain(`](${name}/)`);
      expect(guide, name).toContain(`](examples/${name}/)`);
    }
  });

  describe.each(examples)('%s', (name) => {
    const root = path.join(EXAMPLES, name);
    const semantic = path.join(root, SEMANTIC_DIR);

    it('is a DBML project doctor finds nothing to fix in', async () => {
      const result = await runDoctor({ project: root, semanticDir: SEMANTIC_DIR, noDbt: true, env: { PATH: '' }, homeDir: home });
      expect(result.erd.storage).toBe('dbml');
      expect(result.erd.dbmlProblems).toEqual([]);
      expect(result.nextSteps.map((s) => s.id)).toEqual(['ready']);
    });

    it('has every .dbml file in the canonical layout', () => {
      const off = filesUnder(semantic).filter((f) => f.endsWith('.dbml')).filter((f) => {
        const r = formatDbml(fs.readFileSync(path.join(semantic, f), 'utf-8'));
        return r.skipped !== undefined || r.changed;
      });
      expect(off).toEqual([]);
    });

    it('draws every diagram with exactly the tables and relationships its files hold', async () => {
      const ctx = await buildCliContext({ project: root, semanticDir: SEMANTIC_DIR });
      const exported = await runExportAll(ctx, { format: 'dbml-rich' });
      expect(exported.skipped).toEqual([]);
      const diagrams = filesUnder(semantic).filter((f) => /^[^/]+\/diagrams\/[^/]+\.dbml$/.test(f));
      expect(exported.files.map((f) => f.domain).sort()).toEqual(diagrams.map((d) => `${SEMANTIC_DIR}/${d}`).sort());
      for (const file of exported.files) {
        const diagramPath = path.join(root, file.domain);
        const text = fs.readFileSync(diagramPath, 'utf-8');
        const members = new Set([...text.matchAll(/^use \{ table [\w"]+\.([\w"]+) \}/gm)].map((m) => m[1].replace(/"/g, '')));
        const imports = [...text.matchAll(/^use \* from '([^']+)'/gm)].map((m) => path.resolve(path.dirname(diagramPath), m[1]));
        const held = imports.flatMap((p) => fs.readFileSync(p, 'utf-8').split('\n').map(refTables))
          .filter((r): r is [string, string] => r !== null && members.has(r[0]) && members.has(r[1]));
        const drawnTables = file.content.split('\n').filter((l) => /^Table /.test(l)).length;
        const drawnRefs = file.content.split('\n').filter((l) => /^Ref\b/.test(l)).length;
        expect({ diagram: file.domain, tables: drawnTables, refs: drawnRefs }).toEqual({ diagram: file.domain, tables: members.size, refs: held.length });
        expect(held.length + members.size, file.domain).toBeGreaterThan(0);
      }
    });

    it('stores a position for every table on every diagram, so opening one writes nothing', () => {
      // A diagram with a table that has no position is laid out and saved the first time it is
      // opened, which would leave a change in a reader's clone just from looking at the example.
      const unplaced: string[] = [];
      for (const d of filesUnder(semantic).filter((f) => /^[^/]+\/diagrams\/[^/]+\.dbml$/.test(f))) {
        const text = fs.readFileSync(path.join(semantic, d), 'utf-8');
        const members = [...text.matchAll(/^use \{ table [\w"]+\.([\w"]+) \}/gm)].map((m) => m[1].replace(/"/g, ''));
        const layout = /erd_layout:\s*'''([\s\S]*?)'''/.exec(text)?.[1] ?? '';
        // `<name> <x> <y>` per table (sticky notes are `note/<id> …`): the name is everything before the two numbers.
        const placed = new Set(layout.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('note/'))
          .map((l) => l.replace(/\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?$/, '')));
        for (const m of members) if (!placed.has(m)) unplaced.push(`${d}: ${m}`);
      }
      expect(unplaced).toEqual([]);
    });

    it('has a fields.yml, if any, that reads with no problem and validates against its schema', () => {
      const file = path.join(semantic, FIELDS_FILE_NAME);
      if (!fs.existsSync(file)) return;
      const text = fs.readFileSync(file, 'utf-8');
      expect(parseFieldsText(text).problems).toEqual([]);
      const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas', 'fields.schema.json'), 'utf-8'));
      const ajv = new Ajv({ allErrors: true });
      ajv.addKeyword('enumDescriptions');
      const validate = ajv.compile(schema);
      expect(validate(parseYaml(text)), JSON.stringify(validate.errors)).toBe(true);
    });

    it('shows the files on disk in its README tree', () => {
      const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf-8');
      const block = /```text\n(\.erd-studio\/\n[\s\S]*?)\n```/.exec(readme);
      expect(block, 'a ```text block starting .erd-studio/').not.toBeNull();
      expect(block![1]).toBe(expectedTree(semantic));
    });
  });
});
