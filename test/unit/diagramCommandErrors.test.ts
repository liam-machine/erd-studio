/**
 * The diagram and layer commands' failures in words (#229): each says whose
 * problem it is, offers the next step as a button, and never carries the raw
 * exception or an absolute path.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';

import { SubjectAreaFileError } from '@erd-studio/core';

import {
  deleteFailure,
  layerGone,
  layersFailure,
  layoutDeleteFailure,
  renameReadFailure,
  renameRefused,
  renameUnsavedFile,
  unsavedSaveFailure,
  writeFailure,
  type CommandFailure,
} from '../../src/services/diagramCommandErrors';
import { LayersFileUnreadableError } from '../../src/services/layerService';

const ROOT = path.join(path.sep, 'home', 'someone', 'project');
const LAYER_DIR = path.join(ROOT, '.erd-studio', 'gold');
const FILE = path.join(LAYER_DIR, 'orders.json');
const LAYERS = path.join(ROOT, '.erd-studio', 'layers.json');

function errno(code: string, syscall: string, at: string): NodeJS.ErrnoException {
  const prefix = code === 'EACCES' ? 'permission denied' : code === 'ENOSPC' ? 'no space left on device' : 'unknown';
  return Object.assign(new Error(`${code}: ${prefix}, ${syscall} '${at}'`), { code, syscall, path: at });
}

const EACCES = errno('EACCES', 'open', FILE);
const ENOSPC = errno('ENOSPC', 'write', FILE);
const OTHER = new TypeError(`Cannot read properties of undefined (reading 'x') at ${FILE}`);
/** VS Code's `workspace.fs` reports EACCES as `NoPermissions`, with no `path`. */
const NO_PERMISSIONS = Object.assign(new Error(`EACCES: permission denied, unlink '${FILE}'`), { code: 'NoPermissions' });

/** No raw exception text, errno code or absolute path reaches the user. */
function expectNoRawError(f: CommandFailure): void {
  expect(f.message).not.toContain(ROOT);
  expect(f.message).not.toMatch(/EACCES|ENOSPC|EPERM|NoPermissions|Cannot read properties/);
  expect(f.message).not.toMatch(/subject area/i);
}

describe('New Diagram: the folder or the file could not be written (#229 rows 1, 2)', () => {
  const ctx = { workspaceRoot: ROOT, target: FILE, doing: 'while writing the diagram file', outcome: 'Nothing was created.', retry: true };

  it('permission: names the folder project-relative, Show Folder and Try Again', () => {
    const f = writeFailure('New Diagram', EACCES, ctx);
    expect(f).toMatchObject({
      message: "New Diagram: ERD Studio isn't allowed to write to .erd-studio/gold/. Check the folder's permissions, then try again. Nothing was created.",
      buttons: ['Show Folder', 'Try Again'],
      target: LAYER_DIR,
    });
    expectNoRawError(f);
  });

  it('permission on a folder it was making: names the folder it was made in', () => {
    const f = writeFailure('New Diagram', errno('EACCES', 'mkdir', path.join(ROOT, '.erd-studio')), { ...ctx, doing: 'while creating the folder for it' });
    expect(f.message).toBe(
      "New Diagram: ERD Studio isn't allowed to write to the project folder. Check the folder's permissions, then try again. Nothing was created.",
    );
    expect(f.target).toBe(ROOT);
    expectNoRawError(f);
  });

  it('permission with no path in the error: falls back to the folder it was writing', () => {
    const f = writeFailure('New Diagram', NO_PERMISSIONS, ctx);
    expect(f.message).toContain('.erd-studio/gold/');
    expect(f.buttons).toEqual(['Show Folder', 'Try Again']);
    expectNoRawError(f);
  });

  it('disk full: Try Again only (there is no folder to fix)', () => {
    const f = writeFailure('New Diagram', ENOSPC, ctx);
    expect(f).toMatchObject({ message: 'New Diagram: the disk is full. Free up some space, then try again. Nothing was created.', buttons: ['Try Again'] });
    expectNoRawError(f);
  });

  it("anything else is ERD Studio's: says so, Send Feedback and Try Again", () => {
    const f = writeFailure('New Diagram', OTHER, ctx);
    expect(f).toMatchObject({
      message: "New Diagram hit a problem in ERD Studio while writing the diagram file, so nothing was created. This isn't something you did. Please send us a report.",
      buttons: ['Send Feedback', 'Try Again'],
      doing: 'while writing the diagram file',
    });
    expectNoRawError(f);
  });
});

describe('Set Up ERD Studio Folder and Regenerate dbt selectors.yml (#229 rows 5, 10)', () => {
  it.each([
    ['permission', EACCES, ['Show Folder', 'Try Again']],
    ['disk-full', ENOSPC, ['Try Again']],
    ['other', OTHER, ['Send Feedback', 'Try Again']],
  ] as const)('Set Up, %s', (_kind, err, buttons) => {
    const f = writeFailure('Set up ERD Studio', err, {
      workspaceRoot: ROOT, target: LAYERS, doing: 'while creating the .erd-studio/ folder',
      outcome: 'Some of .erd-studio/ may already have been created.', retry: true,
    });
    expect(f.buttons).toEqual(buttons);
    expect(f.message).toMatch(/^Set up ERD Studio/);
    expect(f.message).toMatch(/some of \.erd-studio\/ may already have been created\./i);
    expectNoRawError(f);
  });

  it('selectors.yml, permission: names the project folder', () => {
    const f = writeFailure('Regenerate dbt selectors.yml', errno('EACCES', 'open', path.join(ROOT, 'selectors.yml')), {
      workspaceRoot: ROOT, target: path.join(ROOT, 'selectors.yml'), doing: 'while writing selectors.yml', outcome: 'selectors.yml was not changed.', retry: true,
    });
    expect(f.message).toBe(
      "Regenerate dbt selectors.yml: ERD Studio isn't allowed to write to the project folder. Check the folder's permissions, then try again. selectors.yml was not changed.",
    );
    expectNoRawError(f);
  });
});

describe('Delete Diagram (#229 rows 6, 7)', () => {
  it.each([
    ['EACCES', EACCES],
    ['NoPermissions (workspace.fs)', NO_PERMISSIONS],
    ['EBUSY (open in another program, Windows)', Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${FILE}'`), { code: 'EBUSY' })],
  ])('%s is the user\'s: Show File and Try Again', (_kind, err) => {
    const f = deleteFailure('orders', FILE, err);
    expect(f).toMatchObject({
      message: "\"orders\" couldn't be deleted: another program may have it open, or ERD Studio isn't allowed to change that folder. Nothing was deleted.",
      buttons: ['Show File', 'Try Again'],
      target: FILE,
    });
    expectNoRawError(f);
  });

  it("anything else is ERD Studio's: Send Feedback and Try Again", () => {
    const f = deleteFailure('orders', FILE, OTHER);
    expect(f).toMatchObject({
      message: "Delete Diagram hit a problem in ERD Studio while deleting the file, so nothing was deleted. This isn't something you did. Please send us a report.",
      buttons: ['Send Feedback', 'Try Again'],
    });
    expectNoRawError(f);
  });

  it.each([
    ['deleting', "\"orders\" couldn't be saved, so it wasn't deleted. Your changes are still in its tab."],
    ['renaming', "\"orders\" couldn't be saved, so it wasn't renamed. Your changes are still in its tab."],
  ] as const)('unsaved changes that will not save, %s: Show File', (operation, message) => {
    expect(unsavedSaveFailure('orders', operation)).toMatchObject({ message, buttons: ['Show File'] });
  });
});

describe('Rename Diagram (#229 rows 8, 9)', () => {
  it('a JSON mistake is the file\'s: where it is, in words, and Open File at the line', () => {
    const err = new SubjectAreaFileError('invalid-json', FILE, `Invalid JSON in ${FILE}`, { line: 4, column: 3, syntaxProblem: 'trailing-comma' });
    const f = renameReadFailure(FILE, err, ROOT);
    expect(f).toMatchObject({
      message: ".erd-studio/gold/orders.json can't be renamed because the diagram file has a problem: there is a mistake at line 4, column 3: " +
        'there is a comma after the last item, before a closing } or ].',
      buttons: ['Open File'],
      target: FILE,
      line: 4,
      column: 3,
    });
    expectNoRawError(f);
  });

  it('a file that is gone is not openable: no Open File', () => {
    const f = renameReadFailure(FILE, new SubjectAreaFileError('missing', FILE, `Subject area file not found: ${FILE}`), ROOT);
    expect(f.buttons).toEqual([]);
    expect(f.message).toContain('it was deleted or renamed');
    expectNoRawError(f);
  });

  it("anything else is ERD Studio's: Send Feedback", () => {
    const f = renameReadFailure(FILE, OTHER, ROOT);
    expect(f).toMatchObject({
      message: "Rename Diagram hit a problem in ERD Studio while reading the diagram file, so nothing was changed. This isn't something you did. Please send us a report.",
      buttons: ['Send Feedback'],
    });
  });

  it('VS Code refusing the rename: the likely reasons, Try Again and Send Feedback', () => {
    expect(renameRefused('orders', 'sales')).toMatchObject({
      message: "VS Code didn't accept renaming \"orders\" to \"sales\", usually because another program has the file open or ERD Studio isn't allowed to write to that folder. Nothing was changed.",
      buttons: ['Try Again', 'Send Feedback'],
    });
  });
});

describe('the layer commands (#229 rows 11, 12)', () => {
  const ctx = { workspaceRoot: ROOT, layersPath: LAYERS, doing: 'while saving layers.json', outcome: "The layer wasn't added." };

  it('a layers.json with a mistake in it is the user\'s file to fix: Open File', () => {
    const f = layersFailure('Add Layer', new LayersFileUnreadableError('Invalid JSON in layers config: Unexpected token'), ctx);
    expect(f).toMatchObject({
      message: "Add Layer: .erd-studio/layers.json has a mistake in it, so the layer wasn't added. Fix the file, then try again.",
      buttons: ['Open File'],
      target: LAYERS,
    });
    expect(f.message).not.toContain('Unexpected token');
  });

  it('a layers.json ERD Studio cannot read at all is not "a mistake": Show File', () => {
    const f = layersFailure('Add Layer', new LayersFileUnreadableError(`Failed to read layers config: EACCES: permission denied, open '${LAYERS}'`), ctx);
    expect(f).toMatchObject({
      message: "Add Layer: ERD Studio can't read .erd-studio/layers.json, so the layer wasn't added. Check the file's permissions, then try again.",
      buttons: ['Show File'],
      target: LAYERS,
    });
    expectNoRawError(f);
  });

  it.each([
    ['permission', errno('EACCES', 'open', LAYERS), ['Show Folder']],
    ['disk-full', ENOSPC, []],
    ['other', OTHER, ['Send Feedback']],
  ] as const)('a layers.json that will not write, %s', (_kind, err, buttons) => {
    const f = layersFailure('Edit Layer', err, { ...ctx, outcome: "The layer wasn't changed." });
    expect(f.buttons).toEqual(buttons);
    expect(f.message).toMatch(/the layer wasn't changed/i);
    expectNoRawError(f);
  });

  it('a layer the sidebar showed that layers.json no longer has: the sidebar was stale', () => {
    expect(layerGone('Edit Layer', 'platinum')).toMatchObject({
      message: 'The layer "platinum" isn\'t in layers.json any more. The sidebar has been refreshed.',
      buttons: [],
    });
  });
});

describe('a DBML diagram\'s layout file (.dbdiagram, §5.7)', () => {
  const LAYOUT = path.join(LAYER_DIR, 'orders.dbdiagram');

  it('Delete: a layout file left behind is the user\'s to close or unlock, with Show File and Try Again', () => {
    const f = layoutDeleteFailure('orders', LAYOUT, NO_PERMISSIONS, ROOT);
    expect(f).toMatchObject({
      title: 'Delete Diagram',
      message: '"orders" was deleted, but its layout file .erd-studio/gold/orders.dbdiagram couldn\'t be: another program may have it open, ' +
        "or ERD Studio isn't allowed to change that folder. Delete it yourself, or try again.",
      buttons: ['Show File', 'Try Again'],
      target: LAYOUT,
    });
    expectNoRawError(f);
  });

  it('Delete: anything else is ERD Studio\'s, with Send Feedback, and says the diagram did go', () => {
    const f = layoutDeleteFailure('orders', LAYOUT, OTHER, ROOT);
    expect(f.buttons).toEqual(['Send Feedback', 'Try Again']);
    expect(f.message).toBe(
      'Delete Diagram hit a problem in ERD Studio while deleting the layout file, so .erd-studio/gold/orders.dbdiagram is still there ' +
        "(the diagram was deleted). This isn't something you did. Please send us a report.",
    );
    expectNoRawError(f);
  });

  it('Rename: a layout file with unsaved changes is named, with Show File', () => {
    const f = renameUnsavedFile(LAYOUT, ROOT);
    expect(f).toMatchObject({
      title: 'Rename Diagram',
      message: 'Rename Diagram: .erd-studio/gold/orders.dbdiagram has unsaved changes. Save or revert it, then try again. Nothing was changed.',
      buttons: ['Show File'],
    });
    expectNoRawError(f);
  });
});
