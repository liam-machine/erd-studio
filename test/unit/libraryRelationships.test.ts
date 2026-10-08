import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  applyMoveToModel,
  describeLeftAlone,
  describeMovePlan,
  diagramsStillDrawing,
  planRelationshipWrite,
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
      { relationship: REL, cardinality: 'many-to-one', domains: ['silver/orders'] },
      { relationship: { ...REL, cardinality: 'one-to-one' }, cardinality: 'one-to-one', domains: ['silver/reporting'] },
    ]);
    expect(describeMovePlan(plan)).toContain(
      '• fct_order.customer_key → dim_customer.customer_key: fct_order.customer_key → dim_customer.customer_key many-to-one in silver/orders; '
      + 'fct_order.customer_key → dim_customer.customer_key one-to-one (fct_order holds the foreign key) in silver/reporting',
    );
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
    const settled = resolveConflict(plan, plan.conflicts[0], plan.conflicts[0].definitions[1]);
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
    expect(detail).toMatch(/Conflicts: 1 relationship is drawn differently.*Next you pick the version to keep/s);
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

  it('a conflict offers each definition as it would be stored, a one-to-many on its many side', () => {
    const plan = planMoveToLibrary(
      [{ label: 'a', relationships: [REVERSED] }, { label: 'b', relationships: [{ ...REL, cardinality: 'one-to-one' }] }],
      (name) => (name === 'fct_order' ? fct() : dim()),
    );
    expect(plan.conflicts[0].definitions.map((d) => d.relationship)).toEqual([REL, { ...REL, cardinality: 'one-to-one' }]);
    expect(resolveConflict(plan, plan.conflicts[0], plan.conflicts[0].definitions[0]).toLibrary).toEqual([REL]);
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

    const ORDER_KEY = { ...KEY, name: 'order_key' };
    it('when it leaves the dimension\'s whole key for a column that is not the fact\'s key', () => {
      expect(plan([{ ...KEY, isForeignKey: true }], [ORDER_KEY]).rehome).toEqual([
        { from: 'dim_customer', stored: { fromModel: 'dim_customer', ...backwards }, to: { ...REL, role: 'buyer' } },
      ]);
    });

    it('and leaves it alone without certain key evidence', () => {
      expect(plan([{ ...KEY, isPrimaryKey: false }]).rehome).toEqual([]);
      expect(plan([KEY, { ...KEY, name: 'valid_from' }]).rehome).toEqual([]);
      expect(plan([KEY], [{ ...KEY }]).rehome).toEqual([]);
    });

    it('and leaves it alone when the fact flags no key: no certainty the column is not its key (M)', () => {
      expect(plan([KEY], [{ ...KEY, isPrimaryKey: false }]).rehome).toEqual([]);
      expect(plan([KEY], [{ ...ORDER_KEY }, { ...ORDER_KEY, name: 'line_no' }]).rehome).toEqual([]);
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
      relationship: { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' },
      definitions: [
        { relationship: REL, cardinality: 'many-to-one', domains: ['gold/orders'] },
        { relationship: { ...REL, cardinality: 'one-to-one' }, cardinality: 'one-to-one', domains: ['gold/reporting'] },
      ],
    }]);
    const settled = resolveConflict(plan, plan.conflicts[0], plan.conflicts[0].definitions[1]);
    expect(settled.toLibrary).toEqual([{ ...REL, cardinality: 'one-to-one' }]);
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
    expect(resolveConflict(plan, plan.conflicts[0], plan.conflicts[0].definitions[1]).toLibrary).toEqual([{ ...REL, cardinality: 'one-to-one', role: 'buyer' }]);
  });

  it('a domain role is copied onto a library entry that has none before the domain copy goes', () => {
    const plan = planMoveToLibrary([{ label: 'a', relationships: [{ ...REL, role: 'buyer' }] }], (name) => (name === 'fct_order' ? fct([STORED]) : null));
    expect(plan.toLibrary).toEqual([{ ...REL, role: 'buyer' }]);
    expect(plan.removeFromDomains.get('a')?.size).toBe(1);
  });
});

describe('planRelationshipWrite — one canvas edit acts on the link (#133)', () => {
  const KEY = { name: 'customer_key', dataType: 'int', description: '', isPrimaryKey: true };
  const dim = (relationships?: SemanticModel['relationships'], keyed = true): SemanticModel =>
    ({ name: 'dim_customer', columns: [{ ...KEY, isPrimaryKey: keyed }], ...(relationships ? { relationships } : {}) });
  const fact = (relationships?: SemanticModel['relationships']): SemanticModel =>
    ({ name: 'fct_order', columns: [{ ...KEY, name: 'order_key' }, { ...KEY, isPrimaryKey: false }], ...(relationships ? { relationships } : {}) });
  const BACK = { fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'many-to-one' as const };
  const library = (models: SemanticModel[], domainRelationships: Relationship[] = []) => ({ home: 'library' as const, models, domainRelationships });

  it('folds every copy into one entry in its home, with the drawn copy\'s role, and changes none of its inputs', () => {
    const models = [dim([BACK]), fact([{ ...STORED, role: 'buyer' }])];
    const before = structuredClone(models);
    const plan = planRelationshipWrite({ kind: 'update', ends: REL, cardinality: 'one-to-one' }, library(models, [{ ...REL, role: 'other' }]));
    expect(plan).toEqual({
      ok: false, error: expect.stringMatching(/saved more than once with different roles/),
    });
    const ok = planRelationshipWrite({ kind: 'update', ends: REL, cardinality: 'one-to-one' }, library(models, [REL]));
    expect(ok).toMatchObject({ ok: true, domainRelationships: [] });
    expect(ok.ok && ok.changed.map((m) => [m.name, m.relationships])).toEqual([
      ['dim_customer', undefined], ['fct_order', [{ ...STORED, cardinality: 'one-to-one', role: 'buyer' }]],
    ]);
    expect(models).toEqual(before);
  });

  it('takes any copy\'s role when the line drawn has none', () => {
    const plan = planRelationshipWrite({ kind: 'update', ends: REL, cardinality: 'one-to-one' }, library([dim([{ ...BACK, role: 'buyer' }], false), fact([STORED])]));
    expect(plan.ok && plan.changed.find((m) => m.name === 'fct_order')?.relationships).toEqual([{ ...STORED, cardinality: 'one-to-one', role: 'buyer' }]);
  });

  it('an edit sets the role the dialog gives, dropping the others', () => {
    const plan = planRelationshipWrite(
      { kind: 'edit', original: REL, drawn: { ...REL, role: 'new' } },
      library([dim([{ ...BACK, role: 'r2' }]), fact([{ ...STORED, role: 'r1' }])]),
    );
    expect(plan.ok && plan.changed.map((m) => m.relationships)).toEqual([undefined, [{ ...STORED, role: 'new' }]]);
  });

  it('refuses a ⇄ that would make a whole key the many side (F3b), but not one the keys allow', () => {
    const swap = { kind: 'update' as const, ends: REL, cardinality: 'one-to-many' as const };
    expect(planRelationshipWrite(swap, library([dim(), fact([STORED])]))).toMatchObject({ ok: false, error: expect.stringContaining('Unmark it as a key first') });
    expect(planRelationshipWrite(swap, library([dim(undefined, false), fact([STORED])]))).toMatchObject({ ok: true });
  });

  it('in a per-diagram project, folds a diagram file\'s copies into the first, keeping its other keys', () => {
    const plan = planRelationshipWrite(
      { kind: 'update', ends: REL, cardinality: 'one-to-one' },
      { home: 'domain', models: [], domainRelationships: [{ ...REL, note: 'x' } as Relationship, { ...REL, role: 'buyer' }] },
    );
    expect(plan).toEqual({ ok: true, changed: [], domainRelationships: [{ ...REL, note: 'x', cardinality: 'one-to-one', role: 'buyer' }] });
  });

  it('refuses an add of a link already stored, either way round', () => {
    expect(planRelationshipWrite({ kind: 'add', drawn: { ...REL, fromModel: 'dim_customer', toModel: 'fct_order' } }, library([dim(), fact([STORED])])))
      .toEqual({ ok: false, error: 'This relationship already exists.' });
  });

  it('removes every copy, and says when there is none', () => {
    const plan = planRelationshipWrite({ kind: 'remove', keys: [REL] }, library([dim([BACK]), fact([STORED])], [REL]));
    expect(plan.ok && [plan.changed.map((m) => m.relationships), plan.domainRelationships]).toEqual([[undefined, undefined], []]);
    expect(planRelationshipWrite({ kind: 'remove', keys: [REL] }, library([dim(), fact()]))).toEqual({ ok: false, error: 'Relationship not found.' });
  });
});

describe('routeToLibrary never overwrites a stored link (F1)', () => {
  it('keeps the library entry\'s cardinality and role, whatever dbt says', () => {
    const library = fct([{ ...STORED, role: 'buyer' }]);
    const { changed } = routeToLibrary([{ ...REL, cardinality: 'one-to-one' }], [], (n) => (n === 'fct_order' ? library : null));
    expect(changed).toEqual([]);
    expect(library.relationships).toEqual([{ ...STORED, role: 'buyer' }]);
  });

  it('leaves a link another diagram draws from its own copy in this domain file', () => {
    const library = fct();
    const { kept, changed } = routeToLibrary([REL], [], (n) => (n === 'fct_order' ? library : null), [{ ...REL, cardinality: 'one-to-one' }]);
    expect([kept, changed]).toEqual([[REL], []]);
  });
});

describe('the move preview and its leftovers', () => {
  const KEY = { name: 'k', dataType: 'int', description: '', isPrimaryKey: true };
  it('lists every relationship it turns round, however many (D4)', () => {
    const names = Array.from({ length: 7 }, (_, i) => `fct_${i}`);
    const library = [
      { name: 'dim', columns: [KEY], relationships: names.map((n) => ({ fromColumn: 'k', toModel: n, toColumn: 'k', cardinality: 'one-to-many' as const })) },
      ...names.map((n) => ({ name: n, columns: [] })),
    ];
    const plan = planMoveToLibrary([], (n) => library.find((m) => m.name === n) ?? null, library);
    const detail = describeMovePlan(plan);
    expect(plan.rehome).toHaveLength(7);
    for (const n of names) expect(detail).toContain(`• dim.k → ${n}.k → logical-models/${n}.yml`);
    expect(detail).not.toContain('more');
  });

  it('lists a diagram copy that disagrees with the library, naming both versions (D2)', () => {
    const plan = planMoveToLibrary(
      [{ label: 'silver/orders', relationships: [{ ...REL, cardinality: 'one-to-one' }] }],
      (n) => (n === 'fct_order' ? fct([STORED]) : null),
    );
    expect(plan.removeFromDomains.get('silver/orders')?.size).toBe(1);
    expect(describeMovePlan(plan)).toContain(
      "Kept the model library's version: 1 diagram copy says something different",
    );
    expect(describeMovePlan(plan)).toContain(
      '• silver/orders: fct_order.customer_key → dim_customer.customer_key one-to-one — the library has fct_order.customer_key → dim_customer.customer_key many-to-one in logical-models/fct_order.yml',
    );
  });

  it('applies a turned-round entry by itself, and gives a role only to the copy that says the same', () => {
    const model = fct([{ ...STORED, cardinality: 'one-to-one' }, STORED]);
    applyMoveToModel({ toLibrary: [{ ...REL, role: 'buyer' }], rehome: [] }, model);
    expect(model.relationships).toEqual([{ ...STORED, cardinality: 'one-to-one' }, { ...STORED, role: 'buyer' }]);
  });

  it('names the other diagrams that still draw a deleted link from their own copy (D3)', () => {
    expect(diagramsStillDrawing([REL], [
      { label: 'gold/a', models: ['fct_order', 'dim_customer'], relationships: [REL] },
      { label: 'gold/b', models: ['fct_order'], relationships: [REL] },
      { label: 'gold/c', models: ['fct_order', 'dim_customer'], relationships: [] },
    ])).toEqual(['gold/a']);
  });
});
