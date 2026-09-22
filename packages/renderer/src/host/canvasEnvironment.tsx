/**
 * The canvas's link to whatever page embeds it.
 *
 * Canvas components never talk to their host directly. Edits made on the
 * canvas (renaming a column, moving an annotation, …) are posted as
 * `CanvasEditMessage`s to the `CanvasHost` supplied by the nearest
 * `CanvasEnvironmentProvider`. The VS Code extension supplies a host that
 * forwards them to the extension; without a provider, messages go nowhere.
 *
 * The environment also carries the `viewer` flag, which read-only embeddings
 * set to present the canvas without its editing affordances.
 */

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { CanvasEditMessage } from '@erd-studio/core';

/** Receives the edits made on the canvas. */
export interface CanvasHost {
  postMessage(message: CanvasEditMessage): void;
}

export interface CanvasEnvironment {
  host: CanvasHost;
  /** Read-only viewer presentation (no editing affordances). */
  viewer: boolean;
}

/** A host that drops every message. */
export const NOOP_CANVAS_HOST: CanvasHost = {
  postMessage: () => {},
};

const DEFAULT_ENVIRONMENT: CanvasEnvironment = { host: NOOP_CANVAS_HOST, viewer: false };

const CanvasEnvironmentContext = createContext<CanvasEnvironment>(DEFAULT_ENVIRONMENT);

export function CanvasEnvironmentProvider({
  host = NOOP_CANVAS_HOST,
  viewer = false,
  children,
}: {
  host?: CanvasHost;
  viewer?: boolean;
  children: ReactNode;
}): JSX.Element {
  const value = useMemo<CanvasEnvironment>(() => ({ host, viewer }), [host, viewer]);
  return <CanvasEnvironmentContext.Provider value={value}>{children}</CanvasEnvironmentContext.Provider>;
}

/** The host edits are posted to (a no-op host outside any provider). */
export function useCanvasHost(): CanvasHost {
  return useContext(CanvasEnvironmentContext).host;
}

/** A stable function that posts an edit to the host. */
export function useSend(): (message: CanvasEditMessage) => void {
  const host = useCanvasHost();
  return useCallback(
    (message: CanvasEditMessage): void => {
      host.postMessage(message);
    },
    [host],
  );
}

/** Whether the canvas is in read-only viewer mode (false outside any provider). */
export function useIsViewer(): boolean {
  return useContext(CanvasEnvironmentContext).viewer;
}
