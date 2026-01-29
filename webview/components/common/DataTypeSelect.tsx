/**
 * DataTypeSelect — dropdown for selecting SQL data types.
 *
 * Common data types for dbt models. Used in column editing contexts.
 */

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
  disabled?: boolean;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DataTypeSelect({
  value,
  onChange,
  disabled = false,
  className = '',
}: DataTypeSelectProps) {
  return (
    <select
      className={`data-type-select ${className}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
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
