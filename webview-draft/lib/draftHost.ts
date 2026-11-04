/**
 * The draft page's one way to the host: the page's only `acquireVsCodeApi()`
 * call (it may run once per page), behind a typed `post` that sends only
 * `DraftToHost` messages. The host validates every one again
 * (`parseDraftToHost`).
 */

import type { DraftToHost } from '../../src/types/draft';

export interface DraftHost {
  post(message: DraftToHost): void;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
}

let api: VsCodeApi | undefined;

/** The page's host, acquiring VS Code's API on first use. */
export function getDraftHost(): DraftHost {
  return {
    post(message) {
      if (!api) {
        const acquire = (globalThis as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi;
        if (typeof acquire !== 'function') return;
        api = acquire();
      }
      api.postMessage(message);
    },
  };
}
