/**
 * Typed message bus for extension ↔ webview communication.
 *
 * Messages are categorised by direction:
 *   Extension → Webview:  domainLoaded, domainUpdated, manifestRefreshed, error
 *   Webview → Extension:  ready, addModel, updatePositions, runAutoLayout, …
 *
 * This hook subscribes to incoming messages on mount and provides a typed
 * `send` helper for outgoing messages.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useVsCodeApi } from './useVsCodeApi';

// ---------------------------------------------------------------------------
// Extension → Webview messages
// ---------------------------------------------------------------------------

import type { SemanticDomain } from '../../src/types/semantic';

export interface DomainLoadedMessage {
  type: 'domainLoaded';
  payload: SemanticDomain;
}

export interface ErrorMessage {
  type: 'error';
  payload: { message: string };
}

/** Union of all messages the extension can send to the webview. */
export type ExtensionMessage = DomainLoadedMessage | ErrorMessage;

// ---------------------------------------------------------------------------
// Webview → Extension messages
// ---------------------------------------------------------------------------

export interface ReadyMessage {
  type: 'ready';
}

/** Union of all messages the webview can send to the extension. */
export type WebviewMessage = ReadyMessage;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Subscribe to incoming messages from the extension host and get a typed
 * `send` function for outgoing messages.
 *
 * Uses a ref for the callback so the event listener is registered once and
 * never re-subscribed — callers don't need to memoise `onMessage`.
 *
 * @param onMessage — called for each incoming `ExtensionMessage`.
 * @param sendReadyOnMount — if true, sends a `ready` message to the extension
 *   host immediately after the listener is registered (avoiding the race
 *   where the extension replies before the listener exists).
 */
export function useMessageBus(
  onMessage: (msg: ExtensionMessage) => void,
  sendReadyOnMount = false,
) {
  const vscode = useVsCodeApi();
  const onMessageRef = useRef(onMessage);

  // Keep the ref current without re-subscribing the listener.
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const data = event.data as ExtensionMessage;
      if (data && typeof data.type === 'string') {
        onMessageRef.current(data);
      }
    }

    window.addEventListener('message', handleMessage);

    // Send ready *after* the listener is in place so we never miss the reply.
    if (sendReadyOnMount) {
      vscode.postMessage({ type: 'ready' });
    }

    return () => window.removeEventListener('message', handleMessage);
    // vscode is a module-level singleton — stable across renders.
    // sendReadyOnMount is expected to be a constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Send a typed message to the extension host. */
  const send = useCallback(
    (message: WebviewMessage): void => {
      vscode.postMessage(message);
    },
    [vscode],
  );

  return { send };
}
