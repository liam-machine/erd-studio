/**
 * KeyBadgeGroup — compact dropdown for PK/FK/NK key type selection.
 *
 * Shows selected keys inline when closed, opens dropdown for toggling.
 * Takes up minimal space while allowing any combination of keys.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { KeyBadge, type KeyType } from './KeyBadge';
import './KeyBadgeGroup.css';

export interface KeyBadgeGroupProps {
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isNaturalKey: boolean;
  mode: 'readonly' | 'editable';
  status?: 'built' | 'approved' | 'planned' | 'missing';
  onTogglePK?: () => void;
  onToggleFK?: () => void;
  onToggleNK?: () => void;
  /** Show warning icon if multiple PKs exist in the model. */
  showMultiplePKWarning?: boolean;
}

interface DropdownPosition {
  top: number;
  left: number;
}

const KEY_CONFIG: Array<{
  type: KeyType;
  label: string;
  description: string;
}> = [
  { type: 'PK', label: 'Primary Key', description: 'Unique identifier for each row' },
  { type: 'FK', label: 'Foreign Key', description: 'References another table' },
  { type: 'NK', label: 'Natural Key', description: 'Business identifier (email, SKU)' },
];

export function KeyBadgeGroup({
  isPrimaryKey,
  isForeignKey,
  isNaturalKey,
  mode,
  status,
  onTogglePK,
  onToggleFK,
  onToggleNK,
  showMultiplePKWarning = false,
}: KeyBadgeGroupProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<DropdownPosition>({ top: 0, left: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const isEditable = mode === 'editable' && (onTogglePK || onToggleFK || onToggleNK);

  // Calculate dropdown position when open (useLayoutEffect for sync update before paint)
  useLayoutEffect(() => {
    if (isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.bottom + 2,
        left: rect.left,
      });
    }
  }, [isOpen]);

  // Close dropdown when clicking outside (check both container and portal dropdown)
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const clickedInContainer = containerRef.current?.contains(target);
      const clickedInDropdown = dropdownRef.current?.contains(target);
      if (!clickedInContainer && !clickedInDropdown) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
    return undefined;
  }, [isOpen]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsOpen(false);
      }
    },
    [],
  );

  // Get selected keys for display
  const selectedKeys: KeyType[] = [];
  if (isPrimaryKey) selectedKeys.push('PK');
  if (isForeignKey) selectedKeys.push('FK');
  if (isNaturalKey) selectedKeys.push('NK');

  // Toggle handlers mapped by type
  const toggleHandlers: Record<KeyType, (() => void) | undefined> = {
    PK: onTogglePK,
    FK: onToggleFK,
    NK: onToggleNK,
  };

  // Get active state by type
  const activeStates: Record<KeyType, boolean> = {
    PK: isPrimaryKey,
    FK: isForeignKey,
    NK: isNaturalKey,
  };

  const handleToggle = useCallback(() => {
    if (isEditable) {
      setIsOpen((prev) => !prev);
    }
  }, [isEditable]);

  const handleOptionClick = useCallback(
    (type: KeyType, e: React.MouseEvent) => {
      e.stopPropagation();
      toggleHandlers[type]?.();
      // Keep dropdown open for multi-select
    },
    [toggleHandlers],
  );

  // Warning icon for multiple PKs
  const warningIcon =
    showMultiplePKWarning && isPrimaryKey ? (
      <span
        className="key-badge-group__warning"
        title="Multiple primary keys detected in this model"
      >
        !
      </span>
    ) : null;

  return (
    <div
      ref={containerRef}
      className={`key-badge-group ${isOpen ? 'key-badge-group--open' : ''} ${isEditable ? 'key-badge-group--editable' : ''}`}
      onKeyDown={handleKeyDown}
    >
      {/* Trigger button showing selected keys */}
      <button
        ref={triggerRef}
        type="button"
        className="key-badge-group__trigger"
        onClick={handleToggle}
        disabled={!isEditable}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        title={isEditable ? 'Click to edit key types' : undefined}
      >
        {selectedKeys.length > 0 ? (
          <span className="key-badge-group__selected">
            {selectedKeys.map((type) => (
              <KeyBadge
                key={type}
                type={type}
                active={true}
                mode="readonly"
                status={status}
              />
            ))}
          </span>
        ) : (
          <span className="key-badge-group__empty">—</span>
        )}
        {isEditable && <span className="key-badge-group__arrow">▾</span>}
        {warningIcon}
      </button>

      {/* Dropdown with checkboxes - rendered via portal to escape overflow containers */}
      {isOpen &&
        createPortal(
          <div
            ref={dropdownRef}
            className="key-badge-group__dropdown"
            style={{ top: dropdownPos.top, left: dropdownPos.left }}
          >
            {KEY_CONFIG.map(({ type, label, description }) => {
              const isActive = activeStates[type];
              const handler = toggleHandlers[type];
              return (
                <div
                  key={type}
                  className={`key-badge-group__option ${isActive ? 'key-badge-group__option--active' : ''}`}
                  onClick={(e) => handleOptionClick(type, e)}
                  role="checkbox"
                  aria-checked={isActive}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handler?.();
                    }
                  }}
                >
                  <span className="key-badge-group__checkbox">
                    {isActive ? '✓' : ''}
                  </span>
                  <KeyBadge
                    type={type}
                    active={isActive}
                    mode="readonly"
                    status={status}
                  />
                  <span className="key-badge-group__label">
                    <span className="key-badge-group__label-text">{label}</span>
                    <span className="key-badge-group__label-desc">{description}</span>
                  </span>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
