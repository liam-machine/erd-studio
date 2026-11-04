/**
 * The details drawer (docs/dev/draft-first.md §2.4): what the draft brings in
 * and leaves out, section by section, as text (React text nodes, never HTML).
 * A section shows its first {@link DETAILS_PAGE} items, then Show all.
 */

import { useEffect, useRef, useState } from 'react';
import type { DraftDetailSection } from '../../src/types/draft';
import { DETAILS_PAGE, formatCount } from '../lib/wording';

export interface DetailsDrawerProps {
  sections: readonly DraftDetailSection[];
  onClose(): void;
}

function Section({ section }: { section: DraftDetailSection }) {
  const [all, setAll] = useState(false);
  const count = section.count ?? section.items.length;
  const items = all ? section.items : section.items.slice(0, DETAILS_PAGE);
  const hidden = section.items.length - items.length;
  return (
    <section className="draft-drawer__section" aria-label={section.title}>
      <h2 className="draft-drawer__title">
        {section.title}
        <span className="draft-drawer__count">{` (${formatCount(count)})`}</span>
      </h2>
      {section.hint && <p className="draft-drawer__hint">{section.hint}</p>}
      {items.length > 0 && (
        <ul className="draft-drawer__items">
          {items.map((item, i) => (
            <li key={i} className="draft-drawer__item">
              {item.path && <code className="draft-drawer__path">{item.path}</code>}
              {item.path && ' '}
              <span className="draft-drawer__text">{item.text}</span>
              {item.tag && <span className="draft-drawer__tag">{item.tag}</span>}
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <button type="button" className="draft-banner__link draft-drawer__more" onClick={() => setAll(true)}>
          {`Show all (${formatCount(section.items.length)})`}
        </button>
      )}
    </section>
  );
}

export function DetailsDrawer({ sections, onClose }: DetailsDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  return (
    <aside
      className="draft-drawer"
      aria-label="Details"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="draft-drawer__header">
        <span className="draft-drawer__heading">Details</span>
        <button ref={closeRef} type="button" className="draft-drawer__close" aria-label="Close details" title="Close details" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="draft-drawer__body">
        {sections.map((section) => <Section key={section.id} section={section} />)}
      </div>
    </aside>
  );
}
