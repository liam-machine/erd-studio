/**
 * ReconnectOverlay — surfaces an orphaned-canvas state to the user.
 *
 * Renders when the webview has sent `ready` but received no answer — neither
 * `domainLoaded` nor `error` — within the boot grace period (the timing rule
 * is `useReconnectWatchdog`). The most common cause is an extension update
 * that tore down the previous host instance after this panel was already
 * open, leaving no message handler bound. Activation-time auto-recovery
 * should usually fix this before the overlay appears; this is the safety net
 * for cases where it didn't (e.g. the extension was disabled and re-enabled).
 */

import './ReconnectOverlay.css';

export interface ReconnectOverlayProps {
  onReload: () => void;
  /** Open the ERD Studio log (what the host was busy with). Absent: no button. */
  onShowLogs?: () => void;
}

export function ReconnectOverlay({ onReload, onShowLogs }: ReconnectOverlayProps) {
  return (
    <div className="reconnect-overlay" role="alert">
      <div className="reconnect-overlay__panel">
        {/* Decorative: a broken link. Colour from CSS (currentColor). */}
        <span className="reconnect-overlay__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" focusable="false">
            <path d="M9.5 14.5 8 16a3.5 3.5 0 0 1-5-5l2.5-2.5a3.5 3.5 0 0 1 4.6-.3M14.5 9.5 16 8a3.5 3.5 0 0 1 5 5l-2.5 2.5a3.5 3.5 0 0 1-4.6.3M8 3.5l1 2M3.5 8l2 1M16 20.5l-1-2M20.5 16l-2-1" />
          </svg>
        </span>
        <h3 className="reconnect-overlay__title">Canvas disconnected</h3>
        <p className="reconnect-overlay__body">
          ERD Studio looks like it was updated or restarted. Reload the window to reconnect — your work will be saved first.
        </p>
        <div className="reconnect-overlay__actions">
          <button className="reconnect-overlay__button" onClick={onReload}>
            Reload Window
          </button>
          {onShowLogs && (
            <button className="reconnect-overlay__button reconnect-overlay__button--secondary" onClick={onShowLogs}>
              Show Logs
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
