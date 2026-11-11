/**
 * The canvas's "not shown" notes (`collectFilesNotShown`) arrange what the
 * readers found; they detect nothing themselves. These tests hold that: each
 * note the canvas shows for a project is one `doctor` reports too
 * (`collectDbmlProblems`), at the same file and line, so the two can never
 * disagree about what a file holds. The canvas words it in its own short
 * sentences; `doctor` keeps its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildCliContext } from '../../src/cli/context';
import { collectDbmlProblems } from '../../src/cli/dbmlProblems';
import { NOT_DRAWN_IN_TABLE_FILE_CODES, collectFilesNotShown, relationshipsNotImportedMessage } from '../../src/services/filesNotShown';
import { outsideKnownFoldersHint } from '../../src/services/unreadDbmlFile';
import { projectStorageOf } from '../../src/services/projectStorage';
import { subjectAreaTableNames } from '../../src/services/domainService';
import { fileNotesSignature, isFileNote, type FileNote } from '../../src/types/filesNotShown';

const REPO_ROOT = path.resolve(__dirname, '../..');
const NATIVE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native');
const SALES = 'gold/diagrams/sales.dbml';

let root: string;
const at = (rel: string): string => path.join(root, '.erd-studio', rel);
const read = (rel: string): string => fs.readFileSync(at(rel), 'utf-8');
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text, 'utf-8');
};
const shown = (rel: string): string => `.erd-studio/${rel}`;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'erd-notes-')));
  fs.cpSync(NATIVE, root, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The notes of the sales diagram, gathered as the editor gathers them, and doctor's problems for the same project. */
async function notesAndDoctor(unreadFiles: string[] = []): Promise<{ notes: FileNote[]; doctor: ReturnType<typeof collectDbmlProblems> }> {
  const ctx = await buildCliContext({ project: root, semanticDir: '.erd-studio' });
  const library = ctx.tableLibraryService;
  ctx.subjectAreaService.getSubjectArea(at(SALES));
  const members = subjectAreaTableNames(read(SALES), at(SALES)) ?? [];
  const semanticRelative = (filePath: string): string => path.relative(path.join(root, '.erd-studio'), filePath).split(path.sep).join('/');
  const notes = collectFilesNotShown({
    importDrift: ctx.subjectAreaService.relationshipsImportDrift(at(SALES)),
    canAddImports: true,
    memberTables: members.flatMap((name) => {
      const found = library.dbmlTableProblems(name);
      return found ? [{ file: semanticRelative(found.filePath), problems: found.problems }] : [];
    }),
    relationshipsFiles: library.listRelationshipsFiles().flatMap((filePath) => {
      const reading = library.readRelationshipsFile(filePath);
      return reading ? [{ file: semanticRelative(filePath), reading }] : [];
    }),
    unreadFiles,
    shown,
  });
  return { notes, doctor: collectDbmlProblems(ctx, projectStorageOf(library)) };
}

describe('collectFilesNotShown', () => {
  it('a clean project has no notes, and doctor no problems', async () => {
    const { notes, doctor } = await notesAndDoctor();
    expect(notes).toEqual([]);
    expect(doctor).toEqual([]);
  });

  it('a relationships file the diagram does not import: one note with the action, doctor\'s missingRelationshipsUse', async () => {
    write(SALES, read(SALES).replace("use * from '../relationships/customers.dbml'\n", ''));
    const { notes, doctor } = await notesAndDoctor();
    expect(notes).toEqual([{
      code: 'relationshipsNotImported',
      message: relationshipsNotImportedMessage('gold/relationships/customers.dbml', true),
      file: shown('gold/relationships/customers.dbml'),
      action: 'addRelationshipsImports',
    }]);
    const missing = doctor.filter((p) => p.code === 'missingRelationshipsUse');
    expect(missing).toHaveLength(1);
    expect(missing[0].file).toBe(shown(SALES));
    expect(missing[0].message).toContain('gold/relationships/customers.dbml holds a relationship between tables of this diagram');
    // Neither wording promises that "any edit" adds the import: a drag saves positions only.
    expect(missing[0].message).not.toContain('Any edit');
    expect(notes[0].message).not.toContain('Any edit');
  });

  it('no action when the diagram cannot be edited from the canvas: the note says what to write', () => {
    const notes = collectFilesNotShown({
      importDrift: ['gold/relationships/customers.dbml'], canAddImports: false, memberTables: [], relationshipsFiles: [], unreadFiles: [], shown,
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].action).toBeUndefined();
    expect(notes[0].message).toBe('This diagram does not import gold/relationships/customers.dbml, so a relationship in it is not drawn. '
      + 'Add a use * line for that file to the diagram file to draw it.');
  });

  it('a Ref, an inline ref and a use line in a table file: a note each, at doctor\'s file and line, in short words', async () => {
    const table = 'gold/tables/gold/fct_order.dbml';
    const text = read(table);
    const firstColumn = text.split('\n').find((l) => /^\s+customer_key\b/.test(l))!;
    expect(firstColumn).toBeDefined();
    write(table, [
      "use { table gold.dim_region } from './dim_region.dbml'",
      text.replace(firstColumn, `${firstColumn.replace(/\s*$/, '')} [ref: > gold.dim_customer.customer_key]`.replace('] [ref:', ', ref:')),
      'Ref: gold.fct_order.customer_key > gold.dim_customer.customer_key',
      '',
    ].join('\n'));
    const { notes, doctor } = await notesAndDoctor();
    const mine = notes.filter((n) => n.code === 'notDrawnInTableFile');
    const theirs = doctor.filter((p) => typeof p.code === 'string' && NOT_DRAWN_IN_TABLE_FILE_CODES.has(p.code));
    expect(theirs.map((p) => p.code).sort()).toEqual(['inlineRefInTableFile', 'refInTableFile', 'useInTableFile']);
    expect(mine.map((n) => ({ file: n.file, line: n.line })).sort((a, b) => a.line! - b.line!))
      .toEqual(theirs.map((p) => ({ file: p.file, line: p.line })).sort((a, b) => a.line! - b.line!));
    expect(mine.every((n) => n.file === shown(table))).toBe(true);
    // The canvas's own words: one short note per kind, naming the file (doctor's longer text stays doctor's).
    const byLine = (code: string): string => mine.find((n) => n.line === theirs.find((p) => p.code === code)!.line)!.message;
    expect(byLine('useInTableFile')).toBe(`A use line in ${table} is not needed: a table file imports nothing. ERD Studio cannot edit this table until it is removed.`);
    expect(byLine('inlineRefInTableFile')).toBe(`A [ref: …] in ${table} is not drawn: relationships go in a relationships file. ERD Studio cannot edit this table until it is moved.`);
    expect(byLine('refInTableFile')).toBe(`A Ref in ${table} is not drawn: relationships go in a relationships file. ERD Studio cannot edit this table until it is moved.`);
  });

  it('a relationships file that does not read: a note at the line doctor reports its error at', async () => {
    const file = 'gold/relationships/gold.dbml';
    write(file, `${read(file)}\nRef: gold.fct_order.customer_key >\n`);
    const { notes, doctor } = await notesAndDoctor();
    const mine = notes.filter((n) => n.code === 'relationshipsFileNotRead');
    expect(mine).toHaveLength(1);
    expect(mine[0].file).toBe(shown(file));
    const errors = doctor.filter((p) => p.file === shown(file) && p.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((p) => p.line)).toContain(mine[0].line);
    expect(mine[0].message.startsWith(`${file} has a mistake, so none of its relationships are drawn. `)).toBe(true);
  });

  it('a relationships file with git conflict markers says to keep one side', async () => {
    const file = 'gold/relationships/customers.dbml';
    write(file, `<<<<<<< HEAD\n${read(file)}=======\n${read(file)}>>>>>>> theirs\n`);
    const { notes, doctor } = await notesAndDoctor();
    const mine = notes.filter((n) => n.code === 'relationshipsFileNotRead' && n.file === shown(file));
    expect(mine).toHaveLength(1);
    expect(mine[0].message).toContain('unresolved git merge conflicts');
    expect(doctor.some((p) => p.file === shown(file) && p.code === 'mergeConflict')).toBe(true);
  });

  it('a .dbml where no file is read: the same files as doctor, ending with doctor\'s own hint of where it belongs', async () => {
    write('gold/tables/dim_store.dbml', 'Table gold.dim_store {\n  id INT [pk]\n}\n');
    write('gold/tables/gold/deeper/dim_shop.dbml', 'Table gold.dim_shop {\n  id INT [pk]\n}\n');
    const strays = ['gold/tables/dim_store.dbml', 'gold/tables/gold/deeper/dim_shop.dbml'];
    const { notes, doctor } = await notesAndDoctor(strays);
    const mine = notes.filter((n) => n.code === 'fileNotRead');
    const theirs = doctor.filter((p) => p.code === 'dbmlOutsideKnownFolders');
    expect(mine.map((n) => n.file)).toEqual(theirs.map((p) => p.file));
    expect(mine).toHaveLength(2);
    for (const [i, rel] of strays.entries()) {
      const hint = outsideKnownFoldersHint(rel);
      const tail = `${hint[0].toUpperCase()}${hint.slice(1)}.`;
      expect(mine[i].message).toBe(`ERD Studio does not read ${rel} where it is. ${tail}`);
      expect(theirs[i].message.endsWith(tail)).toBe(true);
    }
  });

  it('lists what stops relationships being drawn first, and never the same note twice', () => {
    const reading = { readable: false, refs: [], problems: [{ severity: 'error' as const, line: 3, message: 'Expect a comma' }] };
    const problem = { code: 'refInTableFile', severity: 'warning' as const, line: 9, message: 'move it' };
    const notes = collectFilesNotShown({
      importDrift: ['b/relationships/b.dbml', 'a/relationships/a.dbml'],
      canAddImports: true,
      memberTables: [{ file: 'a/tables/a/t.dbml', problems: [problem, problem, { code: 'unquotedValue', severity: 'warning', message: 'not a not-drawn code' }] }],
      relationshipsFiles: [{ file: 'a/relationships/x.dbml', reading }, { file: 'a/relationships/ok.dbml', reading: { readable: true, refs: [], problems: [] } }],
      unreadFiles: ['a/x.dbml'],
      shown,
    });
    expect(notes.map((n) => `${n.code} ${n.file}${n.line !== undefined ? `:${n.line}` : ''}`)).toEqual([
      'relationshipsNotImported .erd-studio/a/relationships/a.dbml',
      'relationshipsNotImported .erd-studio/b/relationships/b.dbml',
      'relationshipsFileNotRead .erd-studio/a/relationships/x.dbml:3',
      'notDrawnInTableFile .erd-studio/a/tables/a/t.dbml:9',
      'fileNotRead .erd-studio/a/x.dbml',
    ]);
    expect(notes.every(isFileNote)).toBe(true);
  });
});

describe('the shared note type', () => {
  it('isFileNote accepts only what the strip can draw', () => {
    expect(isFileNote({ code: 'fileNotRead', message: 'm' })).toBe(true);
    expect(isFileNote({ code: 'fileNotRead', message: 'm', file: 'a/b.dbml', line: 2, action: 'reloadFromDisk' })).toBe(true);
    expect(isFileNote({ code: 'somethingNew', message: 'm' })).toBe(false);
    expect(isFileNote({ code: 'fileNotRead', message: '' })).toBe(false);
    expect(isFileNote({ code: 'fileNotRead', message: 'm', line: 0 })).toBe(false);
    expect(isFileNote({ code: 'fileNotRead', message: 'm', action: 'deleteEverything' })).toBe(false);
    expect(isFileNote(null)).toBe(false);
    expect(isFileNote([])).toBe(false);
  });

  it('fileNotesSignature changes with the list, not with a re-post of the same list', () => {
    const a: FileNote = { code: 'fileNotRead', message: 'm', file: 'a.dbml' };
    const b: FileNote = { code: 'fileNotRead', message: 'm', file: 'b.dbml' };
    expect(fileNotesSignature([a])).toBe(fileNotesSignature([{ ...a }]));
    expect(fileNotesSignature([a])).not.toBe(fileNotesSignature([a, b]));
    expect(fileNotesSignature([a])).not.toBe(fileNotesSignature([{ ...a, line: 3 }]));
  });
});
