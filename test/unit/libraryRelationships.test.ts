import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  describeMovePlan,
  planMoveToLibrary,
  removeColumnRelationships,
  renameColumnInRelationships,
  renameModelInRelationships,
  routeToLibrary,
  upsertLibraryRelationship,
  usesLibraryRelationships,
} from '../../src/services/libraryRelationships';
import { LogicalModelService } from '../../src/services/logicalModelService';
import type { Relationship, SemanticModel } from '../../src/types/semantic';

const REL: Relationship = {
  fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one',
};
const fct = (relationships?: SemanticModel['relationships']): SemanticModel =>
  ({ name: 'fct_order', columns: [], ...(relationships ? { relationships: structuredClone(relationships) } : {}) });
const { fromModel: _from, ...STORED } = REL;

describe('usesLibraryRelationships — opt-in per project, the default for a new one', () => {
  it('is on when no domain file holds a relationship', () => {
    expect(usesLibraryRelationships([fct()], 0)).toBe(true);
  });
  it('is off while domain files hold relationships and the library none', () => {
    expect(usesLibraryRelationships([fct()], 3)).toBe(false);
  });
  it('is on once the library holds one, whatever the domain files hold', () => {
    expect(usesLibraryRelationships([fct([STORED])], 3)).toBe(true);
  });
});

describe('library relationship edits', () => {
  it('upserts by endpoints and reports a no-op', () => {
    const model = fct();
    expect(upsertLibraryRelationship(model, REL)).toBe(true);
    expect(upsertLibraryRelationship(model, REL)).toBe(false);
    expect(upsertLibraryRelationship(model, { ...REL, cardinality: 'one-to-one' })).toBe(true);
    expect(model.relationships).toEqual([{ ...STORED, cardinality: 'one-to-one' }]);
  });

  it('drops relationships to and from a removed column, and the key when none are left', () => {
    const model = fct([STORED]);
    expect(removeColumnRelationships([model], 'dim_customer', 'customer_key')).toEqual([model]);
    expect(model).not.toHaveProperty('relationships');
  });

  it('follows column and model renames in other models', () => {
    const model = fct([STORED]);
    renameColumnInRelationships([model], 'dim_customer', 'customer_key', 'customer_sk');
    renameModelInRelationships([model], 'dim_customer', 'dim_client');
    expect(model.relationships).toEqual([{ ...STORED, toModel: 'dim_client', toColumn: 'customer_sk' }]);
  });

  it('routes added relationships to their from-models, keeping those without a file', () => {
    const orphan: Relationship = { ...REL, fromModel: 'stg_missing' };
    const library = fct();
    const { kept, changed } = routeToLibrary([REL, orphan], [], (name) => (name === 'fct_order' ? library : null));
    expect(kept).toEqual([orphan]);
    expect(changed).toEqual([library]);
    expect(library.relationships).toEqual([STORED]);
  });
});

describe('planMoveToLibrary', () => {
  const lookup = (name: string): SemanticModel | null => (name === 'fct_order' ? fct() : null);

  it('moves a relationship the domains agree on once, out of every domain holding it', () => {
    const plan = planMoveToLibrary(
      [{ label: 'silver/orders', relationships: [REL] }, { label: 'silver/reporting', relationships: [REL] }],
      lookup,
    );
    expect(plan.toLibrary).toEqual([REL]);
    expect([...plan.removeFromDomains.keys()]).toEqual(['silver/orders', 'silver/reporting']);
    expect(plan.conflicts).toEqual([]);
  });

  it('never settles a disagreement — it is reported and left in place', () => {
    const plan = planMoveToLibrary(
      [{ label: 'silver/orders', relationships: [REL] }, { label: 'silver/reporting', relationships: [{ ...REL, cardinality: 'one-to-one' }] }],
      lookup,
    );
    expect(plan.toLibrary).toEqual([]);
    expect(plan.removeFromDomains.size).toBe(0);
    expect(plan.conflicts[0].definitions).toEqual([
      { cardinality: 'many-to-one', domains: ['silver/orders'] },
      { cardinality: 'one-to-one', domains: ['silver/reporting'] },
    ]);
    expect(describeMovePlan(plan)).toMatch(/fct_order\.customer_key → dim_customer\.customer_key: many-to-one in silver\/orders; one-to-one in silver\/reporting/);
  });

  it('leaves a relationship whose from-model has no library file', () => {
    const plan = planMoveToLibrary([{ label: 'silver/orders', relationships: [{ ...REL, fromModel: 'stg_x' }] }], lookup);
    expect(plan.skippedNoModel).toHaveLength(1);
    expect(plan.removeFromDomains.size).toBe(0);
  });
});

describe('LogicalModelService writes relationships', () => {
  it('round-trips the list and leaves an unchanged one (and its comment) alone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-rels-yml-'));
    try {
      const service = new LogicalModelService(root, '.erd-studio');
      service.saveModel(fct([STORED]));
      const file = service.modelPath('fct_order');
      const text = fs.readFileSync(file, 'utf-8').replace('relationships:', 'relationships: # shared across domains');
      fs.writeFileSync(file, text);
      service.invalidateCache();
      const model = service.getModel('fct_order')!;
      expect(model.relationships).toEqual([STORED]);
      service.saveModel({ ...model, description: 'Orders' });
      expect(fs.readFileSync(file, 'utf-8')).toContain('# shared across domains');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
