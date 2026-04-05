/**
 * RoleEditor — always-visible dropdown for setting a model's role.
 *
 * Displays a native <select> element with all ModelRole options.
 * When "No role" is selected, the modelRole key is removed from JSON.
 */

import { useCallback } from 'react';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import type { ModelRole } from '../../../src/types/semantic';

interface RoleEditorProps {
  modelName: string;
  modelRole?: ModelRole;
}

/** Human-readable labels for each role. */
const ROLE_OPTIONS: Array<{ value: ModelRole; label: string }> = [
  { value: 'conformed-dim', label: 'Conformed Dimension' },
  { value: 'domain-dim', label: 'Domain Dimension' },
  { value: 'transaction-fact', label: 'Transaction Fact' },
  { value: 'periodic-snapshot', label: 'Periodic Snapshot' },
  { value: 'accumulating-snapshot', label: 'Accumulating Snapshot' },
  { value: 'factless-fact', label: 'Factless Fact (Bridge)' },
  { value: 'reference', label: 'Reference' },
  { value: 'gold-fact', label: 'Gold Fact' },
  { value: 'gold-dim', label: 'Gold Dimension' },
];

export function RoleEditor({ modelName, modelRole }: RoleEditorProps) {
  const vscode = useVsCodeApi();

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      // Skip no-op changes
      if (value === (modelRole ?? '')) return;

      vscode.postMessage({
        type: 'updateModelRole',
        payload: {
          modelName,
          modelRole: (value || null) as ModelRole | null,
        },
      });
    },
    [vscode, modelName, modelRole],
  );

  return (
    <div className="detail-panel__role-section">
      <h4 className="detail-panel__section-title" style={{ margin: 0 }}>
        Role
      </h4>
      <select
        className="detail-panel__role-select"
        value={modelRole ?? ''}
        onChange={handleChange}
      >
        <option value="">No role</option>
        {ROLE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
