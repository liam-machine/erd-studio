import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  describeLeftAlone,
  describeMovePlan,
  planMoveToLibrary,
  planRehome,
  removeColumnRelationships,
  removeLibraryRelationships,
  resolveConflict,
  sharedRelationshipCount,
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
  it('counts a model file that holds relationships but does not parse, so a broken file cannot switch it off', () => {
    expect(usesLibraryRelationships([fct()], 3, true)).toBe(true);
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

describe('settling a conflict (#126)', () => {
  const lookup = (name: string): SemanticModel | null => (name === 'fct_order' ? fct() : null);
  const conflicted = () => planMoveToLibrary(
    [{ label: 'gold/orders', relationships: [REL] }, { label: 'gold/reporting', relationships: [{ ...REL, cardinality: 'one-to-one' }] }],
    lookup,
  );

  it('moves the picked cardinality to the library and takes every diagram\'s copy out', () => {
    const plan = conflicted();
    const settled = resolveConflict(plan, plan.conflicts[0], 'one-to-one');
    expect(settled.conflicts).toEqual([]);
    expect(settled.toLibrary).toEqual([{ ...REL, cardinality: 'one-to-one' }]);
    expect([...settled.removeFromDomains.keys()].sort()).toEqual(['gold/orders', 'gold/reporting']);
    expect(plan.conflicts).toHaveLength(1); // the original plan is untouched
  });

  it('explains why, where each relationship goes, and that conflicts are picked next', () => {
    const plan = planMoveToLibrary(
      [
        { label: 'gold/orders', relationships: [REL, { ...REL, fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key' }] },
        { label: 'gold/reporting', relationships: [{ ...REL, cardinality: 'one-to-one' }] },
      ],
      lookup,
    );
    const detail = describeMovePlan(plan, (m) => `logical-models/gold/${m}.yml`);
    expect(detail).toMatch(/^Why: today each diagram keeps its own copy/);
    expect(detail).toContain('• logical-models/gold/fct_order.yml — fct_order.order_date_key → dim_date.date_key');
    expect(detail).toMatch(/Conflicts: 1 relationship is drawn differently.*Next you pick the cardinality to keep/s);
  });

  it('says where a conflicting relationship will go, even when it is the only one', () => {
    const plan = conflicted();
    const detail = describeMovePlan(plan, (m) => `logical-models/${m}.yml`);
    expect(detail).toContain('• logical-models/fct_order.yml — fct_order.customer_key → dim_customer.customer_key');
    expect(detail).toContain('(2 diagrams)');
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

  it('planMoveToLibrary sends a one-to-many from a domain file to the fact', () => {
    const plan = planMoveToLibrary([{ label: 'silver/orders', relationships: [REVERSED] }], (name) => (name === 'fct_order' ? fct() : dim()));
    expect(plan.toLibrary).toEqual([REL]);
    expect(plan.removeFromDomains.get('silver/orders')?.size).toBe(1);
  });

  it('a conflict settled as one-to-many goes to the other end', () => {
    const plan = planMoveToLibrary(
      [{ label: 'a', relationships: [REL] }, { label: 'b', relationships: [{ ...REL, cardinality: 'one-to-one' }] }],
      (name) => (name === 'fct_order' ? fct() : dim()),
    );
    const settled = resolveConflict(plan, plan.conflicts[0], 'one-to-many');
    expect(settled.toLibrary).toEqual([{ ...REVERSED, cardinality: 'many-to-one' }]);
  });

  it('planRehome finds library entries stored on their one side, and only those', () => {
    const stored = { fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' as const };
    const library = [dim([stored, { ...stored, toModel: 'stg_gone' }]), fct([STORED])];
    const { rehome } = planRehome(library, (name) => library.find((m) => m.name === name) ?? null);
    expect(rehome).toEqual([{ from: 'dim_customer', stored: REVERSED, to: REL }]);
    expect(describeMovePlan({ toLibrary: [], removeFromDomains: new Map(), conflicts: [], skippedNoModel: [], rehome, disagreements: [], lockedFiles: [] }))
      .toMatch(/^Turned round: 1 relationship is stored in the file of the model it points at/);
  });

  it('removing a link drops every copy, in both model files, whichever end the line was drawn from', () => {
    const fact = fct([STORED]);
    const dimension = dim([{ fromColumn: 'CUSTOMER_KEY', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'many-to-one' }]);
    expect(removeLibraryRelationships([fact, dimension], [REVERSED])).toEqual([fact, dimension]);
    expect([fact.relationships, dimension.relationships]).toEqual([undefined, undefined]);
  });

  describe('planRehome turns round a many-to-one 1.6.7 saved backwards on a dimension', () => {
    const KEY = { name: 'customer_key', dataType: 'int', description: '', isPrimaryKey: true };
    const backwards = { fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'many-to-one' as const, role: 'buyer' };
    const plan = (dimColumns: SemanticModel['columns'], fctColumns: SemanticModel['columns'] = []) => {
      const library = [{ ...dim([backwards]), columns: dimColumns }, { ...fct(), columns: fctColumns }];
      return planRehome(library, (name) => library.find((m) => m.name === name) ?? null);
    };

    it('when it leaves the dimension\'s whole key for a column that is not the fact\'s key', () => {
      expect(plan([{ ...KEY, isForeignKey: true }]).rehome).toEqual([
        { from: 'dim_customer', stored: { fromModel: 'dim_customer', ...backwards }, to: { ...REL, role: 'buyer' } },
      ]);
    });

    it('and leaves it alone without certain key evidence', () => {
      expect(plan([{ ...KEY, isPrimaryKey: false }]).rehome).toEqual([]);
      expect(plan([KEY, { ...KEY, name: 'valid_from' }]).rehome).toEqual([]);
      expect(plan([KEY], [{ ...KEY }]).rehome).toEqual([]);
    });
  });

  it('planRehome leaves both copies of a link that disagree, and lists them', () => {
    const library = [
      dim([{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' }]),
      fct([{ ...STORED, cardinality: 'one-to-one' }]),
    ];
    const plan = planRehome(library, (name) => library.find((m) => m.name === name) ?? null);
    expect(plan).toEqual({
      rehome: [], lockedFiles: [],
      disagreements: [{ stored: REVERSED, held: { ...REL, cardinality: 'one-to-one' } }],
    });
    expect(describeLeftAlone(plan).join('\n')).toContain(
      '• dim_customer.customer_key → fct_order.customer_key one-to-many in logical-models/dim_customer.yml, '
      + 'but fct_order.customer_key → dim_customer.customer_key one-to-one in logical-models/fct_order.yml',
    );
  });

  it('the move leaves a locked file alone, and what was bound for it where it is', () => {
    const library = [dim([{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' }]), fct()];
    const lookup = (name: string) => library.find((m) => m.name === name) ?? null;
    const plan = planMoveToLibrary([{ label: 'a', relationships: [{ ...REL, toColumn: 'other_key' }] }], lookup, library, (m) => m === 'fct_order');
    expect([plan.rehome, plan.toLibrary, plan.removeFromDomains.size, plan.lockedFiles]).toEqual([[], [], 0, ['fct_order']]);
  });

  it('the same link drawn both ways round in two diagrams, disagreeing, is one conflict and nothing is dropped', () => {
    const plan = planMoveToLibrary(
      [{ label: 'gold/orders', relationships: [REVERSED] }, { label: 'gold/reporting', relationships: [{ ...REL, cardinality: 'one-to-one' }] }],
      (name) => (name === 'fct_order' ? fct() : dim()),
    );
    expect([plan.toLibrary, plan.removeFromDomains.size]).toEqual([[], 0]);
    expect(plan.conflicts).toEqual([{
      relationship: { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key' },
      definitions: [{ cardinality: 'one-to-many', domains: ['gold/orders'] }, { cardinality: 'one-to-one', domains: ['gold/reporting'] }],
    }]);
    const settled = resolveConflict(plan, plan.conflicts[0], 'one-to-one');
    expect(settled.toLibrary).toEqual([{ ...REVERSED, cardinality: 'one-to-one' }]);
    expect([...settled.removeFromDomains.keys()]).toEqual(['gold/orders', 'gold/reporting']);
  });

  it('the same link drawn both ways round in two diagrams, agreeing, merges into one many-to-one on the fact', () => {
    const plan = planMoveToLibrary(
      [{ label: 'gold/orders', relationships: [REVERSED] }, { label: 'gold/reporting', relationships: [REL] }],
      (name) => (name === 'fct_order' ? fct() : dim()),
    );
    expect([plan.toLibrary, plan.conflicts, [...plan.removeFromDomains.keys()]]).toEqual([[REL], [], ['gold/orders', 'gold/reporting']]);
  });

  it('upsertLibraryRelationship writes and compares the role', () => {
    const fact = fct([STORED]);
    expect(upsertLibraryRelationship(fact, { ...REL, role: 'buyer' })).toBe(true);
    expect(fact.relationships).toEqual([{ ...STORED, role: 'buyer' }]);
    expect(upsertLibraryRelationship(fact, { ...REL, role: 'buyer' })).toBe(false);
  });
});

describe('the move keeps roles (#133)', () => {
  it('a conflict settled by the user keeps the role a domain gave it', () => {
    const plan = planMoveToLibrary(
      [{ label: 'a', relationships: [{ ...REL, role: 'buyer' }] }, { label: 'b', relationships: [{ ...REL, cardinality: 'one-to-one' }] }],
      (name) => (name === 'fct_order' ? fct() : null),
    );
    expect(resolveConflict(plan, plan.conflicts[0], 'one-to-one').toLibrary).toEqual([{ ...REL, cardinality: 'one-to-one', role: 'buyer' }]);
  });

  it('a domain role is copied onto a library entry that has none before the domain copy goes', () => {
    const plan = planMoveToLibrary([{ label: 'a', relationships: [{ ...REL, role: 'buyer' }] }], (name) => (name === 'fct_order' ? fct([STORED]) : null));
    expect(plan.toLibrary).toEqual([{ ...REL, role: 'buyer' }]);
    expect(plan.removeFromDomains.get('a')?.size).toBe(1);
  });
});
