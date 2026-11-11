/**
 * Suggest Relationships' review, as data (`relationshipSuggestionReview.ts`):
 * the sections and their order, what is ticked (strong only), the cap on a
 * large diagram, the row words, the direction question (the New Relationship
 * dialog's own words), the recompute's filter and the ops handed to the one
 * write planner.
 */
import { describe, expect, it } from 'vitest';
import type { SemanticTable } from '../../src/types/semantic';
import {
  REVIEW_PAGE,
  SKIP_THIS_ONE,
  addedMessage,
  anyDeclaredKeys,
  buildSuggestionReview,
  computeSuggestions,
  directionQuestion,
  importOfferMessage,
  offerAfterImport,
  offerCount,
  reviewRow,
  stillValid,
  suggestionWriteOps,
} from '../../src/services/relationshipSuggestionReview';
import type { RelationshipSuggestion } from '../../src/services/relationshipSuggestions';
import { directionChoice, DIRECTION_QUESTION } from '../../webview/lib/relationshipDialog';
import { planRelationshipWrites } from '../../src/services/libraryRelationships';
import { largeModel } from './relationshipSuggestions.samples';

const t = (name: string, cols: Array<[string, string, ('pk' | 'nk')?]>): SemanticTable => ({
  name,
  columns: cols.map(([n, d, k]) => ({ name: n, dataType: d, ...(k === 'pk' ? { isPrimaryKey: true } : k === 'nk' ? { isNaturalKey: true } : {}) })),
}) as SemanticTable;

const s = (over: Partial<RelationshipSuggestion> & Pick<RelationshipSuggestion, 'id' | 'band'>): RelationshipSuggestion => ({
  fromModel: 'fct', toModel: 'dim', pairs: [{ fromColumn: 'dim_id', toColumn: 'dim_id' }], cardinality: 'many-to-one',
  direction: 'decided', directionBasis: 'keys', rules: ['key-name'], keyInferred: false, reasons: ['dim_id is the primary key of dim'], ...over,
});

/** A keyed star: strong rows, a role-playing likely one, a composite and an undecided one-to-one. */
function keyedStar(): SemanticTable[] {
  return [
    t('dim_customer', [['customer_id', 'int', 'pk'], ['name', 'varchar']]),
    t('dim_date', [['date_key', 'int', 'pk'], ['day', 'date']]),
    t('dim_region', [['region_code', 'varchar', 'pk'], ['country_code', 'varchar', 'pk']]),
    t('fct_sale', [['sale_id', 'int', 'pk'], ['customer_id', 'int'], ['ship_date_key', 'int'], ['region_code', 'varchar'], ['country_code', 'varchar']]),
    t('vehicle', [['vin', 'varchar', 'pk'], ['make', 'varchar']]),
    t('registration', [['vin', 'varchar', 'pk'], ['plate', 'varchar']]),
  ];
}

describe('computeSuggestions: the engine, plus dbt\'s tests when there are any', () => {
  it('gives the engine\'s suggestions, and never one the diagram already draws', () => {
    const tables = keyedStar();
    const all = computeSuggestions({ tables, relationships: [] });
    expect(all.map((x) => `${x.band}:${x.direction}:${x.fromModel}>${x.toModel}`)).toEqual([
      'strong:decided:fct_sale>dim_customer',
      'likely:decided:fct_sale>dim_date',
      'possible:decided:fct_sale>dim_region',
      'possible:undecided:registration>vehicle',
    ]);
    const drawn = computeSuggestions({ tables, relationships: [{ fromModel: 'dim_customer', fromColumn: 'customer_id', toModel: 'fct_sale', toColumn: 'customer_id', cardinality: 'one-to-many' }] });
    expect(drawn.some((x) => x.toModel === 'dim_customer')).toBe(false);
  });

  it('a dbt relationships test is strong, and its reason says so', () => {
    const tables = [t('orders', [['order_id', 'int'], ['buyer', 'int']]), t('people', [['person_id', 'int'], ['name', 'varchar']])];
    expect(computeSuggestions({ tables, relationships: [] }).some((x) => x.toModel === 'people' && x.pairs[0].fromColumn === 'buyer')).toBe(false);
    const withTests = computeSuggestions({ tables, relationships: [], dbtTests: [{ fromModel: 'orders', fromColumn: 'buyer', toModel: 'people', toColumn: 'person_id' }] });
    const fromTest = withTests.find((x) => x.pairs[0].fromColumn === 'buyer')!;
    expect(fromTest).toMatchObject({ band: 'strong', direction: 'decided', rules: ['dbt-test'] });
    expect(fromTest.reasons[0]).toBe('a dbt relationships test checks orders.buyer against people.person_id');
  });
});

describe('buildSuggestionReview: sections, ticks and words', () => {
  const options = { diagramName: 'sales', dbt: false, anyKeys: true };

  it('Strong, Likely, Possible, Direction unknown, in that order; only strong rows are ticked', () => {
    const review = buildSuggestionReview(computeSuggestions({ tables: keyedStar(), relationships: [] }), options);
    expect(review.title).toBe('Suggested relationships for sales');
    expect(review.sections.map((x) => x.label)).toEqual([
      'Strong: a declared key backs these',
      'Likely: the names match',
      'Possible: a weak match',
      "Direction unknown: you'll be asked",
    ]);
    const rows = review.sections.flatMap((x) => x.rows);
    expect(rows.filter((r) => r.picked).map((r) => r.label)).toEqual(['fct_sale.customer_id → dim_customer.customer_id']);
    expect(review.placeholder).toBe('Only strong ones are ticked: untick any that are wrong, then press OK.');
    expect(review).toMatchObject({ shown: 4, total: 4, hidden: 0 });
    expect(review.moreLabel).toBeUndefined();
  });

  it('a row: the ends (a composite\'s columns joined), the cardinality, the engine\'s reasons', () => {
    const rows = buildSuggestionReview(computeSuggestions({ tables: keyedStar(), relationships: [] }), options).sections.flatMap((x) => x.rows);
    const composite = rows.find((r) => r.label.startsWith('fct_sale.region_code'))!;
    expect(composite.label).toBe('fct_sale.region_code, country_code → dim_region.region_code, country_code');
    expect(composite.description).toBe('Many-to-one');
    expect(composite.detail).toBe('(region_code, country_code) is the composite primary key of dim_region, and fct_sale has all 2 columns');
    const oneToOne = rows.find((r) => r.group === 'direction')!;
    expect(oneToOne.description).toBe('One-to-one');
    expect(oneToOne.detail).toContain('nothing says which way it points');
  });

  it('no strong row: nothing is ticked, and the placeholder says why in one line', () => {
    const keyless = [t('customers', [['customer_id', 'int'], ['name', 'varchar']]), t('orders', [['order_id', 'int'], ['customer_id', 'int']])];
    const review = buildSuggestionReview(computeSuggestions({ tables: keyless, relationships: [] }), { ...options, anyKeys: anyDeclaredKeys(keyless) });
    expect(review.sections.flatMap((x) => x.rows).some((r) => r.picked)).toBe(false);
    expect(review.placeholder).toBe('Nothing is ticked: no table here has a primary key, so check each one.');
    const keyedButWeak = buildSuggestionReview([s({ id: 'a', band: 'likely' })], { ...options, anyKeys: true });
    expect(keyedButWeak.placeholder).toBe('Nothing is ticked: none is certain enough, so check each one.');
    expect(buildSuggestionReview([s({ id: 'a', band: 'likely' })], { ...options, anyKeys: true, dbt: true }).placeholder).toBe(keyedButWeak.placeholder);
  });

  it('dbt is named only in a dbt project', () => {
    const strongOne = [s({ id: 'a', band: 'strong' })];
    expect(buildSuggestionReview(strongOne, options).sections[0].label).not.toMatch(/dbt/);
    expect(buildSuggestionReview(strongOne, { ...options, dbt: true }).sections[0].label).toBe('Strong: a key or a dbt test backs these');
    for (const text of [
      ...buildSuggestionReview(computeSuggestions({ tables: keyedStar(), relationships: [] }), options).sections.map((x) => x.label),
      buildSuggestionReview([s({ id: 'a', band: 'likely' })], options).placeholder,
    ]) expect(text).not.toMatch(/\bdbt\b|band|confidence|score/i);
  });

  it('a large diagram: every strong row, then a page of the rest; More lists the next page', () => {
    const many = [
      ...Array.from({ length: 3 }, (_, i) => s({ id: `s${i}`, band: 'strong' })),
      ...Array.from({ length: 700 }, (_, i) => s({ id: `l${i}`, band: 'likely' })),
      ...Array.from({ length: 900 }, (_, i) => s({ id: `p${i}`, band: 'possible' })),
    ];
    const first = buildSuggestionReview(many, options);
    expect(first.sections.map((x) => [x.group, x.rows.length])).toEqual([['strong', 3], ['likely', REVIEW_PAGE]]);
    expect(first).toMatchObject({ shown: 503, total: 1603, hidden: 1100 });
    expect(first.title).toBe('Suggested relationships for sales (503 of 1,603 listed)');
    expect(first.moreLabel).toBe('List 500 more (1,100 not listed yet)');
    const second = buildSuggestionReview(many, { ...options, limit: 2 * REVIEW_PAGE });
    expect(second.sections.map((x) => [x.group, x.rows.length])).toEqual([['strong', 3], ['likely', 700], ['possible', 300]]);
    expect(second.moreLabel).toBe('List 500 more (600 not listed yet)');
    const all = buildSuggestionReview(many, { ...options, limit: 4 * REVIEW_PAGE });
    expect(all.hidden).toBe(0);
    expect(all.title).toBe('Suggested relationships for sales');
  });

  it('stays responsive on 2,000 tables × 40 columns: the engine and the first page well under a few seconds', () => {
    const tables = largeModel(2000, 40);
    const t0 = performance.now();
    const suggestions = computeSuggestions({ tables, relationships: [] });
    const t1 = performance.now();
    const review = buildSuggestionReview(suggestions, { ...options, anyKeys: anyDeclaredKeys(tables) });
    const t2 = performance.now();
    expect(suggestions.length).toBeGreaterThan(10_000);
    // No keys declared: nothing strong, so the first page is REVIEW_PAGE rows, whatever the total.
    expect(review.shown).toBe(REVIEW_PAGE);
    expect(review.sections.flatMap((x) => x.rows).some((r) => r.picked)).toBe(false);
    expect(t1 - t0).toBeLessThan(5000);
    expect(t2 - t1).toBeLessThan(500);
    if (process.env.SUGGEST_REPORT_DIR) {
      console.log(`2,000×40: ${suggestions.length} suggestions in ${(t1 - t0).toFixed(0)} ms; first page of ${review.shown} rows built in ${(t2 - t1).toFixed(1)} ms`);
    }
  }, 30_000);
});

describe('the direction question: the New Relationship dialog\'s words, then Skip', () => {
  it('both ways by directionChoice, under "Which way does this relationship point?"', () => {
    const undecided = computeSuggestions({ tables: keyedStar(), relationships: [] }).find((x) => x.direction === 'undecided')!;
    const q = directionQuestion(undecided, 1, 2);
    expect(q.title).toBe(`${DIRECTION_QUESTION} (1 of 2)`);
    expect(directionQuestion(undecided, 1, 1).title).toBe(DIRECTION_QUESTION);
    const a = directionChoice({ model: 'registration', columns: ['vin'] }, { model: 'vehicle', columns: ['vin'] }, 'one-to-one');
    const b = directionChoice({ model: 'vehicle', columns: ['vin'] }, { model: 'registration', columns: ['vin'] }, 'one-to-one');
    expect(q.items).toEqual([
      { label: a.text, detail: a.detail, answer: 'asIs' },
      { label: b.text, detail: b.detail, answer: 'reversed' },
      { label: SKIP_THIS_ONE, answer: 'skip' },
    ]);
    expect(q.items[0].label).toBe("registration holds vehicle's key");
    expect(q.placeholder).toBe('registration.vin and vehicle.vin: nothing in the tables says which way it points. Pick one, or skip it.');
  });
});

describe('writing: still valid, and the ops the planner takes', () => {
  it('stillValid drops what the engine no longer suggests, a decided one that turned round, and a single a ticked composite holds', () => {
    const a = s({ id: 'a', band: 'strong' });
    const b = s({ id: 'b', band: 'likely' });
    const turned = s({ id: 'c', band: 'likely', fromModel: 'dim', toModel: 'fct' });
    const composite = s({ id: 'x\u0001y', band: 'possible', pairs: [{ fromColumn: 'x', toColumn: 'x' }, { fromColumn: 'y', toColumn: 'y' }] });
    const single = s({ id: 'x', band: 'likely', pairs: [{ fromColumn: 'x', toColumn: 'x' }] });
    const und = s({ id: 'u', band: 'possible', direction: 'undecided' });
    const { keep, dropped } = stillValid(
      [{ suggestion: a }, { suggestion: b }, { suggestion: s({ id: 'c', band: 'likely' }) }, { suggestion: composite }, { suggestion: single }, { suggestion: und, reversed: true }],
      [a, turned, composite, single, { ...und, fromModel: 'dim', toModel: 'fct' }],
    );
    expect(keep.map((k) => k.suggestion.id)).toEqual(['a', 'x\u0001y', 'u']);
    expect(keep[2].reversed).toBe(true);
    expect(dropped).toBe(3);
  });

  it('suggestionWriteOps: add ops as the dialog sends them; a composite\'s other pairs as extraPairs; turned round on request; no key marked', () => {
    const suggestions = computeSuggestions({ tables: keyedStar(), relationships: [] });
    const ops = suggestionWriteOps(suggestions.map((suggestion) => ({ suggestion, ...(suggestion.direction === 'undecided' ? { reversed: true } : {}) })));
    expect(ops).toEqual([
      { kind: 'add', drawn: { fromModel: 'fct_sale', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id', cardinality: 'many-to-one' } },
      { kind: 'add', drawn: { fromModel: 'fct_sale', fromColumn: 'ship_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' } },
      {
        kind: 'add',
        drawn: { fromModel: 'fct_sale', fromColumn: 'region_code', toModel: 'dim_region', toColumn: 'region_code', cardinality: 'many-to-one' },
        extraPairs: [{ fromColumn: 'country_code', toColumn: 'country_code' }],
      },
      { kind: 'add', drawn: { fromModel: 'vehicle', fromColumn: 'vin', toModel: 'registration', toColumn: 'vin', cardinality: 'one-to-one' } },
    ]);
    // The one planner takes them all as one plan: one entry per pair, the composite's sharing one compositeKey.
    const tables = keyedStar();
    const { plan } = planRelationshipWrites(ops, { home: 'library', models: tables, domainRelationships: [] });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const fct = plan.changed.find((m) => m.name === 'fct_sale')!;
    expect(fct.relationships).toHaveLength(4);
    const keys = new Set(fct.relationships!.filter((r) => r.toModel === 'dim_region').map((r) => r.compositeKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBeTruthy();
    expect(plan.changed.find((m) => m.name === 'vehicle')!.relationships).toEqual([
      { toModel: 'registration', fromColumn: 'vin', toColumn: 'vin', cardinality: 'one-to-one' },
    ].map((r) => expect.objectContaining(r)));
    // Nothing marks a key.
    for (const m of plan.changed) {
      const before = tables.find((x) => x.name === m.name)!;
      expect(m.columns.map((c) => !!c.isPrimaryKey)).toEqual(before.columns.map((c) => !!c.isPrimaryKey));
    }
  });
});

describe('messages and the after-import offer', () => {
  it('says how many were added and that Undo takes them all back', () => {
    expect(addedMessage(1, 'sales', 0)).toBe('Added 1 relationship to sales. Edit > Undo takes it back.');
    expect(addedMessage(12, 'sales', 0)).toBe('Added 12 relationships to sales. Edit > Undo takes them all back.');
    expect(addedMessage(3, 'sales', 1)).toBe('Added 3 relationships to sales. Edit > Undo takes them all back. 1 you picked no longer applied and was left out.');
  });

  it('offers only on a diagram with no relationship, with at least one likely or stronger suggestion', () => {
    expect(offerAfterImport(0, [s({ id: 'a', band: 'likely' })])).toBe(true);
    expect(offerAfterImport(0, [s({ id: 'a', band: 'strong' })])).toBe(true);
    expect(offerAfterImport(2, [s({ id: 'a', band: 'strong' })])).toBe(false);
    expect(offerAfterImport(0, [s({ id: 'a', band: 'possible' })])).toBe(false);
    expect(offerAfterImport(0, [])).toBe(false);
    expect(importOfferMessage(14)).toBe('This diagram has no relationships yet. ERD Studio found 14 it can suggest.');
  });

  it('counts only the likely and stronger ones: a heap of possible or undirected ones neither makes the offer nor swells its number', () => {
    const mixed = [
      s({ id: 'a', band: 'strong' }),
      s({ id: 'b', band: 'likely' }),
      s({ id: 'c', band: 'likely', direction: 'undecided', directionBasis: 'none' }),
      ...Array.from({ length: 50 }, (_, i) => s({ id: `p${i}`, band: 'possible' })),
    ];
    expect(offerCount(mixed)).toBe(2);
    expect(offerAfterImport(0, mixed)).toBe(true);
    expect(importOfferMessage(offerCount(mixed))).toBe('This diagram has no relationships yet. ERD Studio found 2 it can suggest.');
    const weak = mixed.filter((x) => x.band === 'possible' || x.direction === 'undecided');
    expect(offerCount(weak)).toBe(0);
    expect(offerAfterImport(0, weak)).toBe(false);
  });

  it('a row\'s detail is the engine\'s reasons as written (a column name keeps its case)', () => {
    expect(reviewRow(s({ id: 'a', band: 'strong', reasons: ['order_id is the primary key of orders', 'both are int'] })).detail).toBe('order_id is the primary key of orders; both are int');
  });
});
