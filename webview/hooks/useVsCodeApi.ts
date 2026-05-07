/**
 * Singleton wrapper around VS Code's `acquireVsCodeApi()`.
 *
 * `acquireVsCodeApi()` can only be called once per webview lifecycle — subsequent
 * calls throw. This module calls it once at import time and exports the instance
 * for reuse across components.
 */

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

const vscodeApi: VsCodeApi = (window as any).acquireVsCodeApi();

/** Returns the singleton VS Code API instance. */
export function useVsCodeApi(): VsCodeApi {
  return vscodeApi;
}

export type { VsCodeApi };
