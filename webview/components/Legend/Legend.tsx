/**
 * Legend — collapsible panel explaining the visual language of the graph.
 *
 * Shows model status colours, relationship types, cardinality notation,
 * and column badges. Positioned in the bottom-left corner, collapsible
 * to a `?` icon button.
 */

import { useCallback } from 'react';
import { Panel } from '@xyflow/react';
import { useEditorStore } from '../../store/editorStore';
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
        {/* Model Status Section */}
        <section className="legend__section">
          <h3 className="legend__section-title">Model Status</h3>
          <div className="legend__items">
            <div className="legend__item">
              <div className="legend__model-card legend__model-card--built">
                <div className="legend__model-header legend__model-header--built" />
              </div>
              <div className="legend__item-text">
                <span className="legend__item-label">Built</span>
                <span className="legend__item-desc">Exists in dbt manifest</span>
              </div>
            </div>
            <div className="legend__item">
              <div className="legend__model-card legend__model-card--approved">
                <div className="legend__model-header legend__model-header--approved" />
              </div>
              <div className="legend__item-text">
                <span className="legend__item-label">Approved</span>
                <span className="legend__item-desc">Ready for build</span>
              </div>
            </div>
            <div className="legend__item">
              <div className="legend__model-card legend__model-card--design">
                <div className="legend__model-header legend__model-header--design" />
              </div>
              <div className="legend__item-text">
                <span className="legend__item-label">Design</span>
                <span className="legend__item-desc">Planned model</span>
              </div>
            </div>
            <div className="legend__item">
              <div className="legend__model-card legend__model-card--missing">
                <div className="legend__model-header legend__model-header--missing" />
              </div>
              <div className="legend__item-text">
                <span className="legend__item-label">Missing</span>
                <span className="legend__item-desc">Not in manifest</span>
              </div>
            </div>
          </div>
        </section>

        {/* Relationships Section */}
        <section className="legend__section">
          <h3 className="legend__section-title">Relationships</h3>
          <div className="legend__items">
            <div className="legend__item">
              <svg className="legend__edge-sample" viewBox="0 0 60 16" aria-hidden="true">
                <line x1="0" y1="8" x2="60" y2="8" className="legend__edge legend__edge--built" />
              </svg>
              <div className="legend__item-text">
                <span className="legend__item-label">Built FK</span>
                <span className="legend__item-desc">Exists in manifest</span>
              </div>
            </div>
            <div className="legend__item">
              <svg className="legend__edge-sample" viewBox="0 0 60 16" aria-hidden="true">
                <line x1="0" y1="8" x2="60" y2="8" className="legend__edge legend__edge--approved" />
              </svg>
              <div className="legend__item-text">
                <span className="legend__item-label">Approved FK</span>
                <span className="legend__item-desc">Ready for build</span>
              </div>
            </div>
            <div className="legend__item">
              <svg className="legend__edge-sample" viewBox="0 0 60 16" aria-hidden="true">
                <line x1="0" y1="8" x2="60" y2="8" className="legend__edge legend__edge--design" />
              </svg>
              <div className="legend__item-text">
                <span className="legend__item-label">Design FK</span>
                <span className="legend__item-desc">Planned relationship</span>
              </div>
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
                  <line x1="0" y1="4" x2="32" y2="4" className="legend__edge legend__edge--built" />
                </svg>
                <span className="legend__cardinality-label">1</span>
              </div>
              <span className="legend__item-desc">Many-to-one</span>
            </div>
            <div className="legend__item">
              <div className="legend__cardinality">
                <span className="legend__cardinality-label">1</span>
                <svg className="legend__cardinality-line" viewBox="0 0 32 8" aria-hidden="true">
                  <line x1="0" y1="4" x2="32" y2="4" className="legend__edge legend__edge--built legend__edge--dashed" />
                </svg>
                <span className="legend__cardinality-label">1</span>
              </div>
              <span className="legend__item-desc">One-to-one</span>
            </div>
            <div className="legend__item">
              <div className="legend__cardinality">
                <span className="legend__cardinality-label legend__cardinality-label--many">*</span>
                <svg className="legend__cardinality-line" viewBox="0 0 32 8" aria-hidden="true">
                  <line x1="0" y1="4" x2="32" y2="4" className="legend__edge legend__edge--built legend__edge--dotted" />
                </svg>
                <span className="legend__cardinality-label legend__cardinality-label--many">*</span>
              </div>
              <span className="legend__item-desc">Many-to-many</span>
            </div>
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
          </div>
        </section>
      </div>
    </Panel>
  );
}
