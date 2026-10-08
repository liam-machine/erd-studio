import type { DbtKeyHint } from '@erd-studio/core';

/**
 * The line a column's hover text gains for what dbt's tests say about it
 * (#133 L1). It informs a new relationship's direction only, so it is never
 * a badge: the key flags are the user's design decision.
 */
export function dbtKeyTitle(hint: DbtKeyHint): string {
  switch (hint.because) {
    case 'unique-test':
    case 'unique-combination':
      return 'dbt: tested as unique';
    case 'part-of-unique-combination':
      return 'dbt: part of a unique combination';
    case 'relationships-test':
      return 'dbt: has a relationships test';
  }
}
