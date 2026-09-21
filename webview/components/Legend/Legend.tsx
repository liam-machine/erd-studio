/**
 * Legend — collapsible panel explaining the visual language of the graph.
 *
 * Shows stage colours, relationship types, cardinality notation, the node
 * header badges (schema abbreviation and physical provenance chips) and the
 * column badges. The badge vocabulary is imported from lib/badgeLabels so the
 * legend cannot fall out of step with what ModelNode actually renders. Positioned in the bottom-left corner, collapsible
 * to a `?` icon button.
 */

import { useCallback } from 'react';
import { Panel } from '@xyflow/react';
import { useEditorStore } from '../../store/editorStore';
import {
  SOURCE_LABEL,
  SOURCE_LEGEND_DESC,
  SOURCE_ORDER,
  SCD_BADGE,
  ADDITIVE_BADGE,
  SCD_TITLE,
  ADDITIVE_TITLE,
} from '../../lib/badgeLabels';
import './Legend.css';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Legend() {
  const legendOpen = useEditorStore((s) => s.legendOpen);
  const setLegendOpen = useEditorStore((s) => s.setLegendOpen);

  const handleToggle = useCallback(() => {
    setLegendOpen(!legendOpen);
  }, [legendOpen, setLegendOpen]);

  const handleClose = useCallback(() => {
    setLegendOpen(false);
  }, [setLegendOpen]);

  // Collapsed state: just show the ? button
  if (!legendOpen) {
    return (
      <Panel position="bottom-left" className="legend-toggle">
        <button
          className="legend-toggle__button"
          onClick={handleToggle}
          title="Show legend (Shift+?)"
          aria-label="Show legend"
        >
          ?
        </button>
      </Panel>
    );
  }

  // Expanded state: show full legend panel
  return (
    <Panel position="bottom-left" className="legend">
      <div className="legend__header">
        <span className="legend__title">Legend</span>
        <button
          className="legend__close"
          onClick={handleClose}
          title="Hide legend"
          aria-label="Hide legend"
        >
          ×
        </button>
      </div>

      <div className="legend__content">
        {/* Stage Colours Section */}
        <section className="legend__section">
          <h3 className="legend__section-title">Design Stages</h3>
          <div className="legend__items">
            <div className="legend__item">
              <div className="legend__model-card legend__model-card--logical">
                <div className="legend__model-header legend__model-header--logical" />
              </div>
              <div className="legend__item-text">
                <span className="legend__item-label">Logical</span>
                <span className="legend__item-desc">Your data model design</span>
              </div>
            </div>
            <div className="legend__item">
              <div className="legend__model-card legend__model-card--physical">
                <div className="legend__model-header legend__model-header--physical" />
              </div>
              <div className="legend__item-text">
                <span className="legend__item-label">Physical</span>
                <span className="legend__item-desc">Declared in dbt .yml files (read-only)</span>
              </div>
            </div>
            <div className="legend__item">
              <div className="legend__model-card legend__model-card--ghost">
                <div className="legend__model-header legend__model-header--ghost" />
              </div>
              <div className="legend__item-text">
                <span className="legend__item-label">Ghost</span>
                <span className="legend__item-desc">Not found in your dbt project</span>
              </div>
            </div>
            <div className="legend__item">
              <div className="legend__model-card legend__model-card--ghost legend__model-card--ghost-disabled">
                <div className="legend__model-header legend__model-header--ghost" />
              </div>
              <div className="legend__item-text">
                <span className="legend__item-label">Ghost, dotted</span>
                <span className="legend__item-desc">Disabled in dbt &mdash; <code>ref()</code> to it will not compile</span>
              </div>
            </div>
          </div>
        </section>

        {/* Annotations Section */}
        <section className="legend__section">
          <h3 className="legend__section-title">Annotations</h3>
          <div className="legend__items">
            <div className="legend__item">
              <div className="legend__annotation-card" />
              <div className="legend__item-text">
                <span className="legend__item-label">Build Note</span>
                <span className="legend__item-desc">Temporary note on canvas</span>
              </div>
            </div>
            <div className="legend__item">
              <svg className="legend__edge-sample" viewBox="0 0 48 8" aria-hidden="true">
                <line x1="0" y1="4" x2="48" y2="4" className="legend__edge legend__edge--annotation" />
              </svg>
              <span className="legend__item-desc">Note linked to model</span>
            </div>
          </div>
        </section>

        {/* Cardinality Section */}
        <section className="legend__section">
          <h3 className="legend__section-title">Cardinality</h3>
          <div className="legend__items legend__items--cardinality">
            <div className="legend__item">
              <div className="legend__cardinality">
                <span className="legend__cardinality-label legend__cardinality-label--many">*</span>
                <svg className="legend__cardinality-line" viewBox="0 0 32 8" aria-hidden="true">
                  <line x1="0" y1="4" x2="32" y2="4" className="legend__edge legend__edge--logical" />
                </svg>
                <span className="legend__cardinality-label">1</span>
              </div>
              <span className="legend__item-desc">Many-to-one</span>
            </div>
            <div className="legend__item">
              <div className="legend__cardinality">
                <span className="legend__cardinality-label">1</span>
                <svg className="legend__cardinality-line" viewBox="0 0 32 8" aria-hidden="true">
                  <line x1="0" y1="4" x2="32" y2="4" className="legend__edge legend__edge--logical" />
                </svg>
                <span className="legend__cardinality-label">1</span>
              </div>
              <span className="legend__item-desc">One-to-one</span>
            </div>
            <div className="legend__item">
              <div className="legend__cardinality">
                <span className="legend__cardinality-label">1</span>
                <svg className="legend__cardinality-line" viewBox="0 0 32 8" aria-hidden="true">
                  <line x1="0" y1="4" x2="32" y2="4" className="legend__edge legend__edge--logical" />
                </svg>
                <span className="legend__cardinality-label legend__cardinality-label--many">*</span>
              </div>
              <span className="legend__item-desc">One-to-many</span>
            </div>
            <div className="legend__item">
              <div className="legend__cardinality">
                <span className="legend__cardinality-label legend__cardinality-label--many">*</span>
                <svg className="legend__cardinality-line" viewBox="0 0 32 8" aria-hidden="true">
                  <line x1="0" y1="4" x2="32" y2="4" className="legend__edge legend__edge--logical" />
                </svg>
                <span className="legend__cardinality-label legend__cardinality-label--many">*</span>
              </div>
              <span className="legend__item-desc">Many-to-many</span>
            </div>
          </div>
          <h4 className="legend__subsection-title">Line colour follows the stage</h4>
          <div className="legend__items legend__items--disc-edges">
            <div className="legend__item">
              <svg className="legend__edge-sample" viewBox="0 0 48 8" aria-hidden="true">
                <line x1="0" y1="4" x2="48" y2="4" className="legend__edge legend__edge--logical" />
              </svg>
              <span className="legend__item-desc">Logical</span>
            </div>
            <div className="legend__item">
              <svg className="legend__edge-sample" viewBox="0 0 48 8" aria-hidden="true">
                <line x1="0" y1="4" x2="48" y2="4" className="legend__edge legend__edge--physical" />
              </svg>
              <span className="legend__item-desc">Physical</span>
            </div>
          </div>
        </section>

        {/* Header Badges Section */}
        <section className="legend__section">
          <h3 className="legend__section-title">Header Badges</h3>
          <div className="legend__items">
            <div className="legend__item">
              <span className="legend__badge legend__badge--schema">SLV</span>
              <span className="legend__item-desc">Database schema, or the layer when dbt has not resolved one</span>
            </div>
          </div>
          <h4 className="legend__subsection-title">Where the shape came from (Physical)</h4>
          <div className="legend__items legend__items--sources">
            {SOURCE_ORDER.map((source) => (
              <div className="legend__item" key={source}>
                <span className={`legend__badge legend__badge--source legend__badge--source-${source}`}>
                  {SOURCE_LABEL[source]}
                </span>
                <span className="legend__item-desc">{SOURCE_LEGEND_DESC[source]}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Column Badges Section */}
        <section className="legend__section">
          <h3 className="legend__section-title">Column Badges</h3>
          <div className="legend__items legend__items--badges">
            <div className="legend__item">
              <span className="legend__badge legend__badge--pk">PK</span>
              <span className="legend__item-desc">Primary key</span>
            </div>
            <div className="legend__item">
              <span className="legend__badge legend__badge--fk">FK</span>
              <span className="legend__item-desc">Foreign key</span>
            </div>
            <div className="legend__item">
              <span className="legend__badge legend__badge--nk">NK</span>
              <span className="legend__item-desc">Natural key</span>
            </div>
          </div>
          <div className="legend__items legend__items--symbols">
            <div className="legend__item">
              <span className="legend__symbols legend__symbols--scd">
                {[0, 1, 2].map((t) => (
                  <span key={t} title={SCD_TITLE[t]}>{SCD_BADGE[t]}</span>
                ))}
              </span>
              <span className="legend__item-desc">SCD type &mdash; fixed / overwritten / new row per change</span>
            </div>
            <div className="legend__item">
              <span className="legend__symbols legend__symbols--additive">
                {Object.keys(ADDITIVE_BADGE).map((a) => (
                  <span key={a} title={ADDITIVE_TITLE[a]}>{ADDITIVE_BADGE[a]}</span>
                ))}
              </span>
              <span className="legend__item-desc">Additive / semi-additive / non-additive measure</span>
            </div>
          </div>
        </section>

        {/* Comparing Stages Section */}
        <section className="legend__section">
          <h3 className="legend__section-title">Comparing Stages</h3>
          <p className="legend__note legend__note--lead">
            Shown while a comparison is open (Diff).
          </p>
          <div className="legend__items">
            <div className="legend__item">
              <span className="legend__swatch legend__swatch--extra" />
              <span className="legend__item-desc">
                Amber &mdash; only in the stage you are viewing (<code>only here</code>)
              </span>
            </div>
            <div className="legend__item">
              <span className="legend__swatch legend__swatch--mismatch" />
              <span className="legend__item-desc">Red &mdash; declared differently in each stage</span>
            </div>
            <div className="legend__item">
              <span className="legend__swatch legend__swatch--missing" />
              <span className="legend__item-desc">
                Grey, struck through &mdash; only in the stage being compared against
              </span>
            </div>
          </div>
          <h4 className="legend__subsection-title">Relationship lines</h4>
          <div className="legend__items legend__items--disc-edges">
            <div className="legend__item">
              <svg className="legend__edge-sample" viewBox="0 0 48 8" aria-hidden="true">
                <line x1="0" y1="4" x2="48" y2="4" className="legend__edge legend__edge--disc-extra" />
              </svg>
              <span className="legend__item-desc">Only in this stage</span>
            </div>
            <div className="legend__item">
              <svg className="legend__edge-sample" viewBox="0 0 48 8" aria-hidden="true">
                <line x1="0" y1="4" x2="48" y2="4" className="legend__edge legend__edge--disc-missing" />
              </svg>
              <span className="legend__item-desc">Only in the compared stage</span>
            </div>
            <div className="legend__item">
              <svg className="legend__edge-sample" viewBox="0 0 48 8" aria-hidden="true">
                <line x1="0" y1="4" x2="48" y2="4" className="legend__edge legend__edge--disc-mismatch" />
              </svg>
              <span className="legend__item-desc">Cardinality differs (<code>!</code> at the midpoint)</span>
            </div>
          </div>
        </section>
      </div>
    </Panel>
  );
}
