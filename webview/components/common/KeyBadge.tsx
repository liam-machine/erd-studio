/**
 * KeyBadge — reusable badge for PK/FK/NK column indicators.
 *
 * Renders a single key type badge with click handling and status-aware styling.
 * Used by KeyBadgeGroup to compose multi-key indicators.
 */

import './KeyBadge.css';

export type KeyType = 'PK' | 'FK' | 'NK';

export interface KeyBadgeProps {
  type: KeyType;
  active: boolean;
  mode: 'readonly' | 'editable';
  status?: 'built' | 'approved' | 'planned' | 'missing';
  onClick?: () => void;
}

const KEY_TYPE_LABELS: Record<KeyType, string> = {
  PK: 'Primary Key',
  FK: 'Foreign Key',
  NK: 'Natural Key',
};

export function KeyBadge({ type, active, mode, status, onClick }: KeyBadgeProps) {
  const isClickable = mode === 'editable' && onClick;

  const classes = [
    'key-badge',
    `key-badge--${type.toLowerCase()}`,
    active ? 'key-badge--active' : 'key-badge--inactive',
    status ? `key-badge--${status}` : '',
    isClickable ? 'key-badge--clickable' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const handleClick = (e: React.MouseEvent) => {
    if (isClickable) {
      e.stopPropagation();
      onClick();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && isClickable) {
      e.preventDefault();
      onClick();
    }
  };

  const title = isClickable
    ? `${active ? 'Remove' : 'Set as'} ${KEY_TYPE_LABELS[type]}`
    : KEY_TYPE_LABELS[type];

  return (
    <span
      className={classes}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      title={title}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
    >
      {type}
    </span>
  );
}
