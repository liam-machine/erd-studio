/**
 * WelcomeModal — first-time user onboarding dialog.
 *
 * Shows on first domain load (tracks in localStorage). Explains what ERD Studio
 * does, the three design stages, how to get started, and the cardinality
 * notation used on relationship edges.
 */

import { useCallback, useEffect } from 'react';
import { Panel } from '@xyflow/react';

import { useEditorStore } from '../../store/editorStore';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import './WelcomeModal.css';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WelcomeModal() {
  const vscode = useVsCodeApi();
  const domain = useEditorStore((s) => s.domain);
  const welcomeModalOpen = useEditorStore((s) => s.welcomeModalOpen);
  const setWelcomeModalOpen = useEditorStore((s) => s.setWelcomeModalOpen);

  // Show welcome modal on first domain load (check vscode state for dismissal)
  useEffect(() => {
    if (!domain) return;
    const state = vscode.getState() as Record<string, unknown> | null;
    if (!state?.welcomeDismissed) {
      setWelcomeModalOpen(true);
    }
  }, [domain, vscode, setWelcomeModalOpen]);

  // Handle "Get Started" button — persist dismissal to vscode state
  const handleGetStarted = useCallback(() => {
    const existing = (vscode.getState() as Record<string, unknown> | null) ?? {};
    vscode.setState({ ...existing, welcomeDismissed: true });
    setWelcomeModalOpen(false);
  }, [vscode, setWelcomeModalOpen]);

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
            Design your data warehouse visually across three stages, then
            compare what you designed to what's built.
          </p>
        </div>

        <div className="welcome-modal__content">
          {/* Three Stages */}
          <section className="welcome-modal__section">
            <h3 className="welcome-modal__section-title">The Three Stages</h3>

            <div className="welcome-modal__stages-list">
              <div className="welcome-modal__stage-row">
                <div className="welcome-modal__guide-icon">
                  <div className="welcome-modal__model-sample welcome-modal__model-sample--conceptual">
                    <div className="welcome-modal__model-header welcome-modal__model-header--conceptual" />
                  </div>
                </div>
                <div className="welcome-modal__guide-text">
                  <strong>Conceptual</strong>
                  <span>
                    Define business entities and how they relate — no column
                    details needed
                  </span>
                </div>
              </div>

              <div className="welcome-modal__stage-row">
                <div className="welcome-modal__guide-icon">
                  <div className="welcome-modal__model-sample welcome-modal__model-sample--logical">
                    <div className="welcome-modal__model-header welcome-modal__model-header--logical" />
                  </div>
                </div>
                <div className="welcome-modal__guide-text">
                  <strong>Logical</strong>
                  <span>
                    Add columns, data types, keys, and FK relationships — your
                    detailed blueprint
                  </span>
                </div>
              </div>

              <div className="welcome-modal__stage-row">
                <div className="welcome-modal__guide-icon">
                  <div className="welcome-modal__model-sample welcome-modal__model-sample--physical">
                    <div className="welcome-modal__model-header welcome-modal__model-header--physical" />
                  </div>
                </div>
                <div className="welcome-modal__guide-text">
                  <strong>Physical</strong>
                  <span>
                    Auto-populated from your dbt manifest — read-only view of
                    what's actually built
                  </span>
                </div>
              </div>
            </div>
          </section>

          {/* How to Use It */}
          <section className="welcome-modal__section">
            <h3 className="welcome-modal__section-title">How to Use It</h3>

            <ol className="welcome-modal__steps">
              <li className="welcome-modal__step">
                <span className="welcome-modal__step-number">1</span>
                <span className="welcome-modal__step-text">
                  Switch stages using the tabs in the toolbar
                  (<kbd>Alt+1</kbd> / <kbd>Alt+2</kbd> / <kbd>Alt+3</kbd>)
                </span>
              </li>
              <li className="welcome-modal__step">
                <span className="welcome-modal__step-number">2</span>
                <span className="welcome-modal__step-text">
                  Design models and relationships in Conceptual or Logical stages
                </span>
              </li>
              <li className="welcome-modal__step">
                <span className="welcome-modal__step-number">3</span>
                <span className="welcome-modal__step-text">
                  Toggle Diff to compare stages and spot discrepancies
                </span>
              </li>
            </ol>
          </section>

          {/* Cardinality Notation */}
          <section className="welcome-modal__section">
            <h3 className="welcome-modal__section-title">
              Cardinality Notation
            </h3>

            <div className="welcome-modal__guide-grid">
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
