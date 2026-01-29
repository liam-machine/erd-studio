/**
 * DataTypeSelect — dropdown for selecting SQL data types.
 *
 * Common data types for dbt models. Used in column editing contexts.
 */

import { useEffect, useRef } from 'react';

import './DataTypeSelect.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Standard SQL data types for dbt models. */
export const DATA_TYPES = [
  'STRING',
  'INT',
  'BIGINT',
  'FLOAT',
  'BOOLEAN',
  'DATE',
  'TIMESTAMP',
  'JSON',
] as const;

export type DataType = (typeof DATA_TYPES)[number];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DataTypeSelectProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  className?: string;
  /** Auto-open the dropdown on mount (single click to edit). */
  autoOpen?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DataTypeSelect({
  value,
  onChange,
  onBlur,
  disabled = false,
  className = '',
  autoOpen = false,
}: DataTypeSelectProps) {
  const selectRef = useRef<HTMLSelectElement>(null);

  // Auto-open dropdown on mount by showing the native picker
  useEffect(() => {
    if (autoOpen && selectRef.current) {
      // Focus the select to highlight it
      selectRef.current.focus();
      // Use showPicker() to open the native dropdown (modern browsers)
      if ('showPicker' in selectRef.current) {
        try {
          (selectRef.current as HTMLSelectElement & { showPicker: () => void }).showPicker();
        } catch {
          // showPicker may fail if not triggered by user gesture in some browsers
        }
      }
    }
  }, [autoOpen]);

  return (
    <select
      ref={selectRef}
      className={`data-type-select ${className}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      disabled={disabled}
    >
      {DATA_TYPES.map((dt) => (
        <option key={dt} value={dt}>
          {dt}
        </option>
      ))}
    </select>
  );
}
