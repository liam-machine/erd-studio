/**
 * DataTypeSelect — custom dropdown for selecting SQL data types.
 *
 * Opens immediately on click (no second click required).
 * Common data types for dbt models. Used in column editing contexts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
  const [isOpen, setIsOpen] = useState(autoOpen);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Close dropdown when clicking outside.
  // Defer listener registration by a frame so that the mousedown event which
  // triggered the mount (e.g. double-click) does not immediately close the
  // dropdown via the click-outside handler.
  useEffect(() => {
    if (!isOpen) return undefined;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const inContainer = containerRef.current?.contains(target);
      const inDropdown = listRef.current?.contains(target);
      if (!inContainer && !inDropdown) {
        setIsOpen(false);
        onBlur?.();
      }
    };

    const rafId = requestAnimationFrame(() => {
      document.addEventListener('mousedown', handleClickOutside);
    });

    return () => {
      cancelAnimationFrame(rafId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onBlur]);

  // Calculate dropdown position when opening
  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + 2,
        left: rect.left,
      });
    }
  }, [isOpen]);

  // Focus the list when it opens for keyboard navigation
  useEffect(() => {
    if (isOpen && listRef.current) {
      listRef.current.focus();
    }
  }, [isOpen]);

  // Handle option selection
  const handleSelect = useCallback(
    (newValue: string) => {
      onChange(newValue);
      setIsOpen(false);
    },
    [onChange],
  );

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsOpen(false);
        onBlur?.();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const focused = document.activeElement;
        if (focused?.getAttribute('data-value')) {
          handleSelect(focused.getAttribute('data-value')!);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const items = listRef.current?.querySelectorAll('li');
        const currentIdx = Array.from(items || []).findIndex(
          (item) => item === document.activeElement,
        );
        const nextIdx = currentIdx < (items?.length || 0) - 1 ? currentIdx + 1 : 0;
        (items?.[nextIdx] as HTMLElement)?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const items = listRef.current?.querySelectorAll('li');
        const currentIdx = Array.from(items || []).findIndex(
          (item) => item === document.activeElement,
        );
        const prevIdx = currentIdx > 0 ? currentIdx - 1 : (items?.length || 1) - 1;
        (items?.[prevIdx] as HTMLElement)?.focus();
      }
    },
    [handleSelect, onBlur],
  );

  // Toggle dropdown
  const handleToggle = useCallback(() => {
    if (!disabled) {
      setIsOpen((prev) => !prev);
    }
  }, [disabled]);

  return (
    <div
      ref={containerRef}
      className={`data-type-select ${isOpen ? 'data-type-select--open' : ''} ${disabled ? 'data-type-select--disabled' : ''} ${className}`}
    >
      <button
        ref={triggerRef}
        type="button"
        className="data-type-select__trigger"
        onClick={handleToggle}
        onMouseDown={(e) => e.stopPropagation()}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="data-type-select__value">{value}</span>
        <span className="data-type-select__arrow">▾</span>
      </button>

      {isOpen && createPortal(
        <ul
          ref={listRef}
          className="data-type-select__dropdown"
          style={{ top: dropdownPosition.top, left: dropdownPosition.left }}
          role="listbox"
          tabIndex={-1}
          onKeyDown={handleKeyDown}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {DATA_TYPES.map((dt) => (
            <li
              key={dt}
              className={`data-type-select__option ${dt === value ? 'data-type-select__option--selected' : ''}`}
              role="option"
              aria-selected={dt === value}
              data-value={dt}
              tabIndex={0}
              onClick={() => handleSelect(dt)}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {dt}
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  );
}
