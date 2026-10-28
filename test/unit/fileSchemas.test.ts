/**
 * The JSON Schemas in `schemas/` give hand-editors completion, hover docs and
 * warnings (issue #94). They are hand-written, so this file is what keeps them
 * honest: every property matches the TypeScript interface it describes, every
 * enum matches the constant the runtime validates against, the fileMatch globs
 * contributed in package.json route each fixture file to the right schema, and
 * every file in the main fixture project validates.
 */

import * as fs from 'fs';
import * as path from 'path';
import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import { LIBRARY_SCHEMA_VERSION, LEGACY_SCHEMA_VERSION, TABLE_NAMING_SCHEMA_VERSION, detectSubjectAreaFormat } from '../../packages/core/src/types/semantic';
import { LAYERS_SCHEMA_VERSION } from '../../packages/core/src/types/layer';
import { RATIONALE_KEYS } from '../../packages/core/src/logicalModel';
import { VALID_CARDINALITIES } from '../../packages/core/src/domain';
import { ANNOTATION_COLORS } from '../../packages/renderer/src/lib/annotationColors';
import { CARDINALITIES, TABLE_ROLES } from '../../src/providers/payloadValidation';

const ROOT = path.resolve(__dirname, '../..');
const FIXTURE_DIR = path.join(ROOT, 'test/fixtures/dbt-project/.erd-studio');

type Schema = Record<string, any>;

const loadSchema = (file: string): Schema =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', file), 'utf-8'));

const subjectAreaSchema = loadSchema('domain.schema.json');
const tableSchema = loadSchema('logical-model.schema.json');
const layersSchema = loadSchema('layers.schema.json');
const templateSchema = loadSchema('template.schema.json');

const ajv = new Ajv({ allErrors: true });
// VS Code's own keyword for per-value hover text in completion lists.
ajv.addKeyword('enumDescriptions');
const validators: Record<string, ValidateFunction> = {
  'domain.schema.json': ajv.compile(subjectAreaSchema),
  'logical-model.schema.json': ajv.compile(tableSchema),
  'layers.schema.json': ajv.compile(layersSchema),
  'template.schema.json': ajv.compile(templateSchema),
};

const validate = (schemaFile: string, data: unknown): string[] => {
  const fn = validators[schemaFile];
  return fn(data) ? [] : (fn.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
};

/** Property names an interface declares, read from its source with the TS compiler. */
function interfaceKeys(relFile: string, name: string): string[] {
  const file = path.join(ROOT, relFile);
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
  const decl = source.statements.find(
    (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === name,
  );
  if (!decl) throw new Error(`interface ${name} not found in ${relFile}`);
  return decl.members.map((m) => (m.name as ts.Identifier).text).sort();
}

/** The schema v6 name of each key the table naming renames (#162, written since #182). */
const V6_NAMES: Readonly<Record<string, string>> = {
  domain: 'subjectArea', models: 'tables', fromModel: 'fromTable', toModel: 'toTable', modelRole: 'tableRole', linkedModel: 'linkedTable',
};

/** An interface's keys plus the v6 name of each one the naming renames: what a schema describing both namings declares. */
const withV6Names = (keys: string[]): string[] => [...keys, ...keys.flatMap((k) => (V6_NAMES[k] ? [V6_NAMES[k]] : []))].sort();

/** Schema property names, minus the `$schema` pointer every root accepts. */
const schemaKeys = (node: Schema): string[] =>
  Object.keys(node.properties).filter((k) => k !== '$schema').sort();

const SEMANTIC = 'packages/core/src/types/semantic.ts';
const LAYER = 'packages/core/src/types/layer.ts';

describe('schemas match the TypeScript types', () => {
  it.each([
    ['logical model', 'SemanticTable', SEMANTIC, () => tableSchema],
    ['model column', 'ColumnDef', SEMANTIC, () => tableSchema.definitions.column],
    ['rationale', 'Rationale', SEMANTIC, () => tableSchema.definitions.rationale],
    ['template', 'TableTemplate', SEMANTIC, () => templateSchema],
    ['template column', 'ColumnDef', SEMANTIC, () => templateSchema.definitions.column],
    ['domain', 'UnifiedSubjectAreaV5', SEMANTIC, () => subjectAreaSchema],
    ['relationship', 'Relationship', SEMANTIC, () => subjectAreaSchema.definitions.relationship],
    ['viewConfig', 'ViewConfig', SEMANTIC, () => subjectAreaSchema.definitions.viewConfig],
    ['position', 'NodePosition', SEMANTIC, () => subjectAreaSchema.definitions.position],
    ['annotation', 'Annotation', SEMANTIC, () => subjectAreaSchema.definitions.annotation],
    ['layers file', 'LayersConfigFile', LAYER, () => layersSchema],
    ['layer', 'LayerConfig', LAYER, () => layersSchema.definitions.layer],
  ] as const)('%s declares exactly the fields of %s', (_label, iface, file, node) => {
    expect(schemaKeys(node())).toEqual(withV6Names(interfaceKeys(file, iface)));
  });

  it('a model file relationship declares the fields of Relationship without fromModel (TableRelationship)', () => {
    expect(schemaKeys(tableSchema.definitions.relationship)).toEqual(
      withV6Names(interfaceKeys(SEMANTIC, 'Relationship').filter((key) => key !== 'fromModel')),
    );
  });

  it('logical stage declares StageDataV5 plus the deprecated stage-level viewConfig the reader still honours', () => {
    expect(schemaKeys(subjectAreaSchema.properties.logical)).toEqual(
      withV6Names([...interfaceKeys(SEMANTIC, 'StageDataV5'), 'viewConfig']),
    );
  });

  it('no $ref carries siblings — VS Code drops a description written next to one', () => {
    const offenders: string[] = [];
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${at}/${i}`));
      else if (node && typeof node === 'object') {
        if ('$ref' in node && Object.keys(node).length > 1) offenders.push(at);
        for (const [k, v] of Object.entries(node)) walk(v, `${at}/${k}`);
      }
    };
    for (const [file, schema] of Object.entries({ domainSchema: subjectAreaSchema, modelSchema: tableSchema, layersSchema, templateSchema })) walk(schema, file);
    expect(offenders).toEqual([]);
  });

  it('every schema rejects properties it does not declare', () => {
    const closed = [
      tableSchema, tableSchema.definitions.column, tableSchema.definitions.rationale,
      templateSchema, templateSchema.definitions.column,
      subjectAreaSchema, subjectAreaSchema.properties.logical, subjectAreaSchema.definitions.relationship,
      subjectAreaSchema.definitions.viewConfig, subjectAreaSchema.definitions.position, subjectAreaSchema.definitions.annotation,
      layersSchema, layersSchema.definitions.layer,
    ];
    for (const node of closed) expect(node.additionalProperties).toBe(false);
  });
});

describe('schema enums match the runtime', () => {
  it('modelRole is the role list the host validates against', () => {
    expect(tableSchema.definitions.modelRole.enum).toEqual([...TABLE_ROLES]);
    expect(tableSchema.definitions.modelRole.enumDescriptions).toHaveLength(TABLE_ROLES.length);
  });

  it('cardinality is the set the domain parser keeps', () => {
    const cardinality = subjectAreaSchema.definitions.relationship.properties.cardinality.enum;
    expect(cardinality).toEqual([...CARDINALITIES]);
    expect(new Set(cardinality)).toEqual(VALID_CARDINALITIES);
  });

  it('a model file still reads one-to-many but marks it deprecated (#133)', () => {
    const cardinality = tableSchema.definitions.relationship.properties.cardinality;
    expect(cardinality.enum).toEqual([...CARDINALITIES]);
    expect(cardinality.enumDescriptions[cardinality.enum.indexOf('one-to-many')]).toMatch(/^Deprecated in model files/);
  });

  it('rationale keys are the ones the model reader keeps', () => {
    expect(schemaKeys(tableSchema.definitions.rationale)).toEqual([...RATIONALE_KEYS].sort());
  });

  it('annotation colours are the canvas palette', () => {
    expect(subjectAreaSchema.definitions.annotation.properties.color.enum).toEqual(ANNOTATION_COLORS.map((c) => c.value));
  });

  it('schema versions are the v6, v5 and v4 shapes the schema describes', () => {
    expect(subjectAreaSchema.properties.schemaVersion.enum).toEqual([TABLE_NAMING_SCHEMA_VERSION, LIBRARY_SCHEMA_VERSION, LEGACY_SCHEMA_VERSION]);
    expect(layersSchema.properties.schemaVersion.maximum).toBe(LAYERS_SCHEMA_VERSION);
  });

  it('model and template columns are the same shape', () => {
    const { name: _m, ...modelCol } = tableSchema.definitions.column.properties;
    const { name: _t, ...templateCol } = templateSchema.definitions.column.properties;
    const shape = (props: Schema) =>
      Object.fromEntries(Object.entries(props).map(([k, v]) => [k, { type: v.type, enum: v.enum }]));
    expect(shape(templateCol)).toEqual(shape(modelCol));
  });
});

// ---------------------------------------------------------------------------
// package.json wiring
// ---------------------------------------------------------------------------

interface Contribution {
  fileMatch: string | string[];
  url: string;
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const contributions: Contribution[] = [
  ...manifest.contributes.jsonValidation,
  ...manifest.contributes.yamlValidation,
];

/** The schema VS Code would pick for `relPath` (relative to the project root), honouring `!` exclusions. */
function schemaFor(relPath: string): string | undefined {
  const matches = contributions.filter((c) => {
    const globs = Array.isArray(c.fileMatch) ? c.fileMatch : [c.fileMatch];
    const include = globs.filter((g) => !g.startsWith('!'));
    const exclude = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
    return include.some((g) => path.posix.matchesGlob(relPath, g)) && !exclude.some((g) => path.posix.matchesGlob(relPath, g));
  });
  expect(matches.length, `${relPath} matched ${matches.length} schemas`).toBeLessThanOrEqual(1);
  return matches[0] ? path.posix.basename(matches[0].url) : undefined;
}

describe('package.json schema contributions', () => {
  it('every contributed url is a schema file under schemas/', () => {
    for (const c of contributions) {
      expect(c.url).toMatch(/^\.\/schemas\/[a-z-]+\.schema\.json$/);
      expect(fs.existsSync(path.join(ROOT, c.url))).toBe(true);
    }
  });

  it.each([
    ['project/.erd-studio/silver/sales.json', 'domain.schema.json'],
    ['project/.erd-studio/gold/reporting.json', 'domain.schema.json'],
    ['project/.erd-studio/layers.json', 'layers.schema.json'],
    ['project/.erd-studio/templates/fact.json', 'template.schema.json'],
    ['project/.erd-studio/logical-models/dim_customer.yml', 'logical-model.schema.json'],
    ['project/.erd-studio/logical-models/gold/fct_order.yml', 'logical-model.schema.json'],
    ['project/.erd-studio/.sync-plan.json', undefined],
    ['project/.erd-studio/logical-models/a/b/too_deep.yml', undefined],
    ['project/models/schema.yml', undefined],
    ['project/.vscode/settings.json', undefined],
    // Native DBML storage (§7.5): .dbml and .dbdiagram files have no JSON Schema.
    ['project/.erd-studio/tables/dim_customer.dbml', undefined],
    ['project/.erd-studio/tables/gold/fct_order.dbml', undefined],
    ['project/.erd-studio/tables/gold/_relationships.dbml', undefined],
    ['project/.erd-studio/gold/sales.dbml', undefined],
    ['project/.erd-studio/gold/sales.dbdiagram', undefined],
  ])('%s → %s', (file, expected) => {
    expect(schemaFor(file)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

// `.dbml` and `.dbdiagram` files have no schema (§7.5): the walk skips them.
const fixtureFiles = listFiles(FIXTURE_DIR).filter((abs) => !/\.(dbml|dbdiagram)$/i.test(abs)).map((abs) => ({
  rel: `dbt-project/.erd-studio/${path.relative(FIXTURE_DIR, abs).split(path.sep).join('/')}`,
  abs,
}));

/** Written by the extension (Generate Sync Plan), never hand-edited, so no schema. */
const UNSCHEMED = ['dbt-project/.erd-studio/.sync-plan.json'];

describe('the fixture project validates', () => {
  it('every hand-editable file is covered by a schema', () => {
    expect(fixtureFiles.map((f) => f.rel).filter((rel) => !schemaFor(rel))).toEqual(UNSCHEMED);
  });

  it.each(fixtureFiles.filter((f) => !UNSCHEMED.includes(f.rel)).map((f) => [f.rel, f.abs]))('%s', (rel, abs) => {
    const schema = schemaFor(rel);
    const text = fs.readFileSync(abs, 'utf-8');
    const data = abs.endsWith('.yml') ? parseYaml(text) : JSON.parse(text);
    expect(validate(schema!, data)).toEqual([]);
  });
});

describe('the v6 naming validates (#182)', () => {
  // The showcase in the v6 naming: what migrating the fixture project writes (the other v6 fixtures carry core-test roles).
  const V6_DIR = path.join(ROOT, 'packages/core/test/fixtures/naming-v6/showcase');
  const v6Files = listFiles(V6_DIR).filter((abs) => /\.erd-studio\/((silver|gold)\/[^/]+\.json|tables\/.*\.yml)$/.test(abs.split(path.sep).join('/')));

  it.each(v6Files.map((abs) => [path.relative(V6_DIR, abs), abs]))('%s', (rel, abs) => {
    const text = fs.readFileSync(abs, 'utf-8');
    const schema = abs.endsWith('.yml') ? 'logical-model.schema.json' : 'domain.schema.json';
    expect(schemaFor(`dbt-project/.erd-studio/${rel.split(path.sep).join('/').replace(/^.*?\.erd-studio\//, '')}`)).toBe(schema);
    expect(validate(schema, abs.endsWith('.yml') ? parseYaml(text) : JSON.parse(text))).toEqual([]);
  });

  it('flags a v5 key in a v6 file and a v6 key in a v5 one', () => {
    const v6 = { schemaVersion: 6, subjectArea: 'd', layer: 'silver', logical: { tables: ['a'], relationships: [] }, viewConfig: {} };
    expect(validate('domain.schema.json', v6)).toEqual([]);
    expect(validate('domain.schema.json', { ...v6, domain: 'd' })).not.toEqual([]);
    expect(validate('domain.schema.json', { ...v6, logical: { models: ['a'], relationships: [] } })).not.toEqual([]);
    const v5 = { schemaVersion: 5, domain: 'd', layer: 'silver', logical: { models: ['a'], relationships: [] }, viewConfig: {} };
    expect(validate('domain.schema.json', v5)).toEqual([]);
    expect(validate('domain.schema.json', { ...v5, subjectArea: 'd' })).not.toEqual([]);
    const rel = { fromColumn: 'x', toColumn: 'y', cardinality: 'many-to-one' };
    expect(validate('domain.schema.json', { ...v6, logical: { tables: ['a'], relationships: [{ ...rel, fromTable: 'a', toTable: 'b' }] } })).toEqual([]);
    expect(validate('domain.schema.json', { ...v6, logical: { tables: ['a'], relationships: [{ ...rel, fromTable: 'a', toModel: 'b' }] } })).not.toEqual([]);
    expect(validate('logical-model.schema.json', { name: 'a', tableRole: 'transaction-fact', relationships: [{ ...rel, toTable: 'b' }] })).toEqual([]);
    expect(validate('logical-model.schema.json', { name: 'a', relationships: [{ ...rel, toTable: 'b', toModel: 'b' }] })).not.toEqual([]);
  });
});

describe('what a hand-editor is told', () => {
  const column = { name: 'customer_id', dataType: 'INTEGER', description: 'Surrogate key', isPrimaryKey: true };

  it('flags a misspelt model field and a misspelt column flag', () => {
    expect(validate('logical-model.schema.json', { name: 'dim_customer', grian: 'One row per customer' })).toEqual([
      ' must NOT have additional properties',
    ]);
    expect(validate('logical-model.schema.json', { name: 'd', columns: [{ ...column, isPrimarykey: true }] })).toEqual([
      '/columns/0 must NOT have additional properties',
    ]);
  });

  it('flags values outside an enum', () => {
    expect(validate('logical-model.schema.json', { name: 'd', modelRole: 'conformd-dim' })).toEqual([
      '/modelRole must be equal to one of the allowed values',
    ]);
    expect(validate('logical-model.schema.json', { name: 'd', columns: [{ ...column, scdType: 3 }] })).toEqual([
      '/columns/0/scdType must be equal to one of the allowed values',
    ]);
    const rel = { fromModel: 'a', fromColumn: 'x', toModel: 'b', toColumn: 'y', cardinality: 'many-to-few' };
    const domain = { schemaVersion: 5, domain: 'd', layer: 'silver', logical: { models: ['a', 'b'], relationships: [rel] }, viewConfig: {} };
    expect(validate('domain.schema.json', domain)).toEqual([
      '/logical/relationships/0/cardinality must be equal to one of the allowed values',
    ]);
  });

  it('accepts free-form meta on a model and its columns, and still flags a misspelt field beside it', () => {
    const meta = { owner: 'finance', tier: 1, pii: false, steward: null, lineage: { upstream: ['stg_a', 'stg_b'] } };
    expect(validate('logical-model.schema.json', { name: 'd', meta, columns: [{ ...column, meta }] })).toEqual([]);
    expect(validate('logical-model.schema.json', { name: 'd', meta, grian: 'x' })).toEqual([
      ' must NOT have additional properties',
    ]);
  });

  it('accepts a $schema pointer, so other editors can be pointed at the same file', () => {
    expect(validate('logical-model.schema.json', { $schema: 'https://example.test/s.json', name: 'd' })).toEqual([]);
    expect(validate('domain.schema.json', {
      $schema: 'https://example.test/s.json', schemaVersion: 5, domain: 'd', layer: 'silver',
      logical: { models: [], relationships: [] }, viewConfig: {},
    })).toEqual([]);
  });

  it('flags the hybrid domains detectSubjectAreaFormat refuses to open', () => {
    const domain = (schemaVersion: number, models: unknown[]) => ({
      schemaVersion, domain: 'd', layer: 'silver', logical: { models, relationships: [] }, viewConfig: {},
    });
    const cases: Array<[number, unknown[]]> = [
      [5, ['dim_a', { name: 'dim_b' }]],
      [4, ['dim_a', { name: 'dim_b' }]],
      [5, [{ name: 'dim_a' }]],
    ];
    for (const [version, models] of cases) {
      const raw = domain(version, models);
      expect(detectSubjectAreaFormat(raw)).toBe('hybrid');
      expect(validate('domain.schema.json', raw)).not.toEqual([]);
    }
    for (const [version, models, format] of [[5, ['dim_a'], 'v5'], [5, [], 'v5'], [4, [{ name: 'dim_a' }], 'v4']] as const) {
      const raw = domain(version, [...models]);
      expect(detectSubjectAreaFormat(raw)).toBe(format);
      expect(validate('domain.schema.json', raw)).toEqual([]);
    }
  });

  it('keeps accepting a version 4 domain with inline models, which still loads until migrated', () => {
    expect(validate('domain.schema.json', {
      schemaVersion: 4, domain: 'd', layer: 'silver',
      logical: { models: [{ name: 'dim_a', columns: [] }], relationships: [] }, viewConfig: {},
    })).toEqual([]);
  });
});
