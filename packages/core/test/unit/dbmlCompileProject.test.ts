/**
 * `compileDbmlProject` (§4.1 of the native DBML storage spec): the
 * multi-file compile `doctor`, Convert's self-check, the end-to-end script
 * and these tests use to read a project the way other DBML tools do. Results
 * are keyed by the path relative to the semantic dir, under a fixed,
 * space-free virtual root, in 9.1.1, 10.3.1 and 11.0.0.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { compileDbmlProject } from '../../src/dbml/compileProject';
import { STORAGE_PARSERS } from '../dbmlParsers';

const TABLE_A = "Table a {\n  id int [pk]\n  b_id int\n}\n";
const TABLE_B = "Table b {\n  id int [pk]\n}\n";
const RELATIONSHIPS = "use { table a } from './a.dbml'\nuse { table b } from './b.dbml'\n\nRef: a.b_id > b.id\n";
const DIAGRAM = "Project d {\n  erd_schema_version: '7'\n}\n\nuse { table a } from '../tables/a.dbml'\nuse { table b } from '../tables/b.dbml'\nuse * from '../tables/_relationships.dbml'\n";

describe.each(STORAGE_PARSERS)('compileDbmlProject (%s)', (_label, parser) => {
  it('a clean project gives each entry an empty list, keyed relative to the semantic dir', () => {
    const files = { 'tables/a.dbml': TABLE_A, 'tables/b.dbml': TABLE_B, 'tables/_relationships.dbml': RELATIONSHIPS, 'gold/d.dbml': DIAGRAM };
    expect(compileDbmlProject(files, ['gold/d.dbml', '/tables/_relationships.dbml'], parser)).toEqual({
      'gold/d.dbml': [],
      'tables/_relationships.dbml': [],
    });
  });

  it('a dangling use is reported in the importing file, at its line', () => {
    const files = { 'tables/a.dbml': TABLE_A, 'gold/d.dbml': DIAGRAM };
    const result = compileDbmlProject(files, ['gold/d.dbml'], parser);
    expect(Object.keys(result)).toEqual(['gold/d.dbml']);
    expect(result['gold/d.dbml'].length).toBeGreaterThan(0);
    expect(result['gold/d.dbml'].map((d) => d.line)).toContain(6);
  });

  it('an error in an imported file is keyed by that file, not the entry', () => {
    const files = { 'tables/a.dbml': 'Table a {\n  id int [pk\n}\n', 'tables/b.dbml': TABLE_B, 'tables/_relationships.dbml': RELATIONSHIPS, 'gold/d.dbml': DIAGRAM };
    const result = compileDbmlProject(files, ['gold/d.dbml'], parser);
    expect(result['tables/a.dbml']?.length).toBeGreaterThan(0);
    expect(result['tables/a.dbml'].every((d) => d.line >= 2)).toBe(true);
  });

  it('a file two entries reach reports each diagnostic once', () => {
    // The relationships file names a table with no file: reached from the diagram and on its own.
    const files = { 'tables/a.dbml': TABLE_A, 'tables/_relationships.dbml': RELATIONSHIPS, 'gold/d.dbml': "use { table a } from '../tables/a.dbml'\nuse * from '../tables/_relationships.dbml'\n" };
    const result = compileDbmlProject(files, ['gold/d.dbml', 'tables/_relationships.dbml'], parser);
    const diagnostics = result['tables/_relationships.dbml'];
    expect(diagnostics.length).toBeGreaterThan(0);
    const keys = diagnostics.map((d) => `${d.code}:${d.line}:${d.column}:${d.message}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a leading byte-order mark is dropped from every file', () => {
    const files = { 'tables/a.dbml': `﻿${TABLE_A}`, 'tables/b.dbml': `﻿${TABLE_B}`, 'tables/_relationships.dbml': RELATIONSHIPS, 'gold/d.dbml': `﻿${DIAGRAM}` };
    expect(compileDbmlProject(files, ['gold/d.dbml'], parser)).toEqual({ 'gold/d.dbml': [] });
    // The control: without the tables, the same Ref is a binding error.
    const missing = compileDbmlProject({ 'gold/d.dbml': files['gold/d.dbml'] }, ['gold/d.dbml'], parser);
    expect(missing['gold/d.dbml'].length).toBeGreaterThan(0);
  });
});

describe('compileDbmlProject: error codes under the pin', () => {
  it('a missing use target is [4001] or [4000] in the importing file', () => {
    const result = compileDbmlProject({ 'gold/d.dbml': "use { table a } from '../tables/a.dbml'\n" }, ['gold/d.dbml']);
    expect(result['gold/d.dbml'].length).toBeGreaterThan(0);
    expect(result['gold/d.dbml'].every((d) => d.code === 4000 || d.code === 4001)).toBe(true);
  });
});

/** Every `.dbml` file of a twin, keyed relative to its semantic dir. */
function twinFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.dbml')) files[path.relative(root, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf-8');
    }
  };
  walk(root);
  return files;
}

const TWINS_DIR = path.resolve(__dirname, '../fixtures/dbml');
// missing-model's twin holds a table file that does not parse and use lines
// for tables with no file, on purpose: it is the tolerance case.
const CLEAN_TWINS = fs.readdirSync(TWINS_DIR).filter((name) => name !== 'missing-model');

describe('the DBML twins compile clean as multi-file projects, the way other DBML tools read them', () => {
  it('the clean twins are the four §9.2 cases and Convert\'s missing-model output (D26/D27)', () => {
    expect([...CLEAN_TWINS].sort()).toEqual(['composite-and-self', 'library-relationships', 'missing-model-converted', 'missing-positions', 'showcase']);
  });

  describe.each(STORAGE_PARSERS)('%s', (_label, parser) => {
    it.each(CLEAN_TWINS)('%s', (name) => {
      const files = twinFiles(path.join(TWINS_DIR, name, '.erd-studio'));
      const entries = Object.keys(files).filter((p) => !p.startsWith('tables/'));
      expect(entries.length).toBeGreaterThan(0);
      const result = compileDbmlProject(files, Object.keys(files), parser);
      for (const [file, diagnostics] of Object.entries(result)) {
        expect({ file, diagnostics }).toEqual({ file, diagnostics: [] });
      }
    });
  });
});

describe('a library folder whose name holds a space', () => {
  // The fixed virtual root keeps the project's own location out of every
  // path; a folder name with a space inside the semantic dir is still part of
  // the virtual path. The diagram's own Ref names both imported tables, so a
  // parser that dropped them would report [4000] here.
  it.each(STORAGE_PARSERS)('keeps the imported tables and compiles clean (%s)', (_label, parser) => {
    const files = {
      'tables/SAP FI/a.dbml': TABLE_A,
      'tables/SAP FI/b.dbml': TABLE_B,
      'gold/d.dbml': "use { table a } from '../tables/SAP FI/a.dbml'\nuse { table b } from '../tables/SAP FI/b.dbml'\nRef: a.b_id > b.id\n",
    };
    expect(compileDbmlProject(files, ['gold/d.dbml'], parser)).toEqual({ 'gold/d.dbml': [] });
    // The control: without the tables, the same Ref is a binding error.
    const missing = compileDbmlProject({ 'gold/d.dbml': files['gold/d.dbml'] }, ['gold/d.dbml'], parser);
    expect(missing['gold/d.dbml'].length).toBeGreaterThan(0);
  });
});
