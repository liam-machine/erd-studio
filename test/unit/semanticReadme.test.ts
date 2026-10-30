/**
 * The README.md a DBML project's semantic dir starts with (§1.7 of the 2.0
 * design): its text, and that it is only ever created.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';

import { SEMANTIC_README_FILE, semanticReadmeCreate, semanticReadmeText } from '../../src/services/semanticReadme';

describe('semanticReadmeText', () => {
  it('describes the layer-first tree with no dbml fence and no "open standard"', () => {
    const text = semanticReadmeText();
    expect(text.startsWith('# .erd-studio\n\n')).toBe(true);
    expect(text).not.toContain('```dbml');
    expect(text).not.toContain('```');
    expect(text.toLowerCase()).not.toContain('open standard');
    expect(text).toContain('an open format (https://dbml.dbdiagram.io)');
    for (const line of [
      '    <layer>/tables/<schema>/<table>.dbml   one table: Table <schema>.<table> { … }',
      '    <layer>/relationships/<file>.dbml      Refs between tables, split across files however you like',
      '    <layer>/diagrams/<diagram>.dbml        one diagram: the tables it shows (use lines), the',
    ]) {
      expect(text).toContain(line);
    }
    expect(text.endsWith('Check the files with `erd-studio doctor`.\n')).toBe(true);
  });
});

describe('semanticReadmeCreate', () => {
  const semanticRoot = path.join('/p', '.erd-studio');
  const file = path.join(semanticRoot, SEMANTIC_README_FILE);

  it('creates README.md when it is absent', () => {
    const asked: string[] = [];
    const write = semanticReadmeCreate(semanticRoot, (p) => {
      asked.push(p);
      return false;
    });
    expect(write).toEqual({ kind: 'create', path: file, text: semanticReadmeText() });
    expect(asked).toEqual([file]);
  });

  it('returns null when the file exists: it is never replaced', () => {
    expect(semanticReadmeCreate(semanticRoot, (p) => p === file)).toBeNull();
  });
});
