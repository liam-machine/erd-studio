/**
 * RoleEditor — the always-visible "Table type" dropdown (a table's role).
 *
 * Displays a native <select> element with all TableRole options. Only the
 * labels are words a user reads: the stored keys (`gold-fact`, …) never
 * change. When "No type" is selected, the modelRole key is removed.
 */

import { useCallback } from 'react';
import { useCanvasHost } from '../../host/canvasEnvironment';
import type { TableRole } from '@erd-studio/core';

interface RoleEditorProps {
  modelName: string;
  modelRole?: TableRole;
}

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

export function RoleEditor({ modelName, modelRole }: RoleEditorProps) {
  const host = useCanvasHost();

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      // Skip no-op changes
      if (value === (modelRole ?? '')) return;

      host.postMessage({
        type: 'updateModelRole',
        payload: {
          modelName,
          modelRole: (value || null) as TableRole | null,
        },
      });
    },
    [host, modelName, modelRole],
  );

  return (
    <div className="detail-panel__role-section">
      <h4 className="detail-panel__section-title" style={{ margin: 0 }} id={`table-type-${modelName}`}>
        Table type
      </h4>
      <select
        aria-labelledby={`table-type-${modelName}`}
        className="detail-panel__role-select"
        value={modelRole ?? ''}
        onChange={handleChange}
      >
        <option value="">No type</option>
        {ROLE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
