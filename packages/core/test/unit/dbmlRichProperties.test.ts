/**
 * The one table of rich DBML property names (`dbmlRichProperties.ts`), which
 * the exporter writes and ERD Studio's DBML import reads: names stable and
 * readable by DBML, the rationale key mapping, the `erd_` prefix, and the
 * sticky-note colours.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import * as core from '../../src/index';
import {
  DBML_RICH_COLUMN_PROPERTIES,
  DBML_RICH_META_JSON_PROPERTY,
  DBML_RICH_META_PREFIX,
  DBML_RICH_NOTE_PROPERTIES,
  DBML_RICH_PLACEHOLDER_COLUMN,
  DBML_RICH_PLACEHOLDER_PROPERTY,
  DBML_RICH_PROPERTY_PREFIX,
  DBML_RICH_RATIONALE_PREFIX,
  DBML_RICH_STICKY_COLOURS,
  DBML_RICH_STICKY_PREFIX,
  DBML_RICH_TABLE_PROPERTIES,
  bareDbmlProperty,
  rationaleKeyOf,
  rationaleProperty,
  stickyColourOfHex,
} from '../../src/dbmlRichProperties';
import { RATIONALE_KEYS } from '../../src/logicalModel';

describe('rich DBML property names', () => {
  it('keeps the names the export and import agree on', () => {
    expect(DBML_RICH_TABLE_PROPERTIES).toEqual({ role: 'role', grain: 'grain', alias: 'alias', schema: 'schema' });
    expect(DBML_RICH_COLUMN_PROPERTIES).toEqual({ naturalKey: 'natural_key', scdType: 'scd_type', additiveType: 'additive_type', foreignKey: 'foreign_key' });
    expect(DBML_RICH_NOTE_PROPERTIES).toEqual({ linkedTable: 'linked_table' });
    expect([DBML_RICH_STICKY_PREFIX, DBML_RICH_PROPERTY_PREFIX, DBML_RICH_RATIONALE_PREFIX, DBML_RICH_META_PREFIX, DBML_RICH_META_JSON_PROPERTY]).toEqual([
      'sticky_', 'erd_', 'rationale_', 'meta_', 'meta_json',
    ]);
    expect([DBML_RICH_PLACEHOLDER_COLUMN, DBML_RICH_PLACEHOLDER_PROPERTY]).toEqual(['_erd_no_columns', 'erd_placeholder']);
  });

  it('uses only names DBML reads back as written (lower-case identifiers)', () => {
    const names = [
      ...Object.values(DBML_RICH_TABLE_PROPERTIES),
      ...Object.values(DBML_RICH_COLUMN_PROPERTIES),
      ...Object.values(DBML_RICH_NOTE_PROPERTIES),
      ...RATIONALE_KEYS.map(rationaleProperty),
      DBML_RICH_META_JSON_PROPERTY,
      DBML_RICH_PLACEHOLDER_PROPERTY,
    ];
    for (const name of names) expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
    expect(new Set(names).size).toBe(names.length);
  });

  it('maps every rationale key to a snake_case property and back, with or without the erd_ prefix', () => {
    expect(rationaleProperty('scdStrategy')).toBe('rationale_scd_strategy');
    expect(rationaleProperty('purpose')).toBe('rationale_purpose');
    for (const key of RATIONALE_KEYS) {
      expect(rationaleKeyOf(rationaleProperty(key))).toBe(key);
      expect(rationaleKeyOf(`erd_${rationaleProperty(key)}`)).toBe(key);
    }
    for (const other of ['rationale_', 'rationale_unknown', 'grain', 'erd_grain']) expect(rationaleKeyOf(other)).toBeUndefined();
  });

  it('strips the erd_ prefix for matching, except from the placeholder marker', () => {
    expect(bareDbmlProperty('erd_grain')).toBe('grain');
    expect(bareDbmlProperty('grain')).toBe('grain');
    expect(bareDbmlProperty('erd_meta_owner')).toBe('meta_owner');
    expect(bareDbmlProperty(DBML_RICH_PLACEHOLDER_PROPERTY)).toBe(DBML_RICH_PLACEHOLDER_PROPERTY);
  });

  it('is exported from the package entry', () => {
    expect(core.DBML_RICH_TABLE_PROPERTIES).toBe(DBML_RICH_TABLE_PROPERTIES);
    expect(core.stickyColourOfHex).toBe(stickyColourOfHex);
  });
});

describe('sticky-note colours', () => {
  it('exports each colour as the swatch the canvas colour picker shows', () => {
    // The renderer's ANNOTATION_COLORS are the swatches; read its source so the two cannot drift.
    const source = fs.readFileSync(path.resolve(__dirname, '../../../renderer/src/lib/annotationColors.ts'), 'utf-8');
    const swatches = Object.fromEntries([...source.matchAll(/value: '(\w+)',[^}]*swatch: '(#[0-9a-f]{6})'/g)].map((m) => [m[1], m[2]]));
    expect(DBML_RICH_STICKY_COLOURS).toEqual(swatches);
    for (const hex of Object.values(DBML_RICH_STICKY_COLOURS)) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('reads each swatch and canvas background back as its colour', () => {
    for (const [colour, hex] of Object.entries(DBML_RICH_STICKY_COLOURS)) {
      expect(stickyColourOfHex(hex)).toBe(colour);
      expect(stickyColourOfHex(hex.toUpperCase())).toBe(colour);
    }
    expect(stickyColourOfHex('#fef3c7')).toBe('yellow');
    expect(stickyColourOfHex('#dbeafe')).toBe('blue');
  });

  it('reads any other hex as the nearest colour', () => {
    expect(stickyColourOfHex('#ffcc00')).toBe('yellow');
    expect(stickyColourOfHex('#0000ff')).toBe('blue');
    expect(stickyColourOfHex('#00ff00')).toBe('green');
    expect(stickyColourOfHex('#f0f')).toBe('pink');
    expect(stickyColourOfHex('#ff7f00')).toBe('orange');
  });

  it('reads nothing from something that is not a hex colour', () => {
    for (const value of ['', 'yellow', '#12', '#12345', '#ggg', 'rgb(1,2,3)', '#abcd']) expect(stickyColourOfHex(value)).toBeUndefined();
    expect(stickyColourOfHex(undefined as unknown as string)).toBeUndefined();
  });
});
