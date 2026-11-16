/**
 * Customise Fields… (`erdStudio.customiseFields`): opens the project's
 * fields.yml, or an unsaved document at that path holding the starting set.
 * It never writes a file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';

import { STARTING_FIELD_LIST, parseFieldsText } from '@erd-studio/core';
import { CUSTOMISE_FIELDS_COMMAND, customiseFields, startingFieldsText, type CustomiseFieldsDeps } from '../../src/commands/customiseFields';
import { NO_LEGACY_ALIAS, PRE_REGISTERED_COMMANDS } from '../../src/extension';
import type { CommandFailure } from '../../src/services/diagramCommandErrors';

let root: string;
let semantic: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-customise-fields-'));
  semantic = path.join(root, '.erd-studio');
  fs.mkdirSync(semantic, { recursive: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

interface Recorded {
  deps: CustomiseFieldsDeps;
  opened: string[];
  shown: number;
  inserted: string[];
  errors: string[];
}

/** Deps over an in-memory document whose text starts as `initialText` (an untitled one is empty). */
function recorder(initialText = ''): Recorded {
  const r: Recorded = { opened: [], shown: 0, inserted: [], errors: [], deps: undefined as never };
  let text = initialText;
  const document = { getText: () => text } as unknown as vscode.TextDocument;
  const editor = {
    edit: async (fn: (b: { insert: (_p: unknown, t: string) => void }) => void) => {
      fn({ insert: (_p, t) => { r.inserted.push(t); text += t; } });
      return true;
    },
  } as unknown as vscode.TextEditor;
  r.deps = {
    openTextDocument: async (uri) => { r.opened.push(`${uri.scheme}:${uri.fsPath}`); return document; },
    showTextDocument: async () => { r.shown++; return editor; },
    showErrorMessage: async (message) => { r.errors.push(message); return undefined; },
    untitledUri: (filePath) => ({ scheme: 'untitled', fsPath: filePath, path: filePath }) as unknown as vscode.Uri,
  };
  return r;
}

describe('Customise Fields…', () => {
  it('is a post-rename command with no legacy alias, registered once the project is known', () => {
    expect(CUSTOMISE_FIELDS_COMMAND).toBe('erdStudio.customiseFields');
    expect(NO_LEGACY_ALIAS.has(CUSTOMISE_FIELDS_COMMAND)).toBe(true);
    expect(PRE_REGISTERED_COMMANDS.has(CUSTOMISE_FIELDS_COMMAND)).toBe(false);
  });

  it('opens fields.yml when the project has one', async () => {
    const file = path.join(semantic, 'fields.yml');
    fs.writeFileSync(file, 'version: 1\ntables:\n  - purpose\n');
    const r = recorder('version: 1\n');
    expect(await customiseFields(semantic, r.deps)).toBe('file');
    expect(r.opened).toEqual([`file:${file}`]);
    expect(r.shown).toBe(1);
    expect(r.inserted).toEqual([]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('version: 1\ntables:\n  - purpose\n');
  });

  it('without one, opens an unsaved fields.yml at that path holding the starting set, and writes nothing', async () => {
    const r = recorder();
    expect(await customiseFields(semantic, r.deps)).toBe('untitled');
    expect(r.opened).toEqual([`untitled:${path.join(semantic, 'fields.yml')}`]);
    expect(r.inserted).toEqual([startingFieldsText()]);
    expect(fs.existsSync(path.join(semantic, 'fields.yml'))).toBe(false);
    expect(fs.readdirSync(semantic)).toEqual([]);
  });

  it('the starting text reads back as the starting set, with no problem', () => {
    const { list, problems } = parseFieldsText(startingFieldsText());
    expect(problems).toEqual([]);
    expect(list.tables.map((d) => d.key)).toEqual(STARTING_FIELD_LIST.tables.map((d) => d.key));
    expect(list.columns.map((d) => d.key)).toEqual(STARTING_FIELD_LIST.columns.map((d) => d.key));
    expect(list.leftOut).toEqual([]);
  });

  it('run again before saving: the unsaved document is not filled twice', async () => {
    const r = recorder(startingFieldsText());
    expect(await customiseFields(semantic, r.deps)).toBe('untitled');
    expect(r.inserted).toEqual([]);
  });

  it('a folder named fields.yml is reported, and nothing is opened', async () => {
    fs.mkdirSync(path.join(semantic, 'fields.yml'));
    const r = recorder();
    expect(await customiseFields(semantic, r.deps)).toBe('failed');
    expect(r.opened).toEqual([]);
    expect(r.errors).toEqual(['Customise Fields: fields.yml in .erd-studio is not a file. Remove it or rename it, then try again.']);
  });

  // #335: never the exception's own text. Ours offers Send Feedback; a folder ERD Studio may not use says so, with the folder.
  it('a document that cannot be opened is reported, not thrown, and never in the exception\'s words', async () => {
    const r = recorder();
    const shown: Array<{ failure: CommandFailure; err: unknown }> = [];
    r.deps.showFailure = (failure, err) => { shown.push({ failure, err }); };
    r.deps.openTextDocument = async () => { throw new Error('boom'); };
    expect(await customiseFields(semantic, r.deps)).toBe('failed');
    expect(shown).toHaveLength(1);
    expect(shown[0].failure.message).toBe(
      "Customise Fields hit a problem in ERD Studio while opening fields.yml, so nothing was created. This isn't something you did. Please send us a report.",
    );
    expect(shown[0].failure.buttons).toEqual(['Send Feedback']);
    // Ours: counted once by showCommandFailure, and the exception goes in Send Feedback's report.
    expect(shown[0].failure.doing).toBe('while opening fields.yml');
    expect((shown[0].err as Error).message).toBe('boom');
    expect(r.errors).toEqual([]);
  });

  it('a folder it may not write: said in words, naming the folder, with Show Folder and Try Again, not counted as ours', async () => {
    const r = recorder();
    const shown: Array<{ failure: CommandFailure; retry: () => unknown }> = [];
    r.deps.showFailure = (failure, _err, retry) => { shown.push({ failure, retry }); };
    let opens = 0;
    r.deps.openTextDocument = async (uri) => {
      if (++opens === 1) throw new Error(`EACCES: permission denied, open '${uri.fsPath}'`);
      r.opened.push(`${uri.scheme}:${uri.fsPath}`);
      return { getText: () => 'x' } as unknown as vscode.TextDocument;
    };
    expect(await customiseFields(semantic, r.deps)).toBe('failed');
    expect(shown[0].failure.message).toBe(
      "Customise Fields: ERD Studio isn't allowed to write to .erd-studio/. Check the folder's permissions, then try again. Nothing was created.",
    );
    expect(shown[0].failure.buttons).toEqual(['Show Folder', 'Try Again']);
    expect(shown[0].failure.target).toBe(semantic);
    expect(shown[0].failure.doing).toBeUndefined();
    // Try Again runs the command again.
    expect(await shown[0].retry()).toBe('untitled');
    expect(r.opened).toEqual([`untitled:${path.join(semantic, 'fields.yml')}`]);
  });

  it('by default the failure is shown with its buttons, never the raw text', async () => {
    const vs = await import('vscode');
    const error = vi.spyOn(vs.window, 'showErrorMessage').mockResolvedValue(undefined);
    const r = recorder();
    delete r.deps.showFailure;
    r.deps.openTextDocument = async () => { throw new Error('boom'); };
    expect(await customiseFields(semantic, r.deps)).toBe('failed');
    expect(error.mock.calls[0]).toEqual([
      "Customise Fields hit a problem in ERD Studio while opening fields.yml, so nothing was created. This isn't something you did. Please send us a report.",
      'Send Feedback',
    ]);
  });
});
