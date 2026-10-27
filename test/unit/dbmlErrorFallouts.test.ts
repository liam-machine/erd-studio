/**
 * Native DBML storage's error kinds reach every host place that names a
 * broken file (§4.7 of docs/plans/native-dbml-storage.md): the canvas load
 * telemetry, the diagram-file problem with its Open File button, the
 * broken-table notification and the CLI's fix hints. YAML wording is unchanged.
 */

import { describe, expect, it } from 'vitest';

import { SubjectAreaFileError } from '@erd-studio/core';
import { classifySubjectAreaLoadFailure } from '../../src/providers/SemanticEditorProvider';
import { describeDiagramFileProblem } from '../../src/services/commandErrors';
import { tableFileErrorNotice, tableFileErrorTip } from '../../src/commands/openModelFile';
import { TABLE_FILE_HINTS, describeUnreadable, unreadableHint, type UnreadableTableFile } from '../../src/cli/diff';

const DIAGRAM = '/p/.erd-studio/gold/sales.dbml';

describe('a .dbml diagram DBML cannot read', () => {
  it("is a 'dbml' load failure, and a conflicted one is still 'conflict'", () => {
    expect(classifySubjectAreaLoadFailure(new SubjectAreaFileError('invalid-dbml', DIAGRAM, 'bad', { line: 2, column: 3 }))).toBe('dbml');
    expect(classifySubjectAreaLoadFailure(new SubjectAreaFileError('invalid-dbml', DIAGRAM, 'bad', { mergeConflict: true, line: 2 }))).toBe('conflict');
    expect(classifySubjectAreaLoadFailure(new SubjectAreaFileError('invalid-json', '/p/.erd-studio/gold/s.json', 'bad'))).toBe('json');
  });

  it('keeps its Open File button at the line and column', () => {
    expect(describeDiagramFileProblem(new SubjectAreaFileError('invalid-dbml', DIAGRAM, 'm', { line: 4, column: 9 }), DIAGRAM, 'gold/sales.dbml')).toEqual({
      reason: 'there is a DBML mistake at line 4, column 9', openable: true, line: 4, column: 9,
    });
    expect(describeDiagramFileProblem(new SubjectAreaFileError('invalid-dbml', DIAGRAM, 'm'), DIAGRAM, 'gold/sales.dbml')).toEqual({
      reason: 'it is not valid DBML', openable: true,
    });
    expect(describeDiagramFileProblem(new SubjectAreaFileError('invalid-dbml', DIAGRAM, 'm', { mergeConflict: true, line: 3 }), DIAGRAM, 'gold/sales.dbml')).toEqual({
      reason: 'it has unresolved git merge conflicts, first at line 3. Keep one side of each conflict, then try again', openable: true, line: 3,
    });
  });
});

describe('a broken .dbml table file', () => {
  const notice = (kind: Parameters<typeof tableFileErrorNotice>[0]['kind'], line?: number, code?: string) =>
    tableFileErrorNotice({ filePath: '/p/.erd-studio/tables/gold/fct_order.dbml', kind, line, ...(code !== undefined ? { code } : {}) });

  it('is called a DBML error, with a tip for its kind', () => {
    expect(notice('dbmlSyntax', 4)).toBe(
      "fct_order.dbml has a DBML error on line 4 and can't be shown on the diagram. Tip: check the DBML syntax on that line (a missing bracket, quote or brace).",
    );
    expect(tableFileErrorTip('dbmlSyntax', true)).toContain('keep one side of each conflict');
    // YAML is unchanged.
    expect(tableFileErrorNotice({ filePath: '/p/.erd-studio/logical-models/x.yml', kind: 'yamlScalar', line: 4 })).toContain('has a YAML error on line 4');
  });

  it('gives the quote tip only for an unquoted value (3025, 3075), never for 3073, 5001 or no code', () => {
    for (const code of ['3025', '3075']) {
      expect(notice('dbmlInvalid', 2, code)).toContain("Tip: quote the value, as in grain: 'One row per order line'.");
    }
    for (const code of ['3073', '5001', '3023', undefined]) {
      const text = notice('dbmlInvalid', 2, code);
      expect(text).not.toMatch(/quote/i);
      expect(text).toContain('Tip: fix the DBML on that line.');
    }
  });

  it('words a structure tip by its rule, never about Ref or use lines', () => {
    expect(notice('dbmlStructure', 1, 'structure:notOneTable')).toContain('Tip: a table file holds exactly one Table. Move any other Table to its own file.');
    expect(notice('dbmlStructure', 1, 'structure:nameMismatch')).toContain("Tip: name the Table as its file, or rename the file to the Table's name.");
    expect(notice('dbmlStructure', 1, 'structure:unsupportedElement')).toContain('Remove the Project, TableGroup, Note or other block.');
    expect(notice('dbmlStructure')).toContain('Tip: a table file holds exactly one Table, named as its file, and no Project, TableGroup or Note.');
    // A parser (binding) code is fixed where the parser points.
    expect(notice('dbmlStructure', 3, '4000')).toContain('Tip: fix the DBML on that line.');
    for (const code of ['structure:notOneTable', 'structure:nameMismatch', 'structure:unsupportedElement', '4000', undefined]) {
      expect(notice('dbmlStructure', 1, code)).not.toMatch(/\bRef\b|\buse\b|_relationships/);
    }
  });

  it('gets a CLI hint for every kind, with the line where the hint points at one', () => {
    const unreadable = (u: Partial<UnreadableTableFile>): UnreadableTableFile =>
      ({ name: 'fct_order', file: '.erd-studio/tables/gold/fct_order.dbml', kind: 'dbmlSyntax', message: 'm', ...u }) as UnreadableTableFile;
    expect(TABLE_FILE_HINTS.dbmlStructure).toBe('a table file holds exactly one Table, named as its file, and no Project, TableGroup or Note');
    expect(unreadableHint(unreadable({ kind: 'dbmlSyntax', line: 7 }))).toBe('fix the DBML at line 7');
    expect(unreadableHint(unreadable({ kind: 'dbmlSyntax' }))).toBe('fix the DBML at that line');
    expect(unreadableHint(unreadable({ kind: 'dbmlInvalid', line: 2 }))).toBe('fix the DBML at line 2');
    expect(unreadableHint(unreadable({ kind: 'dbmlInvalid', line: 2, code: '3075' }))).toBe("fix the DBML at line 2 — quote the value, as in grain: 'One row per order line'");
    expect(describeUnreadable(unreadable({ kind: 'dbmlInvalid', line: 2, code: '3025' }), 'doctor'))
      .toBe("fct_order.dbml line 2: DBML error (3025) — fix the DBML at line 2 — quote the value, as in grain: 'One row per order line'");
    expect(describeUnreadable(unreadable({ file: '.erd-studio/logical-models/x.yml', kind: 'yamlScalar', line: 4, code: 'BAD_SCALAR_START' }), 'doctor'))
      .toBe('x.yml line 4: YAML error (BAD_SCALAR_START) — wrap the value in double quotes');
  });

  it('gives the CLI quote advice only for 3025 and 3075, never for 3073 or 5001', () => {
    const unreadable = (code: string): UnreadableTableFile =>
      ({ name: 'fct_order', file: '.erd-studio/tables/gold/fct_order.dbml', kind: 'dbmlInvalid', line: 3, code, message: 'm' }) as UnreadableTableFile;
    for (const code of ['3073', '5001', '3023']) {
      expect(unreadableHint(unreadable(code))).toBe('fix the DBML at line 3');
      expect(describeUnreadable(unreadable(code), 'diff')).toBe(`fct_order.dbml line 3: DBML error (${code}) — fix the DBML at line 3`);
    }
  });

  it('words a CLI structure hint by its rule', () => {
    const unreadable = (code?: string): UnreadableTableFile =>
      ({ name: 'fct_order', file: '.erd-studio/tables/gold/fct_order.dbml', kind: 'dbmlStructure', line: 1, ...(code ? { code } : {}), message: 'm' }) as UnreadableTableFile;
    expect(unreadableHint(unreadable('structure:notOneTable'))).toBe('a table file holds exactly one Table — move any other Table to its own file');
    expect(unreadableHint(unreadable('structure:nameMismatch'))).toBe("name the Table as its file (or rename the file to the Table's name)");
    expect(unreadableHint(unreadable('structure:unsupportedElement'))).toBe('a table file holds one Table and nothing else — remove the Project, TableGroup, Note or other block');
    expect(unreadableHint(unreadable())).toBe(TABLE_FILE_HINTS.dbmlStructure);
    expect(unreadableHint(unreadable('4000'))).toBe('fix the DBML at line 1');
  });
});
