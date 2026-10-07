import { describe, it, expect } from 'vitest';

import { checkRelationships, type CheckDomain, type CheckLibraryModel } from '../../src/relationshipChecks';
import { parseLogicalModelText } from '../../src/logicalModel';
import type { ModelRelationship, Relationship, SemanticModel } from '../../src/types/semantic';

const col = (name: string, flags: Partial<{ isPrimaryKey: boolean; isForeignKey: boolean }> = {}) => ({ name, dataType: 'INT', description: '', ...flags });
const rel = (fromColumn: string, toModel: string, toColumn: string, extra: Partial<ModelRelationship> = {}): ModelRelationship => ({
  fromColumn, toModel, toColumn, cardinality: 'many-to-one', ...extra,
});
const entry = (model: SemanticModel): CheckLibraryModel => ({ model, file: `logical-models/${model.name}.yml` });

const dimCustomer = (rels: ModelRelationship[] = []): SemanticModel => ({
  name: 'dim_customer', columns: [col('customer_key', { isPrimaryKey: true })], ...(rels.length ? { relationships: rels } : {}),
});
const fctOrder = (rels: ModelRelationship[] = []): SemanticModel => ({
  name: 'fct_order', columns: [col('order_key', { isPrimaryKey: true }), col('customer_key', { isForeignKey: true })], ...(rels.length ? { relationships: rels } : {}),
});
const TO_CUSTOMER = rel('customer_key', 'dim_customer', 'customer_key');
const domain = (over: Partial<CheckDomain> = {}): CheckDomain => ({
  label: 'silver/orders', filePath: '.erd-studio/silver/orders.json', models: ['fct_order', 'dim_customer'], relationships: [], mode: 'library', ...over,
});
const own = (r: Partial<Relationship> = {}): Relationship => ({
  fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one', ...r,
});
const summary = (findings: ReturnType<typeof checkRelationships>) => findings.map((f) => `${f.code}:${f.severity}`);

describe('checkRelationships — stable codes (#133)', () => {
  it('finds nothing in a clean project', () => {
    expect(checkRelationships({ libraryModels: [entry(fctOrder([TO_CUSTOMER])), entry(dimCustomer())], domains: [domain()] })).toEqual([]);
  });

  it('REL001: the same link in two model files (warning when they agree, error when not)', () => {
    const reversed = rel('customer_key', 'fct_order', 'customer_key', { cardinality: 'one-to-many' });
    const agree = checkRelationships({ libraryModels: [entry(fctOrder([TO_CUSTOMER])), entry(dimCustomer([reversed]))], domains: [] });
    expect(summary(agree)).toEqual(['REL001:warning', 'REL002:warning']);
    const dup = agree.find((f) => f.code === 'REL001')!;
    expect(dup.files).toEqual(['logical-models/fct_order.yml', 'logical-models/dim_customer.yml']);
    expect(dup.fix).toBe('remove-duplicates');
    expect(dup.records?.[0].source).toEqual({ kind: 'library', model: 'fct_order', index: 0 });

    const differ = checkRelationships({
      libraryModels: [entry(fctOrder([TO_CUSTOMER])), entry(dimCustomer([{ ...reversed, role: 'buyer' }]))], domains: [],
    });
    expect(differ.find((f) => f.code === 'REL001')).toMatchObject({ severity: 'error', fix: 'choose' });
  });

  it('REL001: twice in one domain file; across domain files only in a library project', () => {
    expect(summary(checkRelationships({ libraryModels: [entry(fctOrder()), entry(dimCustomer())], domains: [domain({ relationships: [own(), own()] })] })))
      .toEqual(['REL001:warning']);
    const perDomain = checkRelationships({
      libraryModels: [entry(fctOrder()), entry(dimCustomer())],
      domains: [domain({ mode: 'domain', relationships: [own()] }), domain({ mode: 'domain', filePath: 'gold/b.json', relationships: [own()] })],
    });
    expect(perDomain).toEqual([]);
    const library = checkRelationships({
      libraryModels: [entry(fctOrder()), entry(dimCustomer())],
      domains: [domain({ relationships: [own()] }), domain({ filePath: 'gold/b.json', relationships: [own()] })],
    });
    expect(summary(library)).toEqual(['REL001:warning']);
  });

  it('REL001 for a domain copy that disagrees with the library; REL009 for one that agrees', () => {
    const lib = entry(fctOrder([TO_CUSTOMER]));
    const disagree = checkRelationships({ libraryModels: [lib, entry(dimCustomer())], domains: [domain({ relationships: [own({ cardinality: 'one-to-one' })] })] });
    expect(summary(disagree)).toEqual(['REL001:error']);
    const agree = checkRelationships({ libraryModels: [lib, entry(dimCustomer())], domains: [domain({ relationships: [own()] })] });
    expect(summary(agree)).toEqual(['REL009:info']);
    expect(agree[0]).toMatchObject({ fix: 'remove-domain-copy', files: ['.erd-studio/silver/orders.json', 'logical-models/fct_order.yml'] });
  });

  it('REL002: a one-to-many stored in a model file names its home too', () => {
    const findings = checkRelationships({
      libraryModels: [entry(fctOrder()), entry(dimCustomer([rel('customer_key', 'fct_order', 'customer_key', { cardinality: 'one-to-many' })]))],
      domains: [],
    });
    expect(findings).toMatchObject([{ code: 'REL002', fix: 'rehome', files: ['logical-models/dim_customer.yml', 'logical-models/fct_order.yml'] }]);
  });

  it('REL003: an endpoint model missing from the library — but not an unreadable one or a stub', () => {
    const lib = [entry(fctOrder([rel('customer_key', 'dim_gone', 'k')]))];
    expect(summary(checkRelationships({ libraryModels: lib, domains: [] }))).toEqual(['REL003:error']);
    expect(checkRelationships({ libraryModels: lib, domains: [], unreadableModels: [{ name: 'dim_gone', file: 'x.yml', line: 3 }] })).toEqual([]);
    expect(checkRelationships({
      libraryModels: [entry(fctOrder())],
      domains: [domain({ relationships: [own({ toModel: 'dim_stub', toColumn: 'k' })], stubColumns: ['dim_stub'] })],
    })).toEqual([]);
  });

  it('REL004: an endpoint column missing — not for a model with no columns yet', () => {
    const findings = checkRelationships({ libraryModels: [entry(fctOrder([rel('customer_key', 'dim_customer', 'nope')])), entry(dimCustomer())], domains: [] });
    expect(findings).toMatchObject([{ code: 'REL004', severity: 'error', fix: 'repoint' }]);
    expect(findings[0].message).toMatch(/dim_customer\.nope, which dim_customer does not have/);
    expect(checkRelationships({ libraryModels: [entry(fctOrder([rel('customer_key', 'empty', 'k')])), entry({ name: 'empty' })], domains: [] })).toEqual([]);
  });

  it('REL005: an endpoint that matches only without case', () => {
    const findings = checkRelationships({ libraryModels: [entry(fctOrder([rel('Customer_Key', 'DIM_customer', 'customer_key')])), entry(dimCustomer())], domains: [] });
    expect(findings).toMatchObject([{ code: 'REL005', severity: 'warning', fix: 'respell' }]);
    expect(findings[0].message).toMatch(/Customer_Key → customer_key/);
    expect(findings[0].message).toMatch(/DIM_customer → dim_customer/);
  });

  it('REL006: a direction that contradicts certain key evidence is info only', () => {
    const findings = checkRelationships({
      libraryModels: [entry(fctOrder()), entry(dimCustomer([rel('customer_key', 'fct_order', 'customer_key')]))],
      domains: [],
    });
    expect(findings).toMatchObject([{ code: 'REL006', severity: 'info', fix: 'swap' }]);
  });

  it('REL008: entries skipped or defaulted on read, with their line', () => {
    const model = parseLogicalModelText([
      'name: fct_order',
      'relationships:',
      '  - { fromColumn: customer_key, toModel: dim_customer, toColumn: customer_key, cardinality: many-to-one }',
      '  - { toModel: dim_customer }',
    ].join('\n'), 'fct_order')!;
    const findings = checkRelationships({ libraryModels: [entry(model), entry(dimCustomer())], domains: [] });
    expect(findings).toMatchObject([{ code: 'REL008', severity: 'error', line: 4, fix: 'open-file', files: ['logical-models/fct_order.yml'] }]);
  });

  it('checks a v4 domain against its inline models', () => {
    const findings = checkRelationships({
      libraryModels: [],
      domains: [domain({ mode: 'domain', models: [fctOrder(), dimCustomer()], relationships: [own(), own({ fromColumn: 'gone' })] })],
    });
    expect(summary(findings)).toEqual(['REL004:error']);
  });

  it('sorts errors first, then by code, and never repeats a file', () => {
    const findings = checkRelationships({
      libraryModels: [
        entry(fctOrder([rel('customer_key', 'dim_gone', 'k'), rel('Customer_Key', 'dim_customer', 'customer_key')])),
        entry(dimCustomer()),
      ],
      domains: [domain({ relationships: [own(), own()] })],
    });
    expect(summary(findings)).toEqual(['REL003:error', 'REL005:warning', 'REL001:warning', 'REL009:info'].sort((a, b) => {
      const order = { error: 0, warning: 1, info: 2 } as Record<string, number>;
      return order[a.split(':')[1]] - order[b.split(':')[1]] || a.localeCompare(b);
    }));
    for (const f of findings) expect(new Set(f.files).size).toBe(f.files.length);
  });
});
