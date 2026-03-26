/**
 * WelcomeModal — first-time user onboarding dialog.
 *
 * Shows on first domain load. Dismissal is persisted in the extension's
 * globalState so it only ever shows once across all panels and sessions.
 * The extension sends `welcomeDismissed` on the `domainLoaded` message;
 * App.tsx opens this modal when that flag is false.
 */

import { useCallback } from 'react';
import { Panel } from '@xyflow/react';

import { useEditorStore } from '../../store/editorStore';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import './WelcomeModal.css';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WelcomeModal() {
  const vscode = useVsCodeApi();
  const welcomeModalOpen = useEditorStore((s) => s.welcomeModalOpen);
  const setWelcomeModalOpen = useEditorStore((s) => s.setWelcomeModalOpen);

  // Handle "Get Started" button — tell extension to persist dismissal in globalState
  const handleGetStarted = useCallback(() => {
    vscode.postMessage({ type: 'dismissWelcome' });
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
            Design your data warehouse visually, then compare what you
            designed to what's built.
          </p>
        </div>

        <div className="welcome-modal__content">
          {/* Three Stages */}
          <section className="welcome-modal__section">
            <h3 className="welcome-modal__section-title">The Two Stages</h3>

            <div className="welcome-modal__stages-list">
              <div className="welcome-modal__stage-row">
                <div className="welcome-modal__guide-icon">
                  <div className="welcome-modal__model-sample welcome-modal__model-sample--logical">
                    <div className="welcome-modal__model-header welcome-modal__model-header--logical" />
                  </div>
                </div>
                <div className="welcome-modal__guide-text">
                  <strong>Logical</strong>
                  <span>
                    Design your data models here — add columns, data types,
                    primary/foreign keys, and relationships. This is your
                    blueprint for what the data warehouse should look like.
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
                    Automatically read from your dbt .yml schema files — see
                    what's actually defined in your dbt project. Enriched with
                    data types when a compiled manifest is available.
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
                  (<kbd>Alt+1</kbd> / <kbd>Alt+2</kbd>)
                </span>
              </li>
              <li className="welcome-modal__step">
                <span className="welcome-modal__step-number">2</span>
                <span className="welcome-modal__step-text">
                  Design models and relationships in the Logical stage
                </span>
              </li>
              <li className="welcome-modal__step">
                <span className="welcome-modal__step-number">3</span>
                <span className="welcome-modal__step-text">
                  Toggle <strong>Diff</strong> to compare your design against what's in dbt and spot differences
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
