import { describe, it, expect } from 'vitest';

import { checkRelationships, type CheckDomain, type CheckLibraryModel } from '../../src/relationshipChecks';
import { parseLogicalModelText } from '../../src/logicalModel';
import { normaliseRelationships } from '../../src/normaliseRelationships';
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

  it('REL009 (info, never REL001) for a library project\'s domain copy of a library link, saying whether it differs', () => {
    const lib = entry(fctOrder([TO_CUSTOMER]));
    const disagree = checkRelationships({ libraryModels: [lib, entry(dimCustomer())], domains: [domain({ relationships: [own({ cardinality: 'one-to-one' })] })] });
    expect(summary(disagree)).toEqual(['REL009:info']);
    expect(disagree[0]).toMatchObject({ fix: 'ignored-domain-copy', files: ['.erd-studio/silver/orders.json', 'logical-models/fct_order.yml'] });
    expect(disagree[0].message).toMatch(/differs on cardinality \(model library: many-to-one; here: one-to-one\); diagrams draw the model library's copy and ignore this one/);
    const agree = checkRelationships({ libraryModels: [lib, entry(dimCustomer())], domains: [domain({ relationships: [own()] })] });
    expect(summary(agree)).toEqual(['REL009:info']);
    expect(agree[0]).toMatchObject({ fix: 'remove-domain-copy', files: ['.erd-studio/silver/orders.json', 'logical-models/fct_order.yml'] });
    expect(agree[0].message).toMatch(/so this diagram file's copy is not needed — Repair Relationships… removes it/);
    // Stored the other way round (a one-to-one) and with another role: both said.
    const turned = checkRelationships({
      libraryModels: [entry(fctOrder([rel('customer_key', 'dim_customer', 'customer_key', { cardinality: 'one-to-one' })])), entry(dimCustomer())],
      domains: [domain({ relationships: [own({ fromModel: 'dim_customer', toModel: 'fct_order', cardinality: 'one-to-one', role: 'buyer' })] })],
    });
    expect(summary(turned).filter((c) => c.startsWith('REL009') || c.startsWith('REL001'))).toEqual(['REL009:info']);
    expect(turned.find((f) => f.code === 'REL009')!.message).toMatch(/differs on direction and role \(model library: one-to-one; here: one-to-one "buyer" dim_customer\.customer_key → fct_order\.customer_key\)/);
  });

  it('a library project\'s domain file holding two copies of a library link: one REL009 naming both, no REL001', () => {
    const lib = entry(fctOrder([TO_CUSTOMER]));
    const findings = checkRelationships({
      libraryModels: [lib, entry(dimCustomer())], domains: [domain({ relationships: [own(), own({ role: 'buyer' })] })],
    });
    expect(summary(findings)).toEqual(['REL009:info']);
    expect(findings[0].records).toHaveLength(3);
    expect(findings[0].message).toMatch(/keeps its own 2 copies, which differs on role/);
  });

  it('REL001 between two model library copies stays an error beside a domain copy (REL009)', () => {
    const findings = checkRelationships({
      libraryModels: [entry(fctOrder([TO_CUSTOMER])), entry(dimCustomer([rel('customer_key', 'fct_order', 'customer_key', { cardinality: 'one-to-many', role: 'buyer' })]))],
      domains: [domain({ relationships: [own()] })],
    });
    expect(summary(findings)).toEqual(['REL001:error', 'REL002:warning', 'REL009:info']);
    expect(findings[0].files).toEqual(['logical-models/fct_order.yml', 'logical-models/dim_customer.yml']);
  });

  it('a v4 diagram\'s own copy is never compared with the library: it never draws the library\'s', () => {
    const lib = entry(fctOrder([TO_CUSTOMER]));
    // Inline models (as the v4 reader has them), and the flag toCheckDomains sets.
    for (const v4 of [
      domain({ mode: 'domain', models: [fctOrder(), dimCustomer()], relationships: [own({ cardinality: 'many-to-many' })] }),
      domain({ mode: 'domain', olderFormat: true, relationships: [own({ cardinality: 'many-to-many' })] }),
    ]) {
      expect(checkRelationships({ libraryModels: [lib, entry(dimCustomer())], domains: [v4] })).toEqual([]);
    }
    // Its own copies are still checked against each other.
    const twice = checkRelationships({
      libraryModels: [lib, entry(dimCustomer())],
      domains: [domain({ mode: 'domain', models: [fctOrder(), dimCustomer()], relationships: [own(), own({ cardinality: 'one-to-one' })] })],
    });
    expect(summary(twice)).toEqual(['REL001:error']);
    expect(twice[0].files).toEqual(['.erd-studio/silver/orders.json']);
  });

  it('REL002: a one-to-many stored in a model file names its home too', () => {
    const findings = checkRelationships({
      libraryModels: [entry(fctOrder()), entry(dimCustomer([rel('customer_key', 'fct_order', 'customer_key', { cardinality: 'one-to-many' })]))],
      domains: [],
    });
    expect(findings).toMatchObject([{ code: 'REL002', fix: 'rehome', files: ['logical-models/dim_customer.yml', 'logical-models/fct_order.yml'] }]);
  });

  it('REL003: a domain record naming a library model the diagram does not hold (v5 and v4)', () => {
    const v5 = checkRelationships({
      libraryModels: [entry(fctOrder()), entry(dimCustomer())],
      domains: [domain({ models: ['fct_order'], relationships: [own()] })],
    });
    expect(summary(v5)).toEqual(['REL003:error']);
    expect(v5[0].message).toMatch(/dim_customer, which is not one of this diagram's models/);
    expect(v5[0]).toMatchObject({ files: ['.erd-studio/silver/orders.json'], fix: 'repoint' });

    const v4 = checkRelationships({
      libraryModels: [entry(dimCustomer())],
      domains: [domain({ mode: 'domain', models: [fctOrder()], relationships: [own()] })],
    });
    expect(summary(v4)).toEqual(['REL003:error']);
    // A stub the diagram lists is not a finding.
    expect(checkRelationships({
      libraryModels: [entry(fctOrder()), entry(dimCustomer())],
      domains: [domain({ models: ['fct_order', 'dim_customer'], stubColumns: ['dim_customer'], relationships: [own()] })],
    })).toEqual([]);
    // A name only in stubColumns is not on the diagram: the record is not
    // drawn, and check says so exactly as the canvas does (#133 review).
    const stubOnly = { models: [fctOrder(), dimCustomer()].filter((m) => m.name === 'fct_order'), own: [own()] };
    expect(normaliseRelationships(stubOnly).relationships[0].issues).toEqual(['REL003']);
    const notListed = checkRelationships({
      libraryModels: [entry(fctOrder()), entry(dimCustomer())],
      domains: [domain({ models: ['fct_order'], stubColumns: ['dim_customer'], relationships: [own()] })],
    });
    expect(summary(notListed)).toEqual(['REL003:error']);
    expect(notListed[0].message).toMatch(/dim_customer, which is not one of this diagram's models/);
  });

  it('REL001 numbers its entries by their place in the file, counting an entry the reader skipped', () => {
    const fct = parseLogicalModelText([
      'name: fct_order',
      'columns:',
      '  - name: customer_key',
      '    dataType: string',
      'relationships:',
      '  - { fromColumn: customer_key, toModel: dim_customer, toColumn: customer_key, cardinality: many-to-one }',
      '  - { fromColumn: customer_key, toColumn: customer_key }',
      '  - { fromColumn: customer_key, toModel: dim_customer, toColumn: customer_key, cardinality: many-to-one }',
    ].join('\n'), 'fct_order')!;
    const library = checkRelationships({ libraryModels: [entry(fct), entry(dimCustomer())], domains: [] });
    expect(library.find((f) => f.code === 'REL008')!.message).toMatch(/entry 2 of fct_order/);
    expect(library.find((f) => f.code === 'REL001')!.message).toMatch(/fct_order\.yml entry 1, logical-models\/fct_order\.yml entry 3\)/);

    const domainFindings = checkRelationships({
      libraryModels: [entry(fctOrder()), entry(dimCustomer())],
      domains: [domain({
        relationships: [own(), own()],
        readIssues: [{ index: 1, reason: 'missing-endpoint', skipped: true, message: 'Relationship entry 2 of diagram silver/orders has no fromColumn, toModel, toColumn and was skipped' }],
      })],
    });
    expect(domainFindings.find((f) => f.code === 'REL001')!.message).toMatch(/orders\.json entry 1, \.erd-studio\/silver\/orders\.json entry 3\)/);
  });

  it('REL003: an endpoint model missing from the library — but not an unreadable one or a stub', () => {
    const lib = [entry(fctOrder([rel('customer_key', 'dim_gone', 'k')]))];
    expect(summary(checkRelationships({ libraryModels: lib, domains: [] }))).toEqual(['REL003:error']);
    expect(checkRelationships({ libraryModels: lib, domains: [], unreadableModels: [{ name: 'dim_gone', file: 'x.yml', line: 3 }] })).toEqual([]);
    expect(checkRelationships({
      libraryModels: [entry(fctOrder())],
      // The stub is on the diagram (listed in logical.models) but has no model file.
      domains: [domain({ models: ['fct_order', 'dim_customer', 'dim_stub'], relationships: [own({ toModel: 'dim_stub', toColumn: 'k' })], stubColumns: ['dim_stub'] })],
    })).toEqual([]);
  });

  it('REL004: an endpoint column missing — not for a model with no columns yet', () => {
    const findings = checkRelationships({ libraryModels: [entry(fctOrder([rel('customer_key', 'dim_customer', 'nope')])), entry(dimCustomer())], domains: [] });
    expect(findings).toMatchObject([{ code: 'REL004', severity: 'error', fix: 'repoint' }]);
    expect(findings[0].message).toMatch(/dim_customer\.nope, which dim_customer does not have/);
    expect(checkRelationships({ libraryModels: [entry(fctOrder([rel('customer_key', 'empty', 'k')])), entry({ name: 'empty' })], domains: [] })).toEqual([]);
  });

  it('checks a v4 domain whose inline columns have no text name without throwing', () => {
    // Hand-edited v4 files can hold `{ "dataType": "INT" }` or `{ "name": 123 }`;
    // they drew before #133, so a case-only endpoint match must skip those columns.
    const inline = (name: string, columns: unknown[]): SemanticModel => ({ name, columns: columns as SemanticModel['columns'] });
    const findings = checkRelationships({
      libraryModels: [],
      domains: [domain({
        mode: 'domain',
        olderFormat: true,
        models: [
          inline('fct_order', [{ dataType: 'INT' }, { name: 123 }, col('customer_key')]),
          inline('dim_customer', [{ dataType: 'VARCHAR' }, col('Customer_Key', { isPrimaryKey: true })]),
        ],
        relationships: [own({ fromColumn: 'CUSTOMER_KEY' })],
      })],
    });
    expect(summary(findings)).toEqual(['REL005:warning']);
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
    // The fact has its own key: the 1.6.7 shape beyond doubt, which Repair turns round.
    expect(findings).toMatchObject([{ code: 'REL006', severity: 'info', fix: 'rehome' }]);
    expect(findings[0].message).toMatch(/Repair Relationships… turns it round$/);
  });

  it('REL006: a reading the keys leave open is the user\'s (fix: swap) — a key pointing at a model with no key of its own', () => {
    // A one-to-one aggregate at the dimension's grain, the dimension unflagged (#133).
    const agg: SemanticModel = {
      name: 'agg_customer_ltv',
      columns: [col('customer_id', { isPrimaryKey: true, isForeignKey: true }), col('ltv')],
      relationships: [rel('customer_id', 'dim_customer', 'customer_id')],
    };
    const dim: SemanticModel = { name: 'dim_customer', columns: [col('customer_id'), col('name')] };
    const findings = checkRelationships({ libraryModels: [entry(agg), entry(dim)], domains: [] });
    expect(findings).toMatchObject([{ code: 'REL006', severity: 'info', fix: 'swap' }]);
    expect(findings[0].message).not.toMatch(/Repair Relationships/);
  });

  it('REL006: a domain file\'s copy in the 1.6.7 shape is the user\'s (fix: swap) — Repair never turns a diagram copy round', () => {
    const findings = checkRelationships({
      libraryModels: [entry(fctOrder()), entry(dimCustomer())],
      domains: [domain({ models: ['fct_order', 'dim_customer'], relationships: [own({ fromModel: 'dim_customer', toModel: 'fct_order' })] })],
    });
    expect(findings.find((f) => f.code === 'REL006')).toMatchObject({ fix: 'swap' });
  });

  it('REL001: a model-library copy that is the 1.6.7 shape of the other is a warning naming it, never copies to choose between', () => {
    const findings = checkRelationships({
      libraryModels: [entry(fctOrder([TO_CUSTOMER])), entry(dimCustomer([rel('customer_key', 'fct_order', 'customer_key')]))],
      domains: [],
    });
    const dup = findings.find((f) => f.code === 'REL001')!;
    expect(dup).toMatchObject({ severity: 'warning', fix: 'remove-duplicates' });
    // The fact's copy is the one kept (named first), however the holders sort.
    expect(dup.records?.[0].source).toEqual({ kind: 'library', model: 'fct_order', index: 0 });
    expect(dup.message).toMatch(/the copy in logical-models\/dim_customer\.yml is the same relationship saved backwards .* Repair Relationships… removes it$/);
  });

  it('REL006: a many-to-one from a whole primary key is flagged even when the other end has no key flags (1.6.7 dim → fact drag)', () => {
    const plainFact: SemanticModel = { name: 'fct_order', columns: [col('order_line_key', { isPrimaryKey: true }), col('customer_key')] };
    const findings = checkRelationships({
      libraryModels: [entry(plainFact), entry(dimCustomer([rel('customer_key', 'fct_order', 'customer_key')]))],
      domains: [],
    });
    expect(findings).toMatchObject([{ code: 'REL006', severity: 'info', fix: 'rehome', files: ['logical-models/dim_customer.yml'] }]);
    expect(findings[0].message).toMatch(/dim_customer\.customer_key is dim_customer's primary key, so its values are unique and it cannot be the many side/);
    // Only one end's key is known: it never claims which fix is right (#133 review 8)…
    expect(findings[0].message).toMatch(/either the relationship runs the other way, or both sides are unique and it is one-to-one\./);
    // …but the fact's own key on another column settles it: the 1.6.7 shape, which Repair turns round.
    expect(findings[0].message).toMatch(/1\.6\.7 saved for a line drawn from a dimension to a fact — Repair Relationships… turns it round$/);
    // The same link stored the right way round is clean, and a one-to-one from a key is not a contradiction.
    expect(checkRelationships({
      libraryModels: [entry({ ...plainFact, relationships: [TO_CUSTOMER] }), entry(dimCustomer())], domains: [],
    })).toEqual([]);
    expect(checkRelationships({
      libraryModels: [entry(plainFact), entry(dimCustomer([rel('customer_key', 'fct_order', 'customer_key', { cardinality: 'one-to-one' })]))], domains: [],
    })).toEqual([]);
  });

  it('REL006: the 1.6.7 Draw from dbt shape (dimension key also marked FK, saved on the dimension) is flagged too', () => {
    const plainFact: SemanticModel = { name: 'fct_order', columns: [col('order_line_key', { isPrimaryKey: true }), col('customer_key')] };
    const dim: SemanticModel = {
      name: 'dim_customer',
      columns: [col('customer_key', { isPrimaryKey: true, isForeignKey: true })],
      relationships: [rel('customer_key', 'fct_order', 'customer_key')],
    };
    expect(summary(checkRelationships({ libraryModels: [entry(plainFact), entry(dim)], domains: [] }))).toEqual(['REL006:info']);
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

  it('REL008: a relationships: that is not a list at all, at the key\'s line', () => {
    const model = parseLogicalModelText([
      'name: fct_order',
      'relationships:',
      '  fromColumn: customer_key',
      '  toModel: dim_customer',
      '  toColumn: customer_key',
    ].join('\n'), 'fct_order')!;
    const findings = checkRelationships({ libraryModels: [entry(model), entry(dimCustomer())], domains: [] });
    expect(findings).toMatchObject([{ code: 'REL008', severity: 'error', line: 2, fix: 'open-file', files: ['logical-models/fct_order.yml'] }]);
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
    // The domain file's two copies of a library link are one note (REL009), not a duplicate.
    expect(summary(findings)).toEqual(['REL003:error', 'REL005:warning', 'REL009:info'].sort((a, b) => {
      const order = { error: 0, warning: 1, info: 2 } as Record<string, number>;
      return order[a.split(':')[1]] - order[b.split(':')[1]] || a.localeCompare(b);
    }));
    for (const f of findings) expect(new Set(f.files).size).toBe(f.files.length);
  });
});

describe('checkRelationships — models whose names differ only in case', () => {
  it('reports the same findings whatever order the models come in', () => {
    const t: SemanticModel = { name: 'T', columns: [{ name: 'id', dataType: 'INT', description: '', isPrimaryKey: true }] };
    const holder = (name: string, cardinality: 'many-to-one' | 'many-to-many'): SemanticModel => ({
      name,
      columns: [{ name: 'x', dataType: 'INT', description: '' }],
      relationships: [{ fromColumn: 'x', toModel: 'T', toColumn: 'id', cardinality }],
    });
    const lib = (m: SemanticModel): CheckLibraryModel => ({ model: m, file: `logical-models/${m.name}.yml` });
    const a = checkRelationships({ libraryModels: [lib(t), lib(holder('Dd', 'many-to-one')), lib(holder('DD', 'many-to-many'))], domains: [] });
    const b = checkRelationships({ libraryModels: [lib(holder('DD', 'many-to-many')), lib(t), lib(holder('Dd', 'many-to-one'))], domains: [] });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe('checkRelationships — deterministic and linear (#133 review)', () => {
  it('orders findings by code unit, never by the machine locale', async () => {
    const { vi } = await import('vitest');
    // A collation that reverses plain order, as lt_LT does for j/y and da_DK for aa/b.
    const spy = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (this: string, other: string) {
      const self = String(this);
      return self < other ? 1 : self > other ? -1 : 0;
    });
    try {
      const j: SemanticModel = { name: 'j', columns: [col('id', { isPrimaryKey: true })], relationships: [rel('id', 'nowhere', 'id')] };
      const y: SemanticModel = { name: 'y', columns: [col('id', { isPrimaryKey: true })], relationships: [rel('id', 'nowhere', 'id')] };
      const findings = checkRelationships({ libraryModels: [entry(y), entry(j)], domains: [] });
      expect(findings.map((f) => f.files[0])).toEqual(['logical-models/j.yml', 'logical-models/y.yml']);
    } finally {
      spy.mockRestore();
    }
  });

  it('reads each domain\'s model list once, not once per record', () => {
    const names = Array.from({ length: 40 }, (_, i) => `m${i}`);
    const libraryModels = names.map((n) => entry({ name: n, columns: [col('id', { isPrimaryKey: true }), col('ref_id')] }));
    const relationships: Relationship[] = names.slice(1).map((n, i) => ({
      fromModel: n, fromColumn: 'ref_id', toModel: names[i], toColumn: 'id', cardinality: 'many-to-one',
    }));
    let reads = 0;
    const d: CheckDomain = { label: 'gold/big', filePath: 'gold/big.json', relationships, mode: 'domain', models: [] };
    Object.defineProperty(d, 'models', { get: () => { reads += 1; return names; } });
    expect(checkRelationships({ libraryModels, domains: [d] })).toEqual([]);
    expect(reads).toBeLessThanOrEqual(4);
  });
});

describe('checkRelationships — agrees with normaliseRelationships (#133 review 6)', () => {
  it('REL003 for a diagram\'s own record to a model it does not list, even when that model\'s file is unreadable', async () => {
    const { normaliseRelationships } = await import('../../src/normaliseRelationships');
    const a: SemanticModel = { name: 'A', columns: [col('id', { isPrimaryKey: true }), col('u_id')] };
    const record: Relationship = { fromModel: 'A', fromColumn: 'u_id', toModel: 'U', toColumn: 'id', cardinality: 'many-to-one' };
    const drawn = normaliseRelationships({ models: [a], own: [record] });
    expect(drawn.relationships[0].issues).toEqual(['REL003']);

    for (const mode of ['library', 'domain'] as const) {
      const findings = checkRelationships({
        libraryModels: [entry(a)],
        domains: [domain({ label: 'silver/d', filePath: 'silver/d.json', models: ['A'], relationships: [record], mode })],
        unreadableModels: [{ name: 'U', file: 'logical-models/U.yml', line: 3 }],
      });
      expect(summary(findings)).toEqual(['REL003:error']);
      expect(findings[0].message).toContain('points at model U, which is not one of this diagram\'s models');
    }
  });

  it('still says nothing about an unreadable endpoint the diagram does list', () => {
    const a: SemanticModel = { name: 'A', columns: [col('id', { isPrimaryKey: true }), col('u_id')] };
    const record: Relationship = { fromModel: 'A', fromColumn: 'u_id', toModel: 'U', toColumn: 'id', cardinality: 'many-to-one' };
    expect(checkRelationships({
      libraryModels: [entry(a)],
      domains: [domain({ models: ['A', 'U'], relationships: [record] })],
      unreadableModels: [{ name: 'U', file: 'logical-models/U.yml' }],
    })).toEqual([]);
  });

  it('REL006 for two models whose names differ only in case, as for any two models', () => {
    const dd: SemanticModel = { name: 'Dd', columns: [col('id', { isPrimaryKey: true })] };
    const DD: SemanticModel = { name: 'DD', columns: [col('k', { isPrimaryKey: true }), col('id', { isForeignKey: true })] };
    const backwards: Relationship = { fromModel: 'Dd', fromColumn: 'id', toModel: 'DD', toColumn: 'id', cardinality: 'many-to-one' };
    const findings = checkRelationships({
      libraryModels: [entry(dd), entry(DD)],
      domains: [domain({ models: ['Dd', 'DD'], relationships: [backwards], mode: 'domain' })],
    });
    expect(summary(findings)).toEqual(['REL006:info']);
  });

  it('REL001: copies that differ only in role say so, each in the named direction', () => {
    const fct = fctOrder([{ ...TO_CUSTOMER, role: 'buyer' }]);
    const reversed = rel('customer_key', 'fct_order', 'customer_key', { cardinality: 'one-to-many' });
    const findings = checkRelationships({ libraryModels: [entry(fct), entry(dimCustomer([reversed]))], domains: [] });
    const dup = findings.find((f) => f.code === 'REL001')!;
    expect(dup.severity).toBe('error');
    expect(dup.message).toBe(
      'Relationship fct_order.customer_key → dim_customer.customer_key is stored 2 times and the copies disagree on role ' +
      '(many-to-one "buyer" in logical-models/fct_order.yml; many-to-one in logical-models/dim_customer.yml)',
    );
    expect(dup.message).not.toContain('one-to-many');
  });

  it('REL001: a one-to-one stored both ways names each copy\'s own ends and says the direction differs', () => {
    const findings = checkRelationships({
      libraryModels: [entry(fctOrder()), entry(dimCustomer())],
      domains: [domain({ relationships: [own({ cardinality: 'one-to-one' }), {
        fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-one',
      }] })],
    });
    const dup = findings.find((f) => f.code === 'REL001')!;
    expect(dup.message).toContain('disagree on direction');
    expect(dup.message).toContain('one-to-one dim_customer.customer_key → fct_order.customer_key in');
  });
});
