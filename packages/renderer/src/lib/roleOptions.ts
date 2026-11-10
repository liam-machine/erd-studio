/**
 * The words the canvas shows for each table role. The stored keys
 * (`gold-fact`, …) never change; only the labels are for people. The order is
 * core's `TABLE_ROLE_VALUES` (the role field's choices).
 */

import type { TableRole } from '@erd-studio/core';

/** Human-readable labels for each role (the stored key stays as it is). */
export const ROLE_OPTIONS: ReadonlyArray<{ value: TableRole; label: string }> = [
  { value: 'conformed-dim', label: 'Conformed dimension' },
  { value: 'domain-dim', label: 'Local dimension' },
  { value: 'transaction-fact', label: 'Transaction fact' },
  { value: 'periodic-snapshot', label: 'Periodic snapshot' },
  { value: 'accumulating-snapshot', label: 'Accumulating snapshot' },
  { value: 'factless-fact', label: 'Factless fact (bridge)' },
  { value: 'reference', label: 'Reference' },
  { value: 'gold-fact', label: 'Pre-joined fact' },
  { value: 'gold-dim', label: 'Flattened dimension' },
];

const ROLE_LABELS: ReadonlyMap<string, string> = new Map(ROLE_OPTIONS.map((o) => [o.value, o.label]));

/** The label for a role key, or the key itself for a role this renderer does not know. */
export function roleLabel(role: string): string {
  return ROLE_LABELS.get(role) ?? role;
}
