/**
 * ReconnectOverlay — surfaces an orphaned-canvas state to the user.
 *
 * Renders when the webview has sent `ready` but received no `domainLoaded`
 * within the boot grace period. The most common cause is an extension update
 * that tore down the previous host instance after this panel was already
 * open, leaving no message handler bound. Activation-time auto-recovery
 * should usually fix this before the overlay appears; this is the safety net
 * for cases where it didn't (e.g. the extension was disabled and re-enabled).
 */

import './ReconnectOverlay.css';

export interface ReconnectOverlayProps {
  onReload: () => void;
}

export function ReconnectOverlay({ onReload }: ReconnectOverlayProps) {
  return (
    <div className="reconnect-overlay" role="alert">
      <div className="reconnect-overlay__panel">
        <h3 className="reconnect-overlay__title">Canvas disconnected</h3>
        <p className="reconnect-overlay__body">
          ERD Studio looks like it was updated or restarted. Reload the window to reconnect — your work will be saved first.
        </p>
        <button className="reconnect-overlay__button" onClick={onReload}>
          Reload Window
        </button>
      </div>
    </div>
  );
}
