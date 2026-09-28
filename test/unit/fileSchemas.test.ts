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

import { CURRENT_SCHEMA_VERSION, LEGACY_SCHEMA_VERSION, detectDomainFormat } from '../../packages/core/src/types/semantic';
import { LAYERS_SCHEMA_VERSION } from '../../packages/core/src/types/layer';
import { RATIONALE_KEYS } from '../../packages/core/src/logicalModel';
import { VALID_CARDINALITIES } from '../../packages/core/src/domain';
import { ANNOTATION_COLORS } from '../../packages/renderer/src/lib/annotationColors';
import { CARDINALITIES, MODEL_ROLES } from '../../src/providers/payloadValidation';

const ROOT = path.resolve(__dirname, '../..');
const FIXTURE_DIR = path.join(ROOT, 'test/fixtures/dbt-project/.erd-studio');

type Schema = Record<string, any>;

const loadSchema = (file: string): Schema =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', file), 'utf-8'));

const domainSchema = loadSchema('domain.schema.json');
const modelSchema = loadSchema('logical-model.schema.json');
const layersSchema = loadSchema('layers.schema.json');
const templateSchema = loadSchema('template.schema.json');

const ajv = new Ajv({ allErrors: true });
// VS Code's own keyword for per-value hover text in completion lists.
ajv.addKeyword('enumDescriptions');
const validators: Record<string, ValidateFunction> = {
  'domain.schema.json': ajv.compile(domainSchema),
  'logical-model.schema.json': ajv.compile(modelSchema),
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

/** Schema property names, minus the `$schema` pointer every root accepts. */
const schemaKeys = (node: Schema): string[] =>
  Object.keys(node.properties).filter((k) => k !== '$schema').sort();

const SEMANTIC = 'packages/core/src/types/semantic.ts';
const LAYER = 'packages/core/src/types/layer.ts';

describe('schemas match the TypeScript types', () => {
  it.each([
    ['logical model', () => modelSchema, 'SemanticModel', SEMANTIC],
    ['model column', () => modelSchema.definitions.column, 'ColumnDef', SEMANTIC],
    ['rationale', () => modelSchema.definitions.rationale, 'Rationale', SEMANTIC],
    ['template', () => templateSchema, 'ModelTemplate', SEMANTIC],
    ['template column', () => templateSchema.definitions.column, 'ColumnDef', SEMANTIC],
    ['domain', () => domainSchema, 'UnifiedDomainV5', SEMANTIC],
    ['relationship', () => domainSchema.definitions.relationship, 'Relationship', SEMANTIC],
    ['viewConfig', () => domainSchema.definitions.viewConfig, 'ViewConfig', SEMANTIC],
    ['position', () => domainSchema.definitions.position, 'NodePosition', SEMANTIC],
    ['annotation', () => domainSchema.definitions.annotation, 'Annotation', SEMANTIC],
    ['layers file', () => layersSchema, 'LayersConfigFile', LAYER],
    ['layer', () => layersSchema.definitions.layer, 'LayerConfig', LAYER],
  ] as const)('%s declares exactly the fields of %s', (_label, node, iface, file) => {
    expect(schemaKeys(node())).toEqual(interfaceKeys(file, iface));
  });

  it('logical stage declares StageDataV5 plus the deprecated stage-level viewConfig the reader still honours', () => {
    expect(schemaKeys(domainSchema.properties.logical)).toEqual(
      [...interfaceKeys(SEMANTIC, 'StageDataV5'), 'viewConfig'].sort(),
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
    for (const [file, schema] of Object.entries({ domainSchema, modelSchema, layersSchema, templateSchema })) walk(schema, file);
    expect(offenders).toEqual([]);
  });

  it('every schema rejects properties it does not declare', () => {
    const closed = [
      modelSchema, modelSchema.definitions.column, modelSchema.definitions.rationale,
      templateSchema, templateSchema.definitions.column,
      domainSchema, domainSchema.properties.logical, domainSchema.definitions.relationship,
      domainSchema.definitions.viewConfig, domainSchema.definitions.position, domainSchema.definitions.annotation,
      layersSchema, layersSchema.definitions.layer,
    ];
    for (const node of closed) expect(node.additionalProperties).toBe(false);
  });
});

describe('schema enums match the runtime', () => {
  it('modelRole is the role list the host validates against', () => {
    expect(modelSchema.definitions.modelRole.enum).toEqual([...MODEL_ROLES]);
    expect(modelSchema.definitions.modelRole.enumDescriptions).toHaveLength(MODEL_ROLES.length);
  });

  it('cardinality is the set the domain parser keeps', () => {
    const cardinality = domainSchema.definitions.relationship.properties.cardinality.enum;
    expect(cardinality).toEqual([...CARDINALITIES]);
    expect(new Set(cardinality)).toEqual(VALID_CARDINALITIES);
  });

  it('rationale keys are the ones the model reader keeps', () => {
    expect(schemaKeys(modelSchema.definitions.rationale)).toEqual([...RATIONALE_KEYS].sort());
  });

  it('annotation colours are the canvas palette', () => {
    expect(domainSchema.definitions.annotation.properties.color.enum).toEqual(ANNOTATION_COLORS.map((c) => c.value));
  });

  it('schema versions are the ones the readers accept', () => {
    expect(domainSchema.properties.schemaVersion.enum).toEqual([CURRENT_SCHEMA_VERSION, LEGACY_SCHEMA_VERSION]);
    expect(layersSchema.properties.schemaVersion.maximum).toBe(LAYERS_SCHEMA_VERSION);
  });

  it('model and template columns are the same shape', () => {
    const { name: _m, ...modelCol } = modelSchema.definitions.column.properties;
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

const fixtureFiles = listFiles(FIXTURE_DIR).map((abs) => ({
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

  it('accepts a $schema pointer, so other editors can be pointed at the same file', () => {
    expect(validate('logical-model.schema.json', { $schema: 'https://example.test/s.json', name: 'd' })).toEqual([]);
    expect(validate('domain.schema.json', {
      $schema: 'https://example.test/s.json', schemaVersion: 5, domain: 'd', layer: 'silver',
      logical: { models: [], relationships: [] }, viewConfig: {},
    })).toEqual([]);
  });

  it('flags the hybrid domains detectDomainFormat refuses to open', () => {
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
      expect(detectDomainFormat(raw)).toBe('hybrid');
      expect(validate('domain.schema.json', raw)).not.toEqual([]);
    }
    for (const [version, models, format] of [[5, ['dim_a'], 'v5'], [5, [], 'v5'], [4, [{ name: 'dim_a' }], 'v4']] as const) {
      const raw = domain(version, [...models]);
      expect(detectDomainFormat(raw)).toBe(format);
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
