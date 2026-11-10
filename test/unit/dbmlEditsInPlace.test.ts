/**
 * #275 (3): an edit of a DBML project is a minimal text splice. The docs
 * promise "comments, formatting and every DBML setting ERD Studio does not
 * use survive" (docs/semantic-domain-json-reference.md), so a table rename,
 * a Move Table or a new relationship changes only the spans it must:
 *
 * - no other line of a hand-laid table file, diagram or relationships file
 *   is re-aligned (the host formats only a file already in the canonical
 *   layout, `dbmlWriters.ts`);
 * - no blank line appears between Refs that had none (`separateRefGroups`
 *   adds one only next to a Ref the edit added);
 * - a new `use` line never lands above a file's own header comment
 *   (`leadingCommentEnd`).
 *
 * Driven on a copy of test/fixtures/dbml-native through the host planners
 * the canvas and the commands use (`planDbmlBatch`, `planDbmlTableMoves`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TableLibraryService } from '../../src/services/logicalModelService';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { planDbmlTableMoves } from '../../src/commands/dbmlLifecycle';
import type { FileWrite } from '../../src/services/fileWrites';
import type { TableRelationship } from '../../src/types/semantic';

const DBML_NATIVE = path.resolve(__dirname, '../fixtures/dbml-native');

let tmp: string;
const erd = (...p: string[]): string => path.join(tmp, '.erd-studio', ...p);
const rel = (p: string): string => path.relative(erd(), p).split(path.sep).join('/');
const read = (p: string): string => fs.readFileSync(erd(p), 'utf-8');
const readText = (p: string): string | null => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-edits-in-place-'));
  fs.cpSync(DBML_NATIVE, tmp, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function services(): { lib: TableLibraryService; sas: SubjectAreaService } {
  const lib = new TableLibraryService(tmp, '.erd-studio');
  const sas = new SubjectAreaService(new LayerService(tmp, '.erd-studio'));
  sas.setTableLibraryService(lib);
  return { lib, sas };
}

/** The planned text of each written file, by semantic-relative path (null for a delete). */
function byPath(writes: readonly FileWrite[]): Map<string, string | null> {
  return new Map(writes.map((w) => [rel(w.path), w.kind === 'delete' ? null : w.text]));
}

/** Every line of `before` that does not mention `name` must be in `after`, byte for byte, in the same order. */
function untouchedLinesKept(before: string, after: string, name: RegExp): string[] {
  const afterLines = after.split('\n');
  const changed: string[] = [];
  let at = 0;
  for (const line of before.split('\n')) {
    if (name.test(line)) continue;
    const found = afterLines.indexOf(line, at);
    if (found < 0) changed.push(line);
    else at = found + 1;
  }
  return changed;
}

/** How many blank lines sit between Refs (after the first Ref, before the last). */
function blankLinesBetweenRefs(text: string): number {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.startsWith('Ref'));
  let last = -1;
  lines.forEach((l, i) => { if (l.startsWith('Ref')) last = i; });
  return lines.slice(first, last).filter((l) => l.trim() === '').length;
}

describe('#275: a table rename splices only the name', () => {
  function rename(): Map<string, string | null> {
    const { lib } = services();
    const model = lib.getTable('dim_customer')!;
    const { writes } = lib.planDbmlBatch({ ops: { save: [{ model: { ...model, name: 'dim_client' }, fromName: 'dim_customer' }] } });
    return byPath(writes);
  }

  it('the renamed table file is the old file with only its name changed (no column re-alignment)', () => {
    const before = read('gold/tables/gold/dim_customer.dbml');
    const after = rename().get('gold/tables/gold/dim_client.dbml');
    expect(after).toBe(before.replace('Table gold.dim_customer ', 'Table gold.dim_client '));
  });

  it('a diagram showing it keeps every other use line byte for byte (no re-padded use block)', () => {
    const before = read('gold/diagrams/sales.dbml');
    const after = rename().get('gold/diagrams/sales.dbml')!;
    expect(untouchedLinesKept(before, after, /dim_customer/)).toEqual([]);
  });

  it('customers.dbml: no blank line appears between its Refs, and every other line keeps its bytes', () => {
    const before = read('gold/relationships/customers.dbml');
    const after = rename().get('gold/relationships/customers.dbml')!;
    expect(blankLinesBetweenRefs(after)).toBe(blankLinesBetweenRefs(before));
    expect(untouchedLinesKept(before, after, /dim_customer/)).toEqual([]);
  });
});

describe('#275: Move Table splices only the paths that change', () => {
  function move(): Map<string, string | null> {
    const { lib, sas } = services();
    const diagrams = sas.listSubjectAreas(tmp, '.erd-studio').filter((d) => d.storage === 'dbml').map((d) => d.filePath);
    return byPath(planDbmlTableMoves({ tableLibraryService: lib, moves: [{ name: 'dim_customer', toLayer: 'silver' }], diagrams, readText }).writes);
  }

  it('a diagram showing it keeps every other use line byte for byte (no re-padded use block)', () => {
    const before = read('gold/diagrams/sales.dbml');
    const after = move().get('gold/diagrams/sales.dbml')!;
    expect(untouchedLinesKept(before, after, /dim_customer/)).toEqual([]);
  });

  it('customers.dbml: only the moved table\'s use line changes; no blank line appears between its Refs', () => {
    const before = read('gold/relationships/customers.dbml');
    const after = move().get('gold/relationships/customers.dbml')!;
    expect(blankLinesBetweenRefs(after)).toBe(blankLinesBetweenRefs(before));
    expect(after.split('\n').filter((l, i) => l !== before.split('\n')[i])).toEqual([
      expect.stringMatching(/^use \{ table gold\.dim_customer \} +from '\.\.\/\.\.\/silver\/tables\/gold\/dim_customer\.dbml'$/),
    ]);
  });
});

describe('#275: a new relationship into a file with a hand-written header comment', () => {
  it('its new use line goes below the header comment, never above it', () => {
    const { lib } = services();
    const model = lib.getTable('customer_profile')!;
    const added: TableRelationship = { fromColumn: 'customer_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' } as TableRelationship;
    model.relationships = [...(model.relationships ?? []), added];
    const before = read('gold/relationships/customers.dbml');
    const after = byPath(lib.planDbmlBatch({ ops: { save: [{ model }] } }).writes).get('gold/relationships/customers.dbml')!;
    // The relationship really went to customers.dbml (customer_profile's Refs live there).
    expect(after).toContain('Ref: gold.customer_profile.customer_key >? calendar.dim_date.date_key');
    expect(after.split('\n')[0]).toBe(before.split('\n')[0]);
    expect(after).toMatch(/^\/\/ Customers and their profiles[^\n]*\nuse \{ table calendar\.dim_date \} +from '\.\.\/\.\.\/silver\/tables\/calendar\/dim_date\.dbml'\n/);
  });
});

describe('#275: a rename to a name longer than every other in its group re-pads nothing else', () => {
  function rename(from: string, to: string): Map<string, string | null> {
    const { lib } = services();
    const model = lib.getTable(from)!;
    return byPath(lib.planDbmlBatch({ ops: { save: [{ model: { ...model, name: to }, fromName: from }] } }).writes);
  }

  // Both relationships files and the diagram are in the canonical layout (the formatter leaves them as
  // they are), so this is ERD Studio's own layout: the renamed lines change, the other use lines keep their padding.
  for (const file of ['gold/relationships/customers.dbml', 'gold/relationships/gold.dbml', 'gold/diagrams/sales.dbml']) {
    it(`${file}: only the lines naming the table change`, () => {
      const before = read(file);
      const after = rename('dim_customer', 'dim_customer_master_record').get(file)!;
      expect(after).toContain('dim_customer_master_record');
      expect(untouchedLinesKept(before, after, /dim_customer/)).toEqual([]);
      expect(after.split('\n').length).toBe(before.split('\n').length);
    });
  }

  it('customers.dbml: a longer customer_profile keeps the other use lines byte for byte too', () => {
    const before = read('gold/relationships/customers.dbml');
    const after = rename('customer_profile', 'customer_profile_extended').get('gold/relationships/customers.dbml')!;
    expect(untouchedLinesKept(before, after, /customer_profile/)).toEqual([]);
  });
});

describe('#275: a rename that re-sorts a Ref in a hand-split file adds no blank line', () => {
  for (const [from, to] of [['dim_customer', 'a_customer'], ['customer_profile', 'zz_profile'], ['dim_region', 'a_region']]) {
    it(`${from} → ${to}: customers.dbml keeps its Refs together`, () => {
      const { lib } = services();
      const model = lib.getTable(from)!;
      const before = read('gold/relationships/customers.dbml');
      const after = byPath(lib.planDbmlBatch({ ops: { save: [{ model: { ...model, name: to }, fromName: from }] } }).writes)
        .get('gold/relationships/customers.dbml')!;
      expect(after).toContain(to);
      expect(blankLinesBetweenRefs(after)).toBe(blankLinesBetweenRefs(before));
    });
  }
});

describe('#275: deleting a relationship from between two blank lines leaves one blank line', () => {
  it('a hand-laid, blank-separated customers.dbml loses the Ref line and one blank line; every other line stays', () => {
    // Hand-laid: the use lines are not aligned, so the file is not in the canonical layout and gets the splice alone.
    const hand = `// Customers and their profiles, split out of gold.dbml by hand.
use { table gold.customer_profile } from '../tables/gold/customer_profile.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table gold.dim_region } from '../tables/gold/dim_region.dbml'

Ref: gold.dim_customer.customer_key ?- gold.customer_profile.customer_key

Ref region: gold.customer_profile.preferred_region_code <>? gold.dim_region.region_code

Ref parent: gold.dim_customer.parent_customer_key >? gold.dim_customer.customer_key
`;
    fs.writeFileSync(erd('gold/relationships/customers.dbml'), hand);
    const { lib } = services();
    const model = lib.getTable('customer_profile')!;
    model.relationships = (model.relationships ?? []).filter((r) => r.toModel !== 'dim_region');
    const after = byPath(lib.planDbmlBatch({ ops: { save: [{ model }] } }).writes).get('gold/relationships/customers.dbml')!;
    expect(after).not.toMatch(/\n\n\n/);
    // dim_region's use line goes with its last Ref; nothing else changes.
    expect(after).toBe(hand
      .replace("use { table gold.dim_region } from '../tables/gold/dim_region.dbml'\n", '')
      .replace('Ref region: gold.customer_profile.preferred_region_code <>? gold.dim_region.region_code\n\n', ''));
  });
});
