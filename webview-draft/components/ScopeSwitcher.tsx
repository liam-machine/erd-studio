/**
 * The banner's switcher (docs/dev/draft-first.md §2.2): a labelled `<select>`
 * over the draft's scopes (a dbt models folder, a semantic model, an
 * example). Choosing another posts `scope`; the page then shows Drawing…
 * until the host sends the next draft.
 */

import { useId } from 'react';
import type { DraftScopes } from '../../src/types/draft';

export interface ScopeSwitcherProps {
  scopes: DraftScopes;
  disabled: boolean;
  onScope(scopeId: string): void;
}

export function ScopeSwitcher({ scopes, disabled, onScope }: ScopeSwitcherProps) {
  const id = useId();
  return (
    <div className="draft-scope">
      <label className="draft-scope__label" htmlFor={id}>{scopes.label}</label>
      <select
        id={id}
        className="draft-scope__select"
        value={scopes.current}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value !== scopes.current) onScope(e.target.value);
        }}
      >
        {scopes.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.description ? `${option.label} · ${option.description}` : option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
