import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  removeColumnRelationships,
  sharedRelationshipCount,
  renameColumnInRelationships,
  renameModelInRelationships,
  routeToLibrary,
  sameColumnPair,
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

describe('sharedRelationshipCount — what the offer to move is about', () => {
  it('counts a relationship whose two models sit together in more than one diagram, drawn there or not', () => {
    expect(sharedRelationshipCount([
      { models: ['fct_order', 'dim_customer'], relationships: [REL] },
      { models: ['fct_order', 'dim_customer', 'dim_date'], relationships: [] },
    ])).toBe(1);
  });
  it('is zero when every relationship lives in one diagram only', () => {
    expect(sharedRelationshipCount([
      { models: ['fct_order', 'dim_customer'], relationships: [REL] },
      { models: ['fct_order', 'dim_date'], relationships: [] },
    ])).toBe(0);
  });
});

describe('stored on the many side (#133)', () => {
  const REVERSED: Relationship = {
    fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many',
  };
  const dim = (relationships?: SemanticModel['relationships']): SemanticModel =>
    ({ name: 'dim_customer', columns: [], ...(relationships ? { relationships: structuredClone(relationships) } : {}) });

  it('sameColumnPair: the same two columns either way round are one link', () => {
    expect(sameColumnPair(REL, REL)).toBe(true);
    expect(sameColumnPair(REL, REVERSED)).toBe(true);
    expect(sameColumnPair(REL, { ...REL, fromColumn: 'other_key' })).toBe(false);
  });

  it('routeToLibrary stores a one-to-many on the fact, as many-to-one', () => {
    const fact = fct();
    const { kept, changed } = routeToLibrary([REVERSED], [], (name) => (name === 'fct_order' ? fact : dim()));
    expect(kept).toEqual([]);
    expect(changed.map((m) => m.name)).toEqual(['fct_order']);
    expect(fact.relationships).toEqual([STORED]);
  });

  it('routeToLibrary skips a link the other model already stores the other way round', () => {
    const fact = fct();
    const { changed } = routeToLibrary([REL], [], (name) => (name === 'fct_order' ? fact : dim([
      { fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' },
    ])));
    expect(changed).toEqual([]);
    expect(fact.relationships).toBeUndefined();
  });

  it('upsertLibraryRelationship writes and compares the role', () => {
    const fact = fct([STORED]);
    expect(upsertLibraryRelationship(fact, { ...REL, role: 'buyer' })).toBe(true);
    expect(fact.relationships).toEqual([{ ...STORED, role: 'buyer' }]);
    expect(upsertLibraryRelationship(fact, { ...REL, role: 'buyer' })).toBe(false);
  });
});
