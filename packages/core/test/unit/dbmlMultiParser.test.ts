/**
 * Law 5 for every writer test (§4.5, §9.3 of the native DBML storage spec):
 * each text the writer tests produce — from an input that parses in all
 * three parsers, or from nothing — is compiled again as a multi-file project
 * with its `use` targets under `@dbml/parse` 9.1.1, 10.3.1 and 11.0.0, and
 * must give no error and no warning. The cases come from
 * `../dbmlWriterCases/*` (the same ones `dbmlWriteTable`,
 * `dbmlWriteRelationships` and `dbmlWriteDiagram` check). A case whose input
 * holds an 11.0-only typed value is held to 11.0.0 only (§2.2); one whose
 * input does not compile as a project (a stale `use` path, on purpose) is
 * listed with no parsers.
 */
import { describe, it, expect } from 'vitest';

import { NEW_TABLE_CASES, TABLE_CASES } from '../dbmlWriterCases/tableCases';
import { RELATIONSHIPS_CASES } from '../dbmlWriterCases/relationshipsCases';
import { DIAGRAM_CASES, NEW_DIAGRAM_CASES } from '../dbmlWriterCases/diagramCases';
import { lawFiveParsers, projectDiagnostics, projectOf, type WriterCase } from '../dbmlWriterSupport';

const GROUPS: ReadonlyArray<readonly [string, readonly WriterCase[]]> = [
  ['table writer', [...TABLE_CASES, ...NEW_TABLE_CASES]],
  ['relationships writer', RELATIONSHIPS_CASES],
  ['diagram writer', [...DIAGRAM_CASES, ...NEW_DIAGRAM_CASES]],
];

describe.each(GROUPS)('every %s output parses in 9.1.1, 10.3.1 and 11.0.0', (_group, cases) => {
  for (const c of cases) {
    it(c.name, () => {
      const outcome = c.run();
      const parsers = lawFiveParsers(outcome);
      if (parsers.length === 0) return;
      const files = projectOf(outcome);
      expect(projectDiagnostics(files, [outcome.path], parsers)).toEqual([]);
      // The context alone compiles too, so a diagnostic above is the written file's.
      expect(projectDiagnostics(files, Object.keys(outcome.context ?? {}), parsers)).toEqual([]);
    });
  }
});

it('holds nearly every writer case to all three parsers (only deliberate exceptions are not)', () => {
  const held = GROUPS.flatMap(([, cases]) => cases).map((c) => [c.name, lawFiveParsers(c.run())] as const);
  const partial = held.filter(([, p]) => p.length < 3).map(([name]) => name);
  // Typed 11.0 values (11.0.0 only), and inputs that deliberately leave a use line missing or stale.
  expect(partial).toEqual([
    'typed values stay byte for byte through an edit of another column',
    'changing a typed value writes it quoted',
    'hand-added and missing use lines are left alone when their table is not in the edit (Law 1)',
    'the use block of a file with none goes after a header comment followed by a blank line',
    '…and at offset 0 when the comment runs straight into the first Ref',
    'a stale path is rewritten on an edit; a path whose file exists is never repointed',
    'an existing member that resolves to a YAML table keeps its line bytes (D20)',
  ]);
  expect(held.filter(([, p]) => p.length === 3).length).toBeGreaterThan(80);
});
