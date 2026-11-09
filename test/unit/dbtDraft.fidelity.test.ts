/**
 * Import from dbt's fidelity, by class of input (the dbt-synthea-omop
 * sample's failures, each with variants):
 *
 * - dbt's `not_null` is read in every form it is written, kept on the column
 *   (`meta.dbml.not_null`, as Import DBML keeps DBML's, D19), and counted for
 *   the D18 note (dbt B1);
 * - a relationship test from a drawn model to one the draft does not draw is
 *   named in Not drawn and counted in the table's FK count, and comes back
 *   through Add Existing Model (dbt B2);
 * - `relationships_where` conditions not kept, models with no columns, the
 *   schema written from the layer and selectors.yml are said (G2, G3, G4, I1).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_LAYERS } from '@erd-studio/core';
import {
  buildDbtDraft,
  listDraftScopes,
  modelsWithoutColumns,
  notNullColumnsOf,
  seedTableFromDbt,
  type DbtDraft,
} from '../../src/services/dbtDraft';
import { DBT_KEEP_SELECTORS_SENTENCE, dbtLayerSchemaNote, draftFromDbt } from '../../src/services/draftModel';
import { describeImportTable } from '../../src/services/importReview';
import { YmlParserService } from '../../src/services/ymlParserService';
import type { Draft, DraftTarget } from '../../src/types/draft';
import type { YmlData } from '../../src/types/ymlData';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-fidelity-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

async function load(yml: string): Promise<YmlData> {
  fs.mkdirSync(path.join(tmp, 'models', 'marts'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'models', 'marts', 'schema.yml'), yml);
  return new YmlParserService().loadYmlData(tmp);
}

const PEOPLE = `version: 2
models:
  - name: location
    columns:
      - name: location_id
        data_tests: [unique, not_null]
  - name: care_site
    columns:
      - name: care_site_id
        tests: [unique]
      - name: location_id
        tests:
          - not_null
          - relationships:
              to: ref('location')
              field: location_id
  - name: person
    columns:
      - name: person_id
        data_tests:
          - unique
          - not_null:
              config:
                severity: warn
      - name: location_id
        data_tests:
          - relationships:
              arguments:
                to: ref('location')
                field: location_id
      - name: care_site_id
        data_tests:
          - not_null
          - relationships:
              to: ref('care_site')
              field: care_site_id
      - name: provider_id
        data_tests:
          - relationships:
              to: ref('provider')
              field: provider_id
      - name: gender_concept_id
        data_tests:
          - not_null
          - dbt_utils.relationships_where:
              to: ref('concept')
              field: concept_id
              from_condition: gender_concept_id <> 0
  - name: provider
  - name: concept
    columns:
      - name: concept_id
        tests: [unique]
`;

const target = (name: string, layer = 'gold', dbml = true): DraftTarget => ({
  layer, layerLabel: layer === 'gold' ? 'Gold' : layer, name, diagramFile: `.erd-studio/${layer}/${dbml ? `diagrams/${name}.dbml` : `${name}.json`}`,
});

function view(draft: DbtDraft, data: YmlData, extra: Partial<Parameters<typeof draftFromDbt>[0]> = {}): Draft {
  const scopes = listDraftScopes({ ymlData: data, projectRoot: tmp, modelPaths: ['models'] });
  return draftFromDbt({
    draft, relationships: draft.relationships, scope: scopes[0], scopes, trigger: 'prompt',
    target: target('marts'), libraryTable: () => undefined, layers: DEFAULT_LAYERS, ...extra,
  });
}
const section = (d: Draft, id: string) => d.details.find((s) => s.id === id);
const texts = (d: Draft, id: string): string[] => (section(d, id)?.items ?? []).map((i) => [i.path, i.text].filter(Boolean).join(': '));

// ---------------------------------------------------------------------------
// not_null, in every form dbt writes it
// ---------------------------------------------------------------------------

describe('dbt not_null is read in every form and kept on the column', () => {
  it('scalar, map with config (severity), tests: and data_tests:; not a where-limited, disabled or proportion test', async () => {
    const data = await load(`version: 2
models:
  - name: t
    columns:
      - name: a
        tests: [not_null]
      - name: b
        data_tests:
          - not_null:
              config:
                severity: warn
      - name: c
        data_tests:
          - not_null:
              config:
                where: "c_type = 'x'"
      - name: d
        tests:
          - not_null:
              config:
                enabled: false
      - name: e
        tests:
          - dbt_utils.not_null_proportion:
              at_least: 0.95
      - name: f
        constraints:
          - type: not_null
      - name: g
      - name: h
        tests:
          - not_null:
    constraints:
      - type: not_null
        columns: [g]
`);
    expect([...data.notNullColumns!.get('t')!].sort()).toEqual(['a', 'b', 'f', 'g', 'h']);
    const seeded = seedTableFromDbt('t', data)!;
    const notNull = seeded.columns!.filter((c) => (c.meta as { dbml?: { not_null?: boolean } } | undefined)?.dbml?.not_null === true).map((c) => c.name);
    expect(notNull).toEqual(['a', 'b', 'f', 'g', 'h']);
    // A column dbt does not require carries no meta.
    expect(seeded.columns!.find((c) => c.name === 'c')!.meta).toBeUndefined();
  });

  it('a hand-built YmlData with no notNullColumns still seeds (the field is optional)', () => {
    const data: YmlData = {
      models: new Map([['t', { name: 't', description: '', columns: [{ name: 'a', description: '', dataType: 'int' }], filePath: '/x.yml', tags: [] }]]),
      relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(),
    };
    expect(seedTableFromDbt('t', data)!.columns).toEqual([{ name: 'a', dataType: 'int', description: '' }]);
    expect(notNullColumnsOf(data, 't').size).toBe(0);
  });

  it('a folder filter keeps only its models\' not_null columns', async () => {
    fs.mkdirSync(path.join(tmp, 'models', 'staging'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'models', 'staging', 'stg.yml'), 'version: 2\nmodels:\n  - name: stg\n    columns:\n      - name: id\n        tests: [not_null]\n');
    await load(PEOPLE);
    const svc = new YmlParserService();
    const marts = await svc.loadYmlData(tmp, 'models/marts');
    expect(marts.notNullColumns!.has('stg')).toBe(false);
    expect(marts.notNullColumns!.has('person')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The draft: required count, undrawn links, conditions
// ---------------------------------------------------------------------------

describe('Import from dbt counts required relationships and names the links it does not draw', () => {
  it('a DBML diagram: the D18 note counts the relationships whose FK is not_null (the sample: 38)', async () => {
    const data = await load(PEOPLE);
    const draft = buildDbtDraft({ modelNames: ['person', 'care_site', 'location'], ymlData: data, libraryHas: () => false, dbml: { tableStorage: () => undefined } });
    // person.care_site_id (not_null) and care_site.location_id (not_null) are required; person.location_id is not.
    expect(draft.requiredRelationships).toBe(2);
    expect(draft.ledger).toContainEqual(expect.objectContaining({ outcome: 'changed', cause: 'savedOptional', count: 2 }));
    const notes = texts(view(draft, data), 'notes');
    expect(notes).toContain(`Every relationship is saved as optional (?: its foreign key may be empty), as ERD Studio saves them all. In the source, 2 relationships were not optional (their foreign key columns are NOT NULL); the other ${draft.relationships.length - 2} may be empty.`);
    // A YAML diagram's relationships record no optionality: no D18 entry.
    const yaml = buildDbtDraft({ modelNames: ['person', 'care_site', 'location'], ymlData: data, libraryHas: () => false });
    expect(yaml.ledger.some((e) => e.cause === 'savedOptional')).toBe(false);
  });

  it('links from a drawn model to an undrawn one are listed by name and counted on the table line', async () => {
    const data = await load(PEOPLE);
    const draft = buildDbtDraft({ modelNames: ['person', 'care_site'], ymlData: data, libraryHas: () => false, dbml: { tableStorage: () => undefined } });
    expect(draft.undrawnLinks).toEqual([
      { fromModel: 'care_site', fromColumn: 'location_id', toModel: 'location', toColumn: 'location_id', why: 'addable' },
      { fromModel: 'person', fromColumn: 'location_id', toModel: 'location', toColumn: 'location_id', why: 'addable' },
      { fromModel: 'person', fromColumn: 'provider_id', toModel: 'provider', toColumn: 'provider_id', why: 'noColumns' },
      { fromModel: 'person', fromColumn: 'gender_concept_id', toModel: 'concept', toColumn: 'concept_id', why: 'addable' },
    ]);
    expect(draft.ledger.filter((e) => e.outcome === 'skipped' && e.unit === 'relationship')).toHaveLength(4);
    const d = view(draft, data);
    const notDrawn = texts(d, 'leftOut');
    expect(notDrawn).toContain('person.location_id → location: Drawn when you add location (Add Existing Model).');
    expect(notDrawn).toContain("person.provider_id → provider: provider has no columns in your schema yml, so it can't be drawn.");
    // person: 1 drawn FK (care_site_id) and 3 to tables not drawn.
    const personLine = d.details.flatMap((s) => s.items).find((i) => i.path === 'person')!.text;
    expect(personLine).toBe('5 columns · primary key person_id · 4 foreign keys (3 to tables not drawn)');
    expect(d.summary.leftOut).toBe(4);
  });

  it('the link comes back when the model is added (Add Existing Model\'s batch add finds the same test)', async () => {
    const data = await load(PEOPLE);
    const first = buildDbtDraft({ modelNames: ['person', 'care_site'], ymlData: data, libraryHas: () => false });
    const added = buildDbtDraft({
      modelNames: ['location'], ymlData: data, libraryHas: () => false,
      existingModelNames: first.modelNames, existingRelationships: first.relationships,
    });
    expect(added.relationships.map((r) => `${r.fromModel}.${r.fromColumn} → ${r.toModel}`).sort())
      .toEqual(['care_site.location_id → location', 'person.location_id → location']);
    expect(added.undrawnLinks).toBeUndefined();
  });

  it('a link to a name that is no model (a package\'s, a typo) says so; one to a model over the limit is addable', async () => {
    const data = await load(`version: 2
models:
  - name: a
    columns:
      - name: id
      - name: pkg_id
        tests:
          - relationships:
              to: ref('some_package', 'pkg_model')
              field: id
      - name: b_id
        tests:
          - relationships:
              to: ref('b')
              field: id
  - name: b
    columns:
      - name: id
`);
    const draft = buildDbtDraft({ modelNames: ['a', 'b'], ymlData: data, libraryHas: () => false, limit: 1 });
    expect(draft.undrawnLinks?.map((l) => [l.toModel, l.why])).toEqual([['pkg_model', 'notAModel'], ['b', 'addable']]);
    expect(draft.ledger.find((e) => e.where?.column === 'b_id')?.cause).toBe('capped');
  });

  it('a relationships_where condition is not kept: counted; a link that also has a plain relationships test is not', async () => {
    const data = await load(`${PEOPLE}
  - name: visit
    columns:
      - name: visit_id
      - name: person_id
        tests:
          - relationships:
              to: ref('person')
              field: person_id
          - dbt_utils.relationships_where:
              to: ref('person')
              field: person_id
              from_condition: person_id <> 0
      - name: care_site_id
        tests:
          - relationships:
              to: ref('care_site')
              field: care_site_id
              config:
                where: "care_site_id is not null"
`);
    const draft = buildDbtDraft({ modelNames: ['person', 'concept', 'visit', 'care_site'], ymlData: data, libraryHas: () => false });
    const lost = draft.ledger.filter((e) => e.outcome === 'lost' && e.what === 'relationships_where condition');
    expect(lost.map((e) => `${e.where?.table}.${e.where?.column}`).sort()).toEqual(['person.gender_concept_id', 'visit.care_site_id']);
    expect(texts(view(draft, data), 'leftOut')).toContain('2 constraints: relationships_where condition not kept: the relationship is drawn for every row (person.gender_concept_id, visit.care_site_id).');
  });
});

// ---------------------------------------------------------------------------
// Wording: no columns, the layer's schema, selectors.yml
// ---------------------------------------------------------------------------

describe('the dbt draft says what Keep writes and what it cannot draw', () => {
  it('models with no columns are named once (yml, manifest-less .sql files under model-paths)', async () => {
    const data = await load(PEOPLE);
    fs.writeFileSync(path.join(tmp, 'models', 'marts', 'int_orphan.sql'), 'select 1');
    fs.mkdirSync(path.join(tmp, 'snapshots'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'snapshots', 'snap.sql'), '{% snapshot snap %}{% endsnapshot %}');
    const fresh = await new YmlParserService().loadYmlData(tmp);
    expect(modelsWithoutColumns({ ymlData: fresh, modelPaths: ['models'] })).toEqual(['int_orphan', 'provider']);
    const draft = buildDbtDraft({ modelNames: ['person'], ymlData: data, libraryHas: () => false });
    const d = view(draft, data, { modelsWithoutColumns: ['int_a', 'int_b', 'int_c', 'int_d', 'int_e'] });
    expect(texts(d, 'leftOut')).toContain("5 models have no columns in your schema yml, so they can't be drawn: int_a, int_b, int_c, int_d and 1 more. Add columns: to their yml to draw them.");
  });

  it('a DBML diagram says the tables with no custom schema are written in the layer\'s schema; a YAML diagram does not', async () => {
    const data = await load(PEOPLE);
    const draft = buildDbtDraft({ modelNames: ['person', 'location'], ymlData: data, libraryHas: () => false, dbml: { tableStorage: () => undefined } });
    expect(dbtLayerSchemaNote(draft, 'gold')).toBe("2 models set no custom schema in dbt, so they are written in schema gold, the layer's name: person, location.");
    expect(texts(view(draft, data), 'notes')).toContain(dbtLayerSchemaNote(draft, 'gold'));
    expect(texts(view(draft, data, { target: target('marts', 'gold', false) }), 'notes').some((n) => /schema gold/.test(n))).toBe(false);
    // The schema dbt builds them in, when the manifest gives one, and none said for a model with a custom schema.
    expect(dbtLayerSchemaNote({ newModels: [{ name: 'x', schema: 'dbt_dev' }, { name: 'y', schema: 'dbt_dev' }, { name: 'z', configuredSchema: 'finance' }] }, 'gold'))
      .toBe("2 models set no custom schema in dbt, so they are written in schema gold, the layer's name (dbt builds them in dbt_dev with this target): x, y.");
    expect(dbtLayerSchemaNote({ newModels: [{ name: 'z', configuredSchema: 'finance' }] }, 'gold')).toBe('');
  });

  it('the banner says Keep also writes selectors.yml at the dbt root (I1)', async () => {
    const data = await load(PEOPLE);
    const d = view(buildDbtDraft({ modelNames: ['person'], ymlData: data, libraryHas: () => false }), data);
    expect(d.banner.detail.endsWith(DBT_KEEP_SELECTORS_SENTENCE)).toBe(true);
    expect(d.banner.detail).toContain('selectors.yml');
  });

  it('describeImportTable counts FKs to tables not drawn in its line', () => {
    const t = { name: 't', columns: [{ name: 'id', isPrimaryKey: true }] } as Parameters<typeof describeImportTable>[0];
    expect(describeImportTable(t, 2)).toBe('1 column · primary key id · 2 foreign keys');
    expect(describeImportTable(t, 2, 1)).toBe('1 column · primary key id · 3 foreign keys (1 to a table not drawn)');
    expect(describeImportTable(t, 0, 1)).toBe('1 column · primary key id · 1 foreign key (to a table not drawn)');
    expect(describeImportTable(t, 0, 2)).toBe('1 column · primary key id · 2 foreign keys (to tables not drawn)');
  });
});
