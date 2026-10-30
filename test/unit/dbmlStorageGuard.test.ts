/**
 * detectDbmlStorage — the stable guard's detector for projects a newer ERD
 * Studio (the 1.9 pre-release or 2.0) stored as DBML. It must find every
 * shape 2.0 writes, and nothing in a YAML / JSON project (an export saved
 * into the folder included), since a false positive would lock a stable user
 * out of their own project.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CURRENT_SCHEMA_VERSION } from '@erd-studio/core';
import {
  DBML_READING_SCHEMA_VERSION, DBML_STORAGE_MESSAGE, detectDbmlStorage, semanticRootsOfDiagram,
} from '../../src/services/dbmlStorageGuard';
import {
  DIAGRAM_DBML, EXPORT_DBML, FIXTURE_ROOT, LAYER_DIAGRAM_DBML, LAYER_RELATIONSHIPS_DBML, LAYER_TABLE_DBML,
  RELATIONSHIPS_DBML, TABLE_DBML, makeDbmlProject, makeLayerFirstDbmlProject,
} from './dbmlStorageGuard.fixture';

let root: string;
let semantic: string;

function write(rel: string, text: string): void {
  const file = path.join(semantic, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbml-guard-'));
  semantic = path.join(root, '.erd-studio');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('detectDbmlStorage: projects a newer ERD Studio stored as DBML', () => {
  it('finds a converted project', () => {
    makeDbmlProject(path.join(root, 'p'));
    expect(detectDbmlStorage(path.join(root, 'p', '.erd-studio'))).not.toBeNull();
  });

  it('finds a table file at the top of tables/', () => {
    write('tables/dim_customer.dbml', TABLE_DBML);
    expect(detectDbmlStorage(semantic)).toEqual({ kind: 'table', file: 'tables/dim_customer.dbml' });
  });

  it('finds a table file one folder down, including a folder name with a space', () => {
    write('tables/SAP FI/dim_customer.dbml', TABLE_DBML);
    expect(detectDbmlStorage(semantic)).toEqual({ kind: 'table', file: 'tables/SAP FI/dim_customer.dbml' });
  });

  it('finds a relationships file on its name alone, in any case', () => {
    write('tables/gold/_Relationships.dbml', RELATIONSHIPS_DBML);
    expect(detectDbmlStorage(semantic)).toEqual({ kind: 'relationships', file: 'tables/gold/_Relationships.dbml' });
  });

  it('finds a diagram in a layer folder even with no table files yet (a new 2.0 project)', () => {
    write('layers.json', '{"layers":[{"id":"silver","label":"Silver"}]}');
    write('silver/sales.dbml', DIAGRAM_DBML);
    expect(detectDbmlStorage(semantic)).toEqual({ kind: 'diagram', file: 'silver/sales.dbml' });
  });

  it('reads a diagram that starts with a byte-order mark', () => {
    write('silver/sales.dbml', `﻿${DIAGRAM_DBML}`);
    expect(detectDbmlStorage(semantic)?.kind).toBe('diagram');
  });

  it('finds a table beside YAML tables (a part-converted, mixed library)', () => {
    write('tables/dim_date.yml', 'name: dim_date\ncolumns: []\n');
    write('tables/dim_customer.dbml', TABLE_DBML);
    expect(detectDbmlStorage(semantic)?.kind).toBe('table');
  });

  it('the message says what happened and what to do', () => {
    expect(DBML_STORAGE_MESSAGE).toBe(
      'This project is stored as DBML by a newer ERD Studio (the 1.9 pre-release or 2.0). '
        + 'To open it, switch ERD Studio to its pre-release version, or update to 2.0 once it is released.',
    );
  });

  it('names the pre-release switch: on the latest stable there is no update, only Switch to Pre-Release Version', () => {
    expect(DBML_STORAGE_MESSAGE).toMatch(/switch ERD Studio to its pre-release version/);
    expect(DBML_STORAGE_MESSAGE).not.toMatch(/Update ERD Studio to open it/);
  });
});

describe("detectDbmlStorage: the layer-first tree 1.9.4 and 2.0 write", () => {
  it('finds a converted project', () => {
    const converted = makeLayerFirstDbmlProject(path.join(root, 'p'));
    expect(detectDbmlStorage(converted)?.file).toMatch(/^gold\/(diagrams|relationships|tables\/gold)\/[a-z_]+\.dbml$/);
  });

  it('finds a diagram in <layer>/diagrams/', () => {
    write('layers.json', '{"layers":[{"id":"gold","label":"Gold"}]}');
    write('gold/diagrams/sales.dbml', LAYER_DIAGRAM_DBML);
    expect(detectDbmlStorage(semantic)).toEqual({ kind: 'diagram', file: 'gold/diagrams/sales.dbml' });
  });

  it('finds a relationships file in <layer>/relationships/', () => {
    write('gold/relationships/sales.dbml', LAYER_RELATIONSHIPS_DBML);
    expect(detectDbmlStorage(semantic)).toEqual({ kind: 'relationships', file: 'gold/relationships/sales.dbml' });
  });

  it('finds a table file in <layer>/tables/<schema>/', () => {
    write('gold/tables/gold/fct_order.dbml', LAYER_TABLE_DBML);
    expect(detectDbmlStorage(semantic)).toEqual({ kind: 'table', file: 'gold/tables/gold/fct_order.dbml' });
  });

  it('finds it in a tables/ layer folder too (a pre-v6 project)', () => {
    write('tables/orders.json', '{"schemaVersion":5}');
    write('tables/tables/gold/fct_order.dbml', LAYER_TABLE_DBML);
    expect(detectDbmlStorage(semantic)).toEqual({ kind: 'table', file: 'tables/tables/gold/fct_order.dbml' });
  });

  it('does not count a saved export in any of those places', () => {
    write('gold/diagrams/sales.dbml', EXPORT_DBML);
    write('gold/relationships/sales.dbml', EXPORT_DBML);
    write('gold/tables/gold/fct_order.dbml', EXPORT_DBML);
    write('gold/sales.json', '{"schemaVersion":6}');
    expect(detectDbmlStorage(semantic)).toBeNull();
  });

  it('does not count a diagrams/ file that does not declare erd_schema_version', () => {
    write('gold/diagrams/sketch.dbml', 'Table a {\n  id int [pk]\n}\n');
    expect(detectDbmlStorage(semantic)).toBeNull();
  });

  it('does not count a table directly in <layer>/tables/ or deeper than one schema folder', () => {
    write('gold/tables/fct_order.dbml', LAYER_TABLE_DBML);
    write('gold/tables/gold/archive/fct_order.dbml', LAYER_TABLE_DBML);
    expect(detectDbmlStorage(semantic)).toBeNull();
  });

  it('does not look inside folders that are never layers (logical-models/, templates/, hidden, the tables/ library)', () => {
    write('logical-models/relationships/x.dbml', LAYER_RELATIONSHIPS_DBML);
    write('templates/diagrams/x.dbml', LAYER_DIAGRAM_DBML);
    write('.cache/tables/gold/x.dbml', LAYER_TABLE_DBML);
    write('tables/dim_date.yml', 'name: dim_date\n');
    write('tables/gold/fct_order.yml', 'name: fct_order\n');
    write('tables/gold/relationships/x.dbml', LAYER_RELATIONSHIPS_DBML);
    expect(detectDbmlStorage(semantic)).toBeNull();
  });
});

describe('semanticRootsOfDiagram: the ERD Studio folder of a restored diagram tab', () => {
  /** The first root the no-project stub editor would guard, as extension.ts tries them. */
  const guardedRoot = (documentPath: string): string | undefined =>
    semanticRootsOfDiagram(documentPath).find((r) => detectDbmlStorage(r) !== null);

  it('a layer-first diagram resolves to the ERD Studio folder, not its layer', () => {
    write('layers.json', '{"layers":[{"id":"gold","label":"Gold"}]}');
    write('gold/diagrams/sales.dbml', LAYER_DIAGRAM_DBML);
    const tab = path.join(semantic, 'gold', 'diagrams', 'sales.dbml');
    expect(semanticRootsOfDiagram(tab)[0]).toBe(semantic);
    expect(guardedRoot(tab)).toBe(semantic);
    expect(detectDbmlStorage(semantic)?.file).toBe('gold/diagrams/sales.dbml');
  });

  it('a diagram directly in a layer folder resolves two levels up', () => {
    write('silver/sales.dbml', DIAGRAM_DBML);
    const tab = path.join(semantic, 'silver', 'sales.dbml');
    expect(semanticRootsOfDiagram(tab)).toEqual([semantic]);
    expect(guardedRoot(tab)).toBe(semantic);
  });

  it('a 1.9 layer that is itself named diagrams still resolves to the ERD Studio folder', () => {
    write('diagrams/sales.dbml', DIAGRAM_DBML);
    const tab = path.join(semantic, 'diagrams', 'sales.dbml');
    expect(semanticRootsOfDiagram(tab)).toEqual([root, semantic]);
    expect(guardedRoot(tab)).toBe(semantic);
  });
});

describe('the guard stands down where core reads DBML (a merge into 2.0)', () => {
  it('this core cannot read DBML yet; when this fails, delete the stable DBML guard', () => {
    expect(
      CURRENT_SCHEMA_VERSION,
      'core reads DBML storage now: delete src/services/dbmlStorageGuard.ts, src/providers/dbmlStorageGuardUi.ts, '
        + 'their call sites and tests (search for dbmlStorageGuard)',
    ).toBeLessThan(DBML_READING_SCHEMA_VERSION);
    expect(DBML_READING_SCHEMA_VERSION).toBe(7);
  });
});

describe('detectDbmlStorage: YAML / JSON projects are never flagged', () => {
  it('the main fixture (logical-models/ and JSON diagrams)', () => {
    expect(detectDbmlStorage(path.join(FIXTURE_ROOT, '.erd-studio'))).toBeNull();
  });

  it('a missing folder, an empty folder and a file where the folder should be', () => {
    expect(detectDbmlStorage(semantic)).toBeNull();
    fs.mkdirSync(semantic);
    expect(detectDbmlStorage(semantic)).toBeNull();
    fs.rmSync(semantic, { recursive: true });
    fs.writeFileSync(semantic, '');
    expect(detectDbmlStorage(semantic)).toBeNull();
  });

  it('a v6 YAML library in tables/', () => {
    write('tables/dim_date.yml', 'name: dim_date\n');
    write('tables/gold/fct_order.yml', 'name: fct_order\n');
    write('silver/sales.json', '{"schemaVersion":6}');
    expect(detectDbmlStorage(semantic)).toBeNull();
  });

  it('a DBML export saved into a layer folder or the table library', () => {
    write('silver/showcase.dbml', EXPORT_DBML);
    write('silver/showcase.dbdiagram', '{}');
    write('tables/showcase.dbml', EXPORT_DBML);
    write('tables/dim_date.yml', 'name: dim_date\n');
    expect(detectDbmlStorage(semantic)).toBeNull();
  });

  it('hand-written DBML in a layer folder that is not an ERD Studio diagram', () => {
    write('silver/sketch.dbml', 'Table a {\n  id int [pk]\n}\n');
    expect(detectDbmlStorage(semantic)).toBeNull();
  });

  it('DBML in folders 2.0 never stores tables in (logical-models/, templates/, hidden, deeper than one folder)', () => {
    write('logical-models/dim_customer.dbml', TABLE_DBML);
    write('templates/x.dbml', TABLE_DBML);
    write('.cache/x.dbml', DIAGRAM_DBML);
    write('tables/a/b/x.dbml', TABLE_DBML);
    write('tables/.hidden.dbml', TABLE_DBML);
    write('tables/dim_date.yml', 'name: dim_date\n');
    expect(detectDbmlStorage(semantic)).toBeNull();
  });

  it('a YAML / JSON project with ordinary layer folders', () => {
    write('layers.json', '{"layers":[{"id":"silver","label":"Silver"},{"id":"gold","label":"Gold"}]}');
    write('logical-models/dim_customer.yml', 'name: dim_customer\n');
    write('silver/customer-360.json', '{"schemaVersion":5}');
    write('gold/reporting.json', '{"schemaVersion":5}');
    expect(detectDbmlStorage(semantic)).toBeNull();
  });

  it('a layer folder that happens to hold a tables/ subfolder with no .dbml files', () => {
    write('gold/reporting.json', '{"schemaVersion":6}');
    write('gold/tables/gold/fct_order.yml', 'name: fct_order\n');
    write('gold/tables/gold/notes.md', '# notes\n');
    write('gold/relationships/readme.txt', 'x\n');
    write('gold/diagrams/sales.json', '{"schemaVersion":6}');
    expect(detectDbmlStorage(semantic)).toBeNull();
  });

  it('a tables/ layer folder (pre-v6 project) holding an exported .dbml', () => {
    write('tables/orders.json', '{"schemaVersion":5}');
    write('tables/orders.dbml', 'Table orders {\n  id int\n}\n');
    expect(detectDbmlStorage(semantic)).toBeNull();
  });

  it('but a 2.0 diagram in a tables/ layer folder still counts', () => {
    write('tables/orders.json', '{"schemaVersion":5}');
    write('tables/new.dbml', DIAGRAM_DBML);
    expect(detectDbmlStorage(semantic)?.kind).toBe('diagram');
  });
});
