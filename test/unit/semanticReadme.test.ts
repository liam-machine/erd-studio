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

  it('says what fields.yml is, in one item, and that it is optional (context fields)', () => {
    const text = semanticReadmeText();
    expect(text).toContain([
      "- fields.yml (optional, beside layers.json) lists the fields each table and column records, in",
      "  order; each is one setting, such as purpose: '…'. Without it, ERD Studio's starting set is used.",
      '',
      'Check the files with `erd-studio doctor`.',
    ].join('\n'));
    expect(text.match(/fields\.yml/g)).toHaveLength(1);
    expect(semanticReadmeText([{ id: 'main', label: 'Main' }])).toContain('- fields.yml (optional, beside layers.json)');
  });
});

describe('semanticReadmeText with the project\'s layers', () => {
  it('lists them in order, each with its label and folder, before the tree', () => {
    const text = semanticReadmeText([
      { id: 'bronze', label: 'Bronze' },
      { id: 'raw_vault', label: 'Raw Vault' },
      { id: 'gold', label: 'Gold' },
    ]);
    expect(text).toContain([
      'Every file lives under a layer folder. This project\'s layers, in order (layers.json lists them):',
      '',
      '    1. Bronze      bronze/',
      '    2. Raw Vault   raw_vault/',
      '    3. Gold        gold/',
      '',
      'In each layer folder:',
      '',
      '    <layer>/tables/<schema>/<table>.dbml   one table: Table <schema>.<table> { … }',
    ].join('\n'));
    expect(text).not.toContain('(bronze, silver, gold, …)');
    expect(text.endsWith('Check the files with `erd-studio doctor`.\n')).toBe(true);
  });

  it('names the usual layers when it has none to list', () => {
    expect(semanticReadmeText([])).toBe(semanticReadmeText());
    expect(semanticReadmeText()).toContain('Every file lives under a layer folder (bronze, silver, gold, …), and layers.json lists the layers:\n\n    <layer>/tables/');
  });

  it('is what semanticReadmeCreate writes', () => {
    const layers = [{ id: 'main', label: 'Main' }];
    expect(semanticReadmeCreate('/p/.erd-studio', () => false, layers)).toMatchObject({ text: semanticReadmeText(layers) });
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
