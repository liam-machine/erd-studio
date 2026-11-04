/**
 * **Other Ways to Start ▾**: the draft's other starts that are not drawn as
 * buttons. Each item posts its id only (`otherStart`); the host maps it to a
 * fixed command. Keyboard: Enter / Space / ArrowDown open it on the first
 * item, the arrows move, Escape closes it back to the button.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { DraftOtherStart, DraftOtherStartItem } from '../../src/types/draft';
import { OTHER_WAYS_TO_START } from '../lib/wording';

export interface OtherStartsMenuProps {
  items: readonly DraftOtherStartItem[];
  disabled: boolean;
  onStart(start: DraftOtherStart): void;
}

export function OtherStartsMenu({ items, disabled, onStart }: OtherStartsMenuProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusOnOpen = useRef(false);

  useEffect(() => {
    if (!open) return;
    if (focusOnOpen.current) {
      focusOnOpen.current = false;
      itemRefs.current[0]?.focus();
    }
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onButtonKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusOnOpen.current = true;
      setOpen(true);
    }
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const current = itemRefs.current.findIndex((el) => el === document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = (current + step + items.length) % items.length;
      itemRefs.current[next]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  if (items.length === 0) return null;

  return (
    <div className="draft-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="draft-button draft-button--secondary draft-menu__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => {
          focusOnOpen.current = true;
          setOpen((v) => !v);
        }}
        onKeyDown={onButtonKeyDown}
      >
        {OTHER_WAYS_TO_START}
        <span className="draft-menu__caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul id={menuId} className="draft-menu__list" role="menu" aria-label={OTHER_WAYS_TO_START} onKeyDown={onMenuKeyDown}>
          {items.map((item, index) => (
            <li key={item.id} className="draft-menu__entry" role="none">
              <button
                ref={(el) => { itemRefs.current[index] = el; }}
                type="button"
                role="menuitem"
                className="draft-menu__item"
                onClick={() => {
                  setOpen(false);
                  onStart(item.id);
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
