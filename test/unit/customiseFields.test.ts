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

  it('a document that cannot be opened is reported, not thrown', async () => {
    const r = recorder();
    r.deps.openTextDocument = async () => { throw new Error('denied'); };
    expect(await customiseFields(semantic, r.deps)).toBe('failed');
    expect(r.errors).toEqual(['Customise Fields: could not open fields.yml (denied).']);
  });
});
