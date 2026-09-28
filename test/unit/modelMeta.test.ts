/**
 * Structured metadata (`meta:`) on models and columns — issue #95.
 *
 * The rule: `meta` is the user's map. ERD Studio reads all of it, writes only
 * the top-level key that changed, and leaves every other byte — comments,
 * unquoted numbers, nested maps and lists — exactly as it was written.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { parseLogicalModelText, toDisplayDomain } from '@erd-studio/core';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { validateMetaPayload } from '../../src/providers/payloadValidation';

const MODEL_WITH_META = [
  'name: dim_customer',
  'description: Customer dimension',
  'meta:',
  '  owner: finance # the team that answers questions',
  '  tier: 1',
  '  lineage:',
  '    # upstream systems',
  '    source: sap',
  '    tables:',
  '      - kna1',
  '      - knvv',
  'columns:',
  '  - name: customer_key',
  '    dataType: string',
  '    meta:',
  '      pii: false',
  '      steward: jane',
  '',
].join('\n');

describe('parsing meta', () => {
  it('reads model and column meta, numbers as their source text', () => {
    const model = parseLogicalModelText(MODEL_WITH_META, 'dim_customer');
    expect(model.meta).toEqual({
      owner: 'finance',
      tier: '1',
      lineage: { source: 'sap', tables: ['kna1', 'knvv'] },
    });
    expect(model.columns![0].meta).toEqual({ pii: false, steward: 'jane' });
  });

  it('ignores a meta that is not a map, and an empty one', () => {
    expect(parseLogicalModelText('name: a\nmeta: finance\n', 'a')).not.toHaveProperty('meta');
    expect(parseLogicalModelText('name: a\nmeta: [x]\n', 'a')).not.toHaveProperty('meta');
    expect(parseLogicalModelText('name: a\nmeta: {}\n', 'a')).not.toHaveProperty('meta');
  });

  it('reaches the display domain only where it is set', () => {
    const model = parseLogicalModelText(MODEL_WITH_META, 'dim_customer');
    const plain = parseLogicalModelText('name: dim_plain\ncolumns:\n  - name: id\n    dataType: int\n', 'dim_plain');
    const display = toDisplayDomain({
      schemaVersion: 5, domain: 'd', layer: 'silver', stage: 'logical', description: '',
      models: [model, plain], relationships: [],
    } as unknown as Parameters<typeof toDisplayDomain>[0], { viewConfig: {} });
    expect(display.models[0].meta).toEqual(model.meta);
    expect(display.models[0].columns[0].meta).toEqual({ pii: false, steward: 'jane' });
    expect(display.models[1]).not.toHaveProperty('meta');
    expect(display.models[1].columns[0]).not.toHaveProperty('meta');
  });
});

describe('writing meta', () => {
  let root: string;
  let service: LogicalModelService;
  let filePath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-meta-'));
    service = new LogicalModelService(root, '.erd-studio');
    service.ensureDir();
    filePath = service.modelPath('dim_customer');
    fs.writeFileSync(filePath, MODEL_WITH_META, 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('changes one value and leaves every other byte alone', () => {
    const model = service.getModel('dim_customer')!;
    model.meta = { ...model.meta!, owner: 'sales' };
    const after = service.serializeModel(model);
    expect(after).toBe(MODEL_WITH_META.replace('owner: finance #', 'owner: sales #'));
  });

  it('removes only the key that was removed', () => {
    const model = service.getModel('dim_customer')!;
    const { owner: _owner, ...rest } = model.meta!;
    model.meta = rest;
    const after = service.serializeModel(model);
    expect(after).toBe(MODEL_WITH_META.replace('  owner: finance # the team that answers questions\n', ''));
  });

  it('adds a new key at the end of the map', () => {
    const model = service.getModel('dim_customer')!;
    model.columns![0].meta = { ...model.columns![0].meta!, source_field: 'KUNNR' };
    const after = service.serializeModel(model);
    expect(after).toBe(MODEL_WITH_META.replace('      steward: jane\n', '      steward: jane\n      source_field: KUNNR\n'));
  });

  it('keeps meta byte-identical through an unrelated edit', () => {
    const model = service.getModel('dim_customer')!;
    model.description = 'Everyone we sell to';
    const after = service.serializeModel(model);
    expect(after).toBe(MODEL_WITH_META.replace('Customer dimension', 'Everyone we sell to'));
  });

  it('leaves an alias an alias rather than expanding it', () => {
    const withAlias = [
      'name: dim_customer',
      'x-lineage: &sap',
      '  source: sap',
      'meta:',
      '  owner: finance',
      '  lineage: *sap',
      '',
    ].join('\n');
    fs.writeFileSync(filePath, withAlias, 'utf-8');
    const model = service.getModel('dim_customer')!;
    expect(model.meta!.lineage).toEqual({ source: 'sap' });
    model.meta = { ...model.meta!, owner: 'sales' };
    expect(service.serializeModel(model)).toBe(withAlias.replace('owner: finance', 'owner: sales'));
  });

  it('updates a key YAML reads as a number or boolean in place, never duplicating it', () => {
    const odd = ['name: dim_customer', 'meta:', '  2024: budgeted', '  true: yes-key', '  owner: finance', ''].join('\n');
    fs.writeFileSync(filePath, odd, 'utf-8');
    const model = service.getModel('dim_customer')!;
    expect(Object.keys(model.meta!)).toEqual(['2024', 'true', 'owner']);

    model.meta = { ...model.meta!, '2024': 'actual' };
    const after = service.serializeModel(model);
    expect(after).toBe(odd.replace('2024: budgeted', '2024: actual'));
    // The file still parses — a duplicate key would make it throw.
    fs.writeFileSync(filePath, after, 'utf-8');
    expect(service.getModel('dim_customer')!.meta).toEqual({ '2024': 'actual', true: 'yes-key', owner: 'finance' });
  });

  it('removes a key named like an Object.prototype member', () => {
    fs.writeFileSync(filePath, 'name: dim_customer\nmeta:\n  toString: x\n  owner: finance\n', 'utf-8');
    const model = service.getModel('dim_customer')!;
    model.meta = { owner: 'finance' };
    expect(service.serializeModel(model)).toBe('name: dim_customer\nmeta:\n  owner: finance\n');
  });

  it('keeps a key named __proto__ as ordinary data', () => {
    const proto = 'name: dim_customer\nmeta:\n  __proto__: kept\n  owner: finance\n';
    fs.writeFileSync(filePath, proto, 'utf-8');
    const model = service.getModel('dim_customer')!;
    expect(Object.prototype.hasOwnProperty.call(model.meta, '__proto__')).toBe(true);
    model.description = 'Everyone we sell to';
    expect(service.serializeModel(model)).toBe(`${proto}description: Everyone we sell to\n`);
  });

  it('removes the meta key when the last entry goes', () => {
    const model = service.getModel('dim_customer')!;
    delete model.meta;
    delete model.columns![0].meta;
    const after = service.serializeModel(model);
    expect(after).not.toMatch(/meta:/);
    expect(after).toContain('description: Customer dimension');
  });

  it('writes meta into a brand-new file', () => {
    service.saveModel({ name: 'fct_sale', meta: { owner: 'sales' }, columns: [{ name: 'id', dataType: 'int', description: '', meta: { pii: false } }] });
    const text = fs.readFileSync(service.modelPath('fct_sale'), 'utf-8');
    expect(parseLogicalModelText(text, 'fct_sale')).toMatchObject({
      meta: { owner: 'sales' },
      columns: [{ meta: { pii: false } }],
    });
  });
});

describe('validateMetaPayload', () => {
  it('accepts a set, a remove, and a column target', () => {
    expect(validateMetaPayload({ modelName: 'dim_customer', set: { owner: 'sales' } })).toBeNull();
    expect(validateMetaPayload({ modelName: 'dim_customer', remove: ['owner'] })).toBeNull();
    expect(validateMetaPayload({ modelName: 'dim_customer', columnName: 'customer_key', set: { pii: 'yes' } })).toBeNull();
    expect(validateMetaPayload({ modelName: 'dim_customer', set: { owner: '' } })).toBeNull();
  });

  it('refuses a patch that changes nothing, or sets and removes one key', () => {
    expect(validateMetaPayload({ modelName: 'dim_customer' })).toMatch(/Nothing to change/);
    expect(validateMetaPayload({ modelName: 'dim_customer', set: { a: 'x' }, remove: ['a'] })).toMatch(/set and removed/);
  });

  it('refuses values that are not text and keys that are not one clean line', () => {
    expect(validateMetaPayload({ modelName: 'dim_customer', set: { tier: 1 } })).toMatch(/must be text/);
    expect(validateMetaPayload({ modelName: 'dim_customer', set: { lineage: { a: 'b' } } })).toMatch(/must be text/);
    expect(validateMetaPayload({ modelName: 'dim_customer', set: { '': 'x' } })).toMatch(/key is required/);
    expect(validateMetaPayload({ modelName: 'dim_customer', set: { ' owner': 'x' } })).toMatch(/space/);
    expect(validateMetaPayload({ modelName: 'dim_customer', set: { 'a\nb': 'x' } })).toMatch(/single line/);
  });

  it('refuses an unsafe model name', () => {
    expect(validateMetaPayload({ modelName: '../escape', set: { a: 'b' } })).not.toBeNull();
  });
});
