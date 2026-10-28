/**
 * The manifest contributions native DBML storage reads through (§5.6 of
 * docs/plans/native-dbml-storage.md): the canvas opens `.dbml` diagrams in a
 * layer folder, and a `.dbdiagram` layout file opens as JSON (with
 * highlighting, no new language and no schema). Stands in for the dev-host
 * check "a .dbdiagram file opens as JSON with highlighting" (§9.7 check 6).
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'));

describe('package.json for native DBML storage', () => {
  it('the canvas selector adds **/.erd-studio/*/*.dbml at priority default, beside the JSON ones', () => {
    const editor = pkg.contributes.customEditors[0];
    expect(editor.priority).toBe('default');
    expect(editor.selector.map((s: { filenamePattern: string }) => s.filenamePattern)).toEqual([
      '**/.erd-studio/*/*.json',
      '**/erd-studio/*/*.json',
      '**/.erd-studio/*/*.dbml',
    ]);
  });

  it('.dbdiagram files are the json language (no new language, no grammar)', () => {
    expect(pkg.contributes.languages).toEqual([{ id: 'json', extensions: ['.dbdiagram'] }]);
    expect(pkg.contributes.grammars).toBeUndefined();
  });

  it('no JSON or YAML schema is contributed for .dbml or .dbdiagram files', () => {
    const globs = [...pkg.contributes.jsonValidation, ...pkg.contributes.yamlValidation]
      .flatMap((v: { fileMatch: string | string[] }) => (Array.isArray(v.fileMatch) ? v.fileMatch : [v.fileMatch]));
    for (const glob of globs) {
      expect(glob, glob).not.toMatch(/\.(dbml|dbdiagram)$/);
      expect(glob, glob).toMatch(/\.(json|yml)$/);
    }
  });
});
