/**
 * Cardinality utility functions.
 *
 * Pure helpers for working with FK relationship cardinality values.
 */

import type { Cardinality } from '../../src/types/semantic';

/**
 * Returns the inverse cardinality (source/target sides swapped).
 *
 * many-to-one  ↔  one-to-many
 * one-to-one   →  one-to-one   (symmetric, no-op)
 * many-to-many →  many-to-many (symmetric, no-op)
 */
export function swapCardinality(c: Cardinality): Cardinality {
  switch (c) {
    case 'many-to-one':
      return 'one-to-many';
    case 'one-to-many':
      return 'many-to-one';
    case 'one-to-one':
      return 'one-to-one';
    case 'many-to-many':
      return 'many-to-many';
  }
}
