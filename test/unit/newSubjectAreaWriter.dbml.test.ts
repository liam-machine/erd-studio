/**
 * writeNewSubjectArea with DBML library tables behind a JSON diagram (2.0
 * design §2.6): the DBML tables, new and changed, are saved as ONE batch
 * (one plan, one settle, one all-or-nothing write), so a refusal writes
 * nothing, and a later failure puts back every file the batch wrote (or
 * removes one it created), not only the table files.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeNewSubjectArea } from '../../src/services/newSubjectAreaWriter';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { semanticReadmeText } from '../../src/services/semanticReadme';
import type { FileWriteIo } from '../../src/services/fsFileWrites';
import type { SemanticTable } from '../../src/types/semantic';

let root: string;
const at = (rel: string): string => path.join(root, '.erd-studio', rel);
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text);
};

/** Every file under the semantic dir, relative path → text. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out[path.relative(path.join(root, '.erd-studio'), abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf-8');
    }
  };
  walk(path.join(root, '.erd-studio'));
  return out;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-new-sa-dbml-'));
  write('layers.json', `${JSON.stringify({ layers: [{ id: 'gold', label: 'Gold' }] }, null, 2)}\n`);
  write('gold/tables/gold/dim_date.dbml', 'Table gold.dim_date {\n  date_key INT [pk]\n}\n');
  write('gold/tables/gold/fct_x.dbml', 'Table gold.fct_x {\n  id INT [pk]\n  date_key INT\n}\n');
  write('logical-models/dim_yaml.yml', 'name: dim_yaml\ncolumns:\n  - name: id\n    dataType: INT\n');
  write('gold/tables/gold/fct_z.dbml', 'Table gold.fct_z {\n  id INT [pk]\n  yaml_id INT\n}\n');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const documentText = (): string => `${JSON.stringify({ schemaVersion: 5, domain: 'new', layer: 'gold', logical: { models: ['fct_x', 'fct_z'], relationships: [] }, viewConfig: {} }, null, 2)}\n`;

/** fct_x gains a relationship; fct_z one to a YAML table (D20), unless `refused` is false. */
async function writeNew(tables: TableLibraryService, refused = true): Promise<Awaited<ReturnType<typeof writeNewSubjectArea>>> {
  const fctX: SemanticTable = { ...tables.getTable('fct_x')!, relationships: [{ fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' }] };
  const fctZ: SemanticTable = refused
    ? { ...tables.getTable('fct_z')!, relationships: [{ fromColumn: 'yaml_id', toModel: 'dim_yaml', toColumn: 'id', cardinality: 'many-to-one' }] }
    : { ...tables.getTable('fct_z')!, description: 'Z' };
  return writeNewSubjectArea({
    workspaceRoot: root,
    semanticDir: '.erd-studio',
    domainPath: at('gold/new.json'),
    newTables: [{ name: 'dim_new', columns: [{ name: 'id', dataType: 'INT', description: '' }] }],
    changedTables: [fctX, fctZ],
    folder: 'gold',
    documentText,
  }, { layerService: new LayerService(root, '.erd-studio'), tableLibraryService: tables });
}

describe('writeNewSubjectArea saves the DBML tables as one batch', () => {
  it('a refusal anywhere in the batch (D20) writes nothing: no table, no relationships file, no diagram', async () => {
    const before = snapshot();
    const result = await writeNew(new TableLibraryService(root, '.erd-studio'));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.undone).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  it('one plan and one settle for every DBML table, new and changed', async () => {
    const tables = new TableLibraryService(root, '.erd-studio');
    const batch = vi.spyOn(tables, 'applyDbmlBatch');
    const listing = vi.spyOn(tables, 'listDbmlDiagrams');
    const result = await writeNew(tables, false);
    expect(result).toMatchObject({ ok: true, written: ['dim_new'], changed: ['fct_x', 'fct_z'] });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(listing).toHaveBeenCalledTimes(1);
    const after = snapshot();
    expect(after['gold/tables/gold/dim_new.dbml']).toMatch(/^Table gold\.dim_new \{/);
    expect(after['gold/relationships/gold.dbml']).toContain('Ref: gold.fct_x.date_key >? gold.dim_date.date_key');
    expect(after['gold/new.json']).toBe(documentText());
  });

  it('a later failure (the diagram\'s name was taken) removes a relationships file the batch created, and the new table', async () => {
    write('gold/new.json', '{}\n');
    const before = snapshot();
    const result = await writeNew(new TableLibraryService(root, '.erd-studio'), false);
    expect(result).toMatchObject({ ok: false, undone: true, nameTaken: true });
    expect(snapshot()).toEqual(before);
  });

  it('…and puts back a relationships file the batch changed, byte for byte', async () => {
    write('gold/relationships/gold.dbml', '\uFEFF// Hand-written header\n');
    write('gold/new.json', '{}\n');
    const before = snapshot();
    const result = await writeNew(new TableLibraryService(root, '.erd-studio'), false);
    expect(result).toMatchObject({ ok: false, undone: true });
    expect(snapshot()).toEqual(before);
  });
});

describe('writeNewSubjectArea for a DBML diagram in a project it starts: the README (§1.7)', () => {
  let plain: string;
  beforeEach(() => {
    plain = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-new-sa-readme-'));
  });
  afterEach(() => {
    fs.rmSync(plain, { recursive: true, force: true });
  });

  const write = (io?: FileWriteIo): ReturnType<typeof writeNewSubjectArea> => writeNewSubjectArea({
    workspaceRoot: plain,
    semanticDir: '.erd-studio',
    domainPath: path.join(plain, '.erd-studio', 'gold', 'diagrams', 'shop.dbml'),
    newTables: [{ name: 'customers', columns: [{ name: 'id', dataType: 'INT', description: '', isPrimaryKey: true }] }],
    changedTables: [],
    folder: 'gold',
    documentText: () => '',
    document: () => ({ domain: 'shop', logical: { models: ['customers'] }, viewConfig: {} }),
  }, { layerService: new LayerService(plain, '.erd-studio'), tableLibraryService: new TableLibraryService(plain, '.erd-studio'), ...(io ? { io } : {}) });

  it('creates README.md with the tree\'s description, last, in the same batch as the diagram', async () => {
    const result = await write();
    expect(result).toMatchObject({ ok: true, written: ['customers'] });
    expect(fs.readFileSync(path.join(plain, '.erd-studio', 'README.md'), 'utf-8')).toBe(semanticReadmeText());
    expect(fs.existsSync(path.join(plain, '.erd-studio', 'gold', 'tables', 'gold', 'customers.dbml'))).toBe(true);
  });

  it('a failed README write rolls everything back, the folder it made included', async () => {
    let renames = 0;
    const io: FileWriteIo = {
      readFile: (p) => fs.readFileSync(p),
      writeFile: (p, d) => fs.writeFileSync(p, d),
      rename: (from, to) => {
        renames++;
        if (path.basename(to) === 'README.md') throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC', path: to });
        fs.renameSync(from, to);
      },
      unlink: (p) => fs.unlinkSync(p),
      exists: (p) => fs.existsSync(p),
      mkdir: (p) => fs.mkdirSync(p),
      rmdir: (p) => fs.rmdirSync(p),
    };
    const result = await write(io);
    expect(result).toMatchObject({ ok: false, undone: true });
    // The README is the last create: the table and the diagram landed first and were put back.
    expect(renames).toBe(3);
    expect(fs.existsSync(path.join(plain, '.erd-studio'))).toBe(false);
  });
});
