/**
 * Dimensional-modelling invariants for the built-in templates and the sample
 * models shipped in `test/fixtures/dbt-project`.
 *
 * These exist because the defaults used to teach the opposite of what the AI
 * harness documents: `{name}_id` described as a "Surrogate key" and flagged as
 * the primary key, and `customer_name` / `site_name` flagged `isNaturalKey` —
 * a uniqueness claim a person's name cannot honour. The demo GIF on the
 * marketplace listing showed the second one, which is how it was spotted.
 *
 * The rules asserted here:
 *   1. A dimension's primary key is a `_key` surrogate, unique per ROW.
 *   2. A dimension's natural key is an identifier or code, unique per ENTITY —
 *      never a name or label, and never the primary key (under SCD2 one entity
 *      owns several rows, so the business key repeats by design).
 *   3. Facts point at dimension surrogates, so their FK columns end `_key`.
 *   4. dim_date is the documented exception: a meaningful YYYYMMDD key.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

import { TemplateService } from '../../src/services/templateService';
import type { ColumnDef, ModelTemplate } from '../../src/types/semantic';

const FIXTURE = path.resolve(__dirname, '../fixtures/dbt-project');
const MODELS_DIR = path.join(FIXTURE, '.erd-studio', 'logical-models');

/** Words that describe a thing rather than identify one. */
const LABEL_LIKE = /(^|_)(name|label|title|description)$/i;

function loadModel(name: string): { name: string; columns: ColumnDef[] } {
  return parse(fs.readFileSync(path.join(MODELS_DIR, `${name}.yml`), 'utf-8'));
}

const dimensionNames = fs
  .readdirSync(MODELS_DIR)
  .filter((f) => f.startsWith('dim_') && f.endsWith('.yml'))
  .map((f) => path.basename(f, '.yml'));

const factNames = fs
  .readdirSync(MODELS_DIR)
  .filter((f) => f.startsWith('fct_') && f.endsWith('.yml'))
  .map((f) => path.basename(f, '.yml'));

// ---------------------------------------------------------------------------
// Built-in templates — what every user without custom templates inherits
// ---------------------------------------------------------------------------

describe('built-in templates', () => {
  const templates: ModelTemplate[] = new TemplateService().loadTemplates(
    // A path with no templates dir forces the built-in fallbacks.
    path.join(FIXTURE, 'does-not-exist'),
  );
  const byId = new Map(templates.map((t) => [t.id, t]));

  it.each(['dimension', 'scd2'])('%s keys the surrogate, not the business key', (id) => {
    const cols = byId.get(id)!.columns;
    const pk = cols.filter((c) => c.isPrimaryKey);
    const nk = cols.filter((c) => c.isNaturalKey);

    expect(pk.map((c) => c.name)).toEqual(['{name}_key']);
    expect(nk.map((c) => c.name)).toEqual(['{name}_id']);
    // The two must be different columns: under SCD2 the business key repeats
    // across versions, so a primary key that is also the business key is not
    // unique and the template would ship a broken model.
    expect(pk[0].name).not.toBe(nk[0].name);
  });

  it('scd2 tracks history on attributes, and never on either key', () => {
    const cols = byId.get('scd2')!.columns;
    const tracked = cols.filter((c) => c.scdType === 2).map((c) => c.name);

    expect(tracked.length).toBeGreaterThan(0);
    expect(tracked).not.toContain('{name}_key');
    expect(tracked).not.toContain('{name}_id');
    // The machinery that makes versions addressable has to be present.
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['scd_valid_from', 'scd_valid_to', 'scd_is_current']),
    );
  });

  it('the Type 1 dimension carries no Type 2 effective dating', () => {
    const names = byId.get('dimension')!.columns.map((c) => c.name);
    expect(names).not.toContain('valid_from');
    expect(names).not.toContain('valid_to');
    expect(names).not.toContain('scd_valid_from');
  });

  it('scd2 does not duplicate its effective dating', () => {
    const names = byId.get('scd2')!.columns.map((c) => c.name);
    expect(names).not.toContain('valid_from');
    expect(names).not.toContain('valid_to');
  });

  it('bridge flags its two sides as foreign keys to dimension surrogates', () => {
    const cols = byId.get('bridge')!.columns;
    const fks = cols.filter((c) => c.isForeignKey).map((c) => c.name);
    expect(fks).toEqual(['{left}_key', '{right}_key']);
  });

  it('no template flags a label as the natural key', () => {
    for (const template of templates) {
      for (const col of template.columns) {
        if (col.isNaturalKey) {
          expect(col.name, `${template.id}.${col.name}`).not.toMatch(LABEL_LIKE);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Sample models — what the docs, the sidebar and the demo GIF put on screen
// ---------------------------------------------------------------------------

describe('sample dimensions', () => {
  it('there are dimensions to check', () => {
    expect(dimensionNames.length).toBeGreaterThan(0);
  });

  it.each(dimensionNames)('%s has exactly one primary key', (name) => {
    const pks = loadModel(name).columns.filter((c) => c.isPrimaryKey);
    expect(pks).toHaveLength(1);
  });

  it.each(dimensionNames)('%s never flags a name as the natural key', (name) => {
    for (const col of loadModel(name).columns) {
      if (col.isNaturalKey) {
        expect(col.name, `${name}.${col.name}`).not.toMatch(LABEL_LIKE);
      }
    }
  });

  it.each(dimensionNames)('%s keeps the surrogate and the business key apart', (name) => {
    const cols = loadModel(name).columns;
    const pk = cols.find((c) => c.isPrimaryKey)!;
    const nk = cols.find((c) => c.isNaturalKey);
    expect(nk, `${name} should declare a business key`).toBeDefined();
    expect(nk!.name).not.toBe(pk.name);
  });

  it('dim_date is the exception — a meaningful key, by convention', () => {
    const cols = loadModel('dim_date').columns;
    const pk = cols.find((c) => c.isPrimaryKey)!;
    expect(pk.name).toBe('date_key');
    expect(pk.dataType).toBe('INT');
    // The date itself is what the dimension is identified by.
    expect(cols.find((c) => c.isNaturalKey)!.name).toBe('calendar_date');
  });

  it('every other dimension names its primary key _key', () => {
    for (const name of dimensionNames) {
      const pk = loadModel(name).columns.find((c) => c.isPrimaryKey)!;
      expect(pk.name, name).toMatch(/_key$/);
    }
  });
});

describe('sample facts', () => {
  it.each(factNames)('%s points its foreign keys at dimension surrogates', (name) => {
    for (const col of loadModel(name).columns.filter((c) => c.isForeignKey)) {
      expect(col.name, `${name}.${col.name}`).toMatch(/_key$/);
    }
  });

  it.each(factNames)('%s keys itself on a degenerate business identifier', (name) => {
    const pk = loadModel(name).columns.find((c) => c.isPrimaryKey);
    expect(pk, `${name} should declare a primary key`).toBeDefined();
    // A transaction fact's own id IS the source system's id, so it is both the
    // primary key and the business key rather than being shadowed by a
    // surrogate that would buy nothing.
    expect(pk!.isNaturalKey).toBe(true);
  });
});
