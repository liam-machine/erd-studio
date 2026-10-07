/**
 * The New / Edit Relationship dialog's words and decisions (#133), pure.
 */
import { describe, it, expect } from 'vitest';
import type { DirectionVerdict } from '@erd-studio/core';

import {
  canOfferMarkKey,
  cardinalityQuestion,
  contradictionWarning,
  directionChoices,
  directionKey,
  likelyReason,
  readBack,
  relationshipSentence,
  reversed,
  turnedRoundNote,
  WHY_HERE_LIBRARY,
} from '../../webview/lib/relationshipDialog';
import { directionFor } from '../../webview/lib/relationshipDirection';

const col = (name: string, keys: { pk?: boolean; nk?: boolean; fk?: boolean } = {}) => ({
  name, dataType: 'string', description: '',
  isPrimaryKey: keys.pk ?? false, isNaturalKey: keys.nk ?? false, isForeignKey: keys.fk ?? false,
  ...(keys.fk ? { isForeignKeyDeclared: true } : {}),
});
const MODELS = [
  { name: 'dim_customer', columns: [col('customer_key', { pk: true }), col('customer_code', { nk: true })] },
  { name: 'fct_daily', columns: [col('customer_key', { pk: true }), col('date_key', { pk: true }), col('amount')] },
  { name: 'fct_order', columns: [col('order_key', { pk: true }), col('customer_key')] },
  { name: 'a', columns: [col('x')] },
  { name: 'b', columns: [col('y')] },
  { name: 'acct', columns: [col('acct_id', { pk: true })] },
  { name: 'acct_ext', columns: [col('acct_id', { pk: true, fk: true })] },
];
const FACT_TO_DIM = { fromModel: 'fct_daily', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' };

describe('sentence, question and read-back', () => {
  it('reads as the spec words it', () => {
    expect(relationshipSentence(FACT_TO_DIM, 'many-to-one')).toBe('Each fct_daily points to one dim_customer');
    expect(cardinalityQuestion(FACT_TO_DIM)).toBe('How many fct_daily rows can share one dim_customer?');
    expect(readBack(FACT_TO_DIM, 'many-to-one', 'library')).toEqual({
      text: 'A dim_customer has many fct_daily.',
      savedIn: 'Saved in fct_daily.yml',
      why: WHY_HERE_LIBRARY,
    });
    expect(WHY_HERE_LIBRARY).toBe('Relationships live with the model holding the foreign key, so adding a fact never edits its dimensions.');
  });
  it('per-domain projects save in this diagram; an older host says nothing', () => {
    expect(readBack(FACT_TO_DIM, 'many-to-one', 'domain').savedIn).toBe('Saved in this diagram');
    expect(readBack(FACT_TO_DIM, 'many-to-one', undefined)).toEqual({ text: 'A dim_customer has many fct_daily.' });
  });
  it('one-to-one and many-to-many read back differently', () => {
    expect(readBack(FACT_TO_DIM, 'one-to-one', undefined).text).toBe('A dim_customer has at most one fct_daily.');
    expect(readBack(FACT_TO_DIM, 'many-to-many', undefined).text).toBe('A dim_customer can match many fct_daily too.');
    expect(relationshipSentence(FACT_TO_DIM, 'many-to-many')).toBe('Each fct_daily can match many dim_customer');
  });
});

describe('contradiction warning (certain evidence, soft)', () => {
  it('warns when the user points a whole key at a composite-key column', () => {
    const verdict = directionFor(MODELS, FACT_TO_DIM)!;
    expect(verdict.confidence).toBe('certain');
    expect(contradictionWarning(verdict, FACT_TO_DIM, MODELS)).toBeNull();
    expect(contradictionWarning(verdict, reversed(FACT_TO_DIM), MODELS))
      .toBe("dim_customer.customer_key is dim_customer's primary key, so dim_customer is normally the 'one' side.");
  });
  it('names a natural key as such', () => {
    const ends = { fromModel: 'fct_daily', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_code' };
    const verdict = directionFor(MODELS, ends)!;
    expect(contradictionWarning(verdict, reversed(ends), MODELS)).toContain("dim_customer's natural key");
  });
  it('a declared-FK one-to-one names the side that points', () => {
    const ends = { fromModel: 'acct_ext', fromColumn: 'acct_id', toModel: 'acct', toColumn: 'acct_id' };
    const verdict = directionFor(MODELS, ends)!;
    expect(verdict).toMatchObject({ confidence: 'certain', cardinality: 'one-to-one' });
    expect(contradictionWarning(verdict, reversed(ends), MODELS)).toBe(
      'acct_ext.acct_id is marked as a foreign key, so acct_ext is normally the side that points.',
    );
  });
  it('never warns on likely or ambiguous evidence', () => {
    const likely = directionFor(MODELS, { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' })!;
    expect(likely.confidence).toBe('likely');
    expect(contradictionWarning(likely, { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key' }, MODELS)).toBeNull();
    const ambiguous = directionFor(MODELS, { fromModel: 'a', fromColumn: 'x', toModel: 'b', toColumn: 'y' })!;
    expect(contradictionWarning(ambiguous, { fromModel: 'b', fromColumn: 'y', toModel: 'a', toColumn: 'x' }, MODELS)).toBeNull();
  });
});

describe('ambiguous choices', () => {
  it('offers both directions named after the models, in an order independent of the drag', () => {
    const ab = directionFor(MODELS, { fromModel: 'a', fromColumn: 'x', toModel: 'b', toColumn: 'y' })!;
    const ba = directionFor(MODELS, { fromModel: 'b', fromColumn: 'y', toModel: 'a', toColumn: 'x' })!;
    const labels = directionChoices(ab, 'many-to-one').map((c) => c.label);
    expect(labels).toEqual(['a has many rows per b', 'b has many rows per a']);
    expect(directionChoices(ba, 'many-to-one').map((c) => c.label)).toEqual(labels);
    expect(directionChoices(ab, 'one-to-one')[0].label).toBe('a holds the key to b');
  });
  it('offers "Mark as key" only when the target model has no primary key', () => {
    expect(canOfferMarkKey(MODELS, { fromModel: 'a', fromColumn: 'x', toModel: 'b', toColumn: 'y' })).toBe(true);
    expect(canOfferMarkKey(MODELS, FACT_TO_DIM)).toBe(false);
  });
  it('direction keys ignore case and depend on order', () => {
    expect(directionKey(FACT_TO_DIM)).toBe(directionKey({ ...FACT_TO_DIM, fromModel: 'FCT_DAILY' }));
    expect(directionKey(FACT_TO_DIM)).not.toBe(directionKey(reversed(FACT_TO_DIM)));
  });
});

describe('reason lines', () => {
  const verdict: DirectionVerdict = {
    from: { model: 'fct_order', column: 'customer_key' }, to: { model: 'dim_customer', column: 'customer_key' },
    cardinality: 'many-to-one', confidence: 'likely', reasons: ["dim_customer.customer_key is dim_customer's primary key"],
  };
  it('turned-round note quotes the reason', () => {
    expect(turnedRoundNote(verdict)).toBe("Turned round: dim_customer.customer_key is dim_customer's primary key.");
    expect(turnedRoundNote(undefined)).toMatch(/^Turned round/);
  });
  it('likely line says whether the form follows it', () => {
    const ends = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' };
    expect(likelyReason(verdict, ends)).toMatch(/^Suggested because/);
    expect(likelyReason(verdict, reversed(ends))).toMatch(/^Usually the other way round/);
  });
});
