/**
 * The manifest contributions native DBML storage reads through (§5.6 of
 * docs/plans/native-dbml-storage.md): the canvas opens `.dbml` diagrams in a
 * layer folder; positions are each diagram's `erd_layout`, so no `.dbdiagram`
 * language or schema is contributed.
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

  it('.dbdiagram has no language (positions are the diagram\'s erd_layout); only .dbml is dbml', () => {
    const languages = pkg.contributes.languages as Array<{ id: string; extensions?: string[] }>;
    expect(languages.filter((l) => l.extensions?.includes('.dbdiagram'))).toEqual([]);
    expect(languages.map((l) => l.id)).toEqual(['dbml']);
    expect(languages.find((l) => l.id === 'dbml')?.extensions).toEqual(['.dbml']);
    expect(pkg.contributes.grammars.map((g: { language: string }) => g.language)).toEqual(['dbml']);
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
