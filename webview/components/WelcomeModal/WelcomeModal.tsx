/**
 * WelcomeModal — first-time user onboarding dialog.
 *
 * Shows on first domain load (tracks in localStorage). Explains the visual
 * language with inline legend content and a "Get Started" button.
 */

import { useCallback, useEffect } from 'react';
import { Panel } from '@xyflow/react';

import { useEditorStore } from '../../store/editorStore';
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

  // Show welcome modal on first domain load
  useEffect(() => {
    if (domain && shouldShowWelcome()) {
      setWelcomeModalOpen(true);
    }
  }, [domain, setWelcomeModalOpen]);

  // Handle "Get Started" button
  const handleGetStarted = useCallback(() => {
    dismissWelcome();
    setWelcomeModalOpen(false);
  }, [setWelcomeModalOpen]);

  if (!welcomeModalOpen) {
    return null;
  }

  return (
    <>
      {/* Backdrop overlay */}
      <div className="welcome-modal__backdrop" />

      <Panel position="top-center" className="welcome-modal">
        <div className="welcome-modal__header">
          <h2 className="welcome-modal__title">Welcome to ERD Studio</h2>
          <p className="welcome-modal__subtitle">
            Design and visualise your dbt semantic layer
          </p>
        </div>

        <div className="welcome-modal__content">
          {/* Quick guide section */}
          <section className="welcome-modal__section">
            <h3 className="welcome-modal__section-title">Design Stages</h3>

            <div className="welcome-modal__guide-grid">
              <div className="welcome-modal__guide-item">
                <div className="welcome-modal__guide-icon">
                  <div className="welcome-modal__model-sample welcome-modal__model-sample--conceptual">
                    <div className="welcome-modal__model-header welcome-modal__model-header--conceptual" />
                  </div>
                </div>
                <div className="welcome-modal__guide-text">
                  <strong>Conceptual</strong>
                  <span>High-level entity design</span>
                </div>
              </div>

              <div className="welcome-modal__guide-item">
                <div className="welcome-modal__guide-icon">
                  <div className="welcome-modal__model-sample welcome-modal__model-sample--logical">
                    <div className="welcome-modal__model-header welcome-modal__model-header--logical" />
                  </div>
                </div>
                <div className="welcome-modal__guide-text">
                  <strong>Logical</strong>
                  <span>Detailed data model</span>
                </div>
              </div>

              <div className="welcome-modal__guide-item">
                <div className="welcome-modal__guide-icon">
                  <div className="welcome-modal__model-sample welcome-modal__model-sample--physical">
                    <div className="welcome-modal__model-header welcome-modal__model-header--physical" />
                  </div>
                </div>
                <div className="welcome-modal__guide-text">
                  <strong>Physical</strong>
                  <span>Built in dbt (read-only)</span>
                </div>
              </div>

              <div className="welcome-modal__guide-item">
                <div className="welcome-modal__guide-icon">
                  <svg className="welcome-modal__edge-sample" viewBox="0 0 48 16" aria-hidden="true">
                    <line x1="4" y1="8" x2="44" y2="8" className="welcome-modal__edge welcome-modal__edge--logical" />
                  </svg>
                </div>
                <div className="welcome-modal__guide-text">
                  <strong>FK Relationship</strong>
                  <span>Foreign key link</span>
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
