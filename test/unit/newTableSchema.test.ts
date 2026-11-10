/**
 * Where a table made on the canvas goes (native DBML storage): the schema
 * the user names, else the schema most of the diagram's tables in its layer
 * use, else the layer id — the rule the New Table dialog fills in, the host
 * writes and the AI helper's guide states.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { newTableSchemaChoice } from '../../src/services/newTableSchema';
import { SCHEMA_FOLDER_RULE, isSchemaFolderName, newTablePathPreview } from '../../src/types/schemaFolder';
import { isSchemaFolderName as plannerRule } from '../../src/services/dbmlLibraryWrites';
import { validateSchemaFolderPayload } from '../../src/providers/payloadValidation';
import { HarnessService } from '../../src/services/harnessService';
import type { TableHome } from '../../src/services/tableHomes';
import { normaliseForStorageEquivalence } from '@erd-studio/core';

const homes = (entries: Array<[string, string, string]>): Map<string, TableHome> =>
  new Map(entries.map(([name, layer, schema]) => [name.toLowerCase(), { layer, schema }]));

describe('newTableSchemaChoice', () => {
  const library = homes([
    ['fct_order', 'gold', 'sales'],
    ['fct_sale', 'gold', 'sales'],
    ['dim_customer', 'gold', 'gold'],
    ['dim_region', 'gold', 'Geo'],
    ['stg_order', 'silver', 'erp'],
  ]);

  it('defaults to the schema most of the diagram\'s tables in the layer use', () => {
    const choice = newTableSchemaChoice({ layer: 'gold', layerSchema: 'gold', members: ['fct_order', 'FCT_SALE', 'dim_customer'], homes: library });
    expect(choice).toEqual({ layer: 'gold', schemas: ['Geo', 'gold', 'sales'], defaultSchema: 'sales' });
  });

  it('counts only the diagram\'s tables in its own layer', () => {
    const choice = newTableSchemaChoice({ layer: 'gold', layerSchema: 'gold', members: ['stg_order', 'dim_region'], homes: library });
    expect(choice.defaultSchema).toBe('Geo');
  });

  it('a tie goes to the layer\'s own schema, then to byte order', () => {
    expect(newTableSchemaChoice({ layer: 'gold', layerSchema: 'gold', members: ['fct_order', 'dim_customer'], homes: library }).defaultSchema).toBe('gold');
    expect(newTableSchemaChoice({ layer: 'gold', layerSchema: 'gold', members: ['fct_order', 'dim_region'], homes: library }).defaultSchema).toBe('Geo');
  });

  it('with no table of the layer on the diagram: the layer id, as the layer\'s tables/ lists it', () => {
    const choice = newTableSchemaChoice({ layer: 'platinum', layerSchema: 'platinum', members: ['fct_order'], homes: library });
    expect(choice).toEqual({ layer: 'platinum', schemas: ['platinum'], defaultSchema: 'platinum' });
  });
});

describe('the schema folder rule (one rule for the dialog, the payload check and the planner)', () => {
  it('is the planner\'s own check', () => {
    expect(plannerRule).toBe(isSchemaFolderName);
  });

  it.each(['sales', 'SAP FI', 'erp-2', 'Geo'])('accepts %s', (schema) => {
    expect(isSchemaFolderName(schema)).toBe(true);
    expect(validateSchemaFolderPayload(schema)).toBeNull();
  });

  it.each(['', 'a/b', '.hidden', ' sales', 'sales.', '{{ target.schema }}', "o'neil", 'con'])('refuses %j', (schema) => {
    expect(isSchemaFolderName(schema)).toBe(false);
    expect(validateSchemaFolderPayload(schema)).toContain(SCHEMA_FOLDER_RULE);
  });

  it('an absent schema is today\'s behaviour; a non-string is refused', () => {
    expect(validateSchemaFolderPayload(undefined)).toBeNull();
    expect(validateSchemaFolderPayload(7)).toBe('The schema must be text.');
  });

  it('the preview spells the schema as an existing folder that matches it', () => {
    expect(newTablePathPreview('.erd-studio', 'gold', ['Geo', 'sales'], 'geo', 'dim_store')).toBe('.erd-studio/gold/tables/Geo/dim_store.dbml');
    expect(newTablePathPreview('.erd-studio', 'gold', ['sales'], 'finance', 'fct_gl')).toBe('.erd-studio/gold/tables/finance/fct_gl.dbml');
  });
});

describe('the AI helper states the same rule', () => {
  const RULE = /the schema the user names; else, for a dbt model with a custom schema, dbt's configured schema[^]*?else the schema folder most of the diagram's tables in that layer already use; else the layer's name/;

  it('in the schema guide', () => {
    const guide = new HarnessService().schemaSkillFiles().map(([, content]) => content).join('\n');
    expect(guide).toMatch(RULE);
    expect(guide).toContain('creates `gold/tables/sales/fct_sale.dbml` holding `Table sales.fct_sale`');
  });

  it('in the setup skill\'s building-the-model reference', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../src/harness/claude/erd-studio-setup/references/building-the-model.md'), 'utf-8')
      .replace(/\s+/g, ' ');
    expect(text).toContain('The schema folder is the one the user names;');
    expect(text).toContain("else the schema folder most of the diagram's tables in that layer already use; else the layer's name.");
  });
});

describe('storage equivalence', () => {
  it('ignores where a new DBML table goes (a YAML read has no such thing), with the layers', () => {
    const dbml = { schemaVersion: 7, models: [], relationships: [], newTableSchemas: { dir: '.erd-studio', layer: 'gold', schemas: ['gold'], defaultSchema: 'gold' } };
    expect(normaliseForStorageEquivalence(dbml)).toEqual(normaliseForStorageEquivalence({ schemaVersion: 7, models: [], relationships: [] }));
  });
});
