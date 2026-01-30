/**
 * WelcomeModal — first-time user onboarding dialog.
 *
 * Shows on first domain load (tracks in localStorage). Explains the visual
 * language with inline legend content and a "Get Started" button.
 * Also includes a palette preview to let users see all three options.
 */

import { useCallback, useEffect, useState } from 'react';
import { Panel } from '@xyflow/react';

import { useEditorStore } from '../../store/editorStore';
import {
  PALETTES,
  applyPalette,
  persistPalette,
  loadPersistedPalette,
  type PaletteId,
} from '../../lib/colorPalettes';
import './WelcomeModal.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'dbt-semantic-designer:welcome-dismissed';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if the welcome modal should be shown (first time user).
 */
function shouldShowWelcome(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'true';
  } catch {
    return true; // Show if localStorage unavailable
  }
}

/**
 * Mark the welcome modal as dismissed.
 */
function dismissWelcome(): void {
  try {
    localStorage.setItem(STORAGE_KEY, 'true');
  } catch {
    // Ignore if localStorage unavailable
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WelcomeModal() {
  const domain = useEditorStore((s) => s.domain);
  const welcomeModalOpen = useEditorStore((s) => s.welcomeModalOpen);
  const setWelcomeModalOpen = useEditorStore((s) => s.setWelcomeModalOpen);
  const paletteId = useEditorStore((s) => s.paletteId);
  const setPaletteId = useEditorStore((s) => s.setPaletteId);

  // Local state for palette preview (before user confirms)
  const [previewPalette, setPreviewPalette] = useState<PaletteId>(paletteId);

  // Show welcome modal on first domain load
  useEffect(() => {
    if (domain && shouldShowWelcome()) {
      setWelcomeModalOpen(true);
      // Load persisted palette preference
      const savedPalette = loadPersistedPalette();
      setPreviewPalette(savedPalette);
      setPaletteId(savedPalette);
      applyPalette(savedPalette);
    }
  }, [domain, setWelcomeModalOpen, setPaletteId]);

  // Apply palette preview when user hovers/selects
  const handlePaletteChange = useCallback((newPalette: PaletteId) => {
    setPreviewPalette(newPalette);
    applyPalette(newPalette);
  }, []);

  // Handle "Get Started" button
  const handleGetStarted = useCallback(() => {
    // Persist the selected palette
    setPaletteId(previewPalette);
    persistPalette(previewPalette);
    // Dismiss the welcome modal
    dismissWelcome();
    setWelcomeModalOpen(false);
  }, [previewPalette, setPaletteId, setWelcomeModalOpen]);

  if (!welcomeModalOpen) {
    return null;
  }

  return (
    <>
      {/* Backdrop overlay */}
      <div className="welcome-modal__backdrop" />

      <Panel position="top-center" className="welcome-modal">
        <div className="welcome-modal__header">
          <h2 className="welcome-modal__title">Welcome to Semantic Designer</h2>
          <p className="welcome-modal__subtitle">
            Design and visualise your dbt semantic layer
          </p>
        </div>

        <div className="welcome-modal__content">
          {/* Quick guide section */}
          <section className="welcome-modal__section">
            <h3 className="welcome-modal__section-title">Visual Guide</h3>

            <div className="welcome-modal__guide-grid">
              {/* Models */}
              <div className="welcome-modal__guide-item">
                <div className="welcome-modal__guide-icon">
                  <div className="welcome-modal__model-sample welcome-modal__model-sample--built">
                    <div className="welcome-modal__model-header welcome-modal__model-header--built" />
                  </div>
                </div>
                <div className="welcome-modal__guide-text">
                  <strong>Built Model</strong>
                  <span>Exists in dbt manifest</span>
                </div>
              </div>

              <div className="welcome-modal__guide-item">
                <div className="welcome-modal__guide-icon">
                  <div className="welcome-modal__model-sample welcome-modal__model-sample--design">
                    <div className="welcome-modal__model-header welcome-modal__model-header--design" />
                  </div>
                </div>
                <div className="welcome-modal__guide-text">
                  <strong>Design Model</strong>
                  <span>Planned, not yet built</span>
                </div>
              </div>

              {/* Relationships */}
              <div className="welcome-modal__guide-item">
                <div className="welcome-modal__guide-icon">
                  <svg className="welcome-modal__edge-sample" viewBox="0 0 48 16" aria-hidden="true">
                    <line x1="4" y1="8" x2="44" y2="8" className="welcome-modal__edge welcome-modal__edge--built" />
                  </svg>
                </div>
                <div className="welcome-modal__guide-text">
                  <strong>Built FK</strong>
                  <span>Defined in manifest</span>
                </div>
              </div>

              <div className="welcome-modal__guide-item">
                <div className="welcome-modal__guide-icon">
                  <svg className="welcome-modal__edge-sample" viewBox="0 0 48 16" aria-hidden="true">
                    <line x1="4" y1="8" x2="44" y2="8" className="welcome-modal__edge welcome-modal__edge--design" />
                  </svg>
                </div>
                <div className="welcome-modal__guide-text">
                  <strong>Design FK</strong>
                  <span>Planned relationship</span>
                </div>
              </div>
            </div>

            {/* Cardinality notation */}
            <div className="welcome-modal__cardinality-info">
              <span className="welcome-modal__cardinality-item">
                <span className="welcome-modal__cardinality-symbol">*</span> = Many
              </span>
              <span className="welcome-modal__cardinality-item">
                <span className="welcome-modal__cardinality-symbol">1</span> = One
              </span>
              <span className="welcome-modal__cardinality-item">
                <span className="welcome-modal__cardinality-line welcome-modal__cardinality-line--dashed" /> = 1:1
              </span>
              <span className="welcome-modal__cardinality-item">
                <span className="welcome-modal__cardinality-line welcome-modal__cardinality-line--dotted" /> = M:M
              </span>
            </div>
          </section>

          {/* Palette selector */}
          <section className="welcome-modal__section">
            <h3 className="welcome-modal__section-title">Choose Colour Palette</h3>

            <div className="welcome-modal__palette-grid">
              {(Object.keys(PALETTES) as PaletteId[]).map((id) => {
                const palette = PALETTES[id];
                const isSelected = previewPalette === id;

                return (
                  <button
                    key={id}
                    className={`welcome-modal__palette-option${isSelected ? ' welcome-modal__palette-option--selected' : ''}`}
                    onClick={() => handlePaletteChange(id)}
                    aria-pressed={isSelected}
                  >
                    <div className="welcome-modal__palette-preview">
                      <div
                        className="welcome-modal__palette-swatch"
                        style={{ backgroundColor: palette.colors.modelBuilt }}
                      />
                      <div
                        className="welcome-modal__palette-swatch"
                        style={{ backgroundColor: palette.colors.modelDesign }}
                      />
                      <div
                        className="welcome-modal__palette-swatch"
                        style={{ backgroundColor: palette.colors.edgeBuilt }}
                      />
                    </div>
                    <div className="welcome-modal__palette-info">
                      <span className="welcome-modal__palette-name">{palette.name}</span>
                      <span className="welcome-modal__palette-desc">{palette.description}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        <div className="welcome-modal__footer">
          <span className="welcome-modal__tip">
            Press <kbd>?</kbd> to show the legend anytime
          </span>
          <button
            className="welcome-modal__button welcome-modal__button--primary"
            onClick={handleGetStarted}
          >
            Get Started
          </button>
        </div>
      </Panel>
    </>
  );
}
