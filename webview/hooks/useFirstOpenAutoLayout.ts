/**
 * useFirstOpenAutoLayout — run the ELK auto layout once when the host flags a
 * freshly written domain (`domainLoaded.autoLayout`: models, but not one stored
 * position — typically a domain an AI assistant just wrote with
 * `viewConfig: {}`).
 *
 * The host sends its simple fallback placement with that payload and does not
 * persist it; this hook hands the canvas to the same `runLayout` the Layout
 * button and Shift+L use, so the result is persisted by one `updatePositions`
 * (one edit, one undo step) and the viewport is fitted. If ELK fails, the
 * layout's own toast shows and nothing is written — the next open asks again.
 *
 * Guards:
 *  - it waits until the canvas holds a model node for every model in the
 *    domain (the graph is rebuilt in an effect one commit after `setDomain`,
 *    so the nodes can briefly belong to the previous payload);
 *  - it clears `pendingAutoLayout` in the store BEFORE starting, so a
 *    re-render or a StrictMode double effect cannot start a second run;
 *  - a ref blocks a new run while one is in flight;
 *  - every later `domainLoaded` / `stageData` overwrites the flag, so a
 *    payload without it cancels a layout that has not started yet.
 */
import { useEffect, useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import type { DisplayDomain } from '../../src/types/display';

interface NodeLike {
  id: string;
  type?: string;
}

export function useFirstOpenAutoLayout(
  runLayout: () => Promise<void> | void,
  domain: DisplayDomain | null,
  nodes: readonly NodeLike[],
  isLayouting: boolean,
): void {
  const pending = useEditorStore((s) => s.pendingAutoLayout);
  const setPendingAutoLayout = useEditorStore((s) => s.setPendingAutoLayout);
  const inFlight = useRef(false);

  const graphReady =
    !!domain &&
    domain.stage === 'logical' &&
    domain.models.length > 0 &&
    hasNodeForEveryModel(domain, nodes);

  useEffect(() => {
    if (!pending || !graphReady || isLayouting || inFlight.current) {
      return;
    }
    setPendingAutoLayout(false);
    inFlight.current = true;
    Promise.resolve(runLayout())
      .catch((err) => console.error('[useFirstOpenAutoLayout] auto layout failed:', err))
      .finally(() => {
        inFlight.current = false;
      });
  }, [pending, graphReady, isLayouting, runLayout, setPendingAutoLayout]);
}

function hasNodeForEveryModel(domain: DisplayDomain, nodes: readonly NodeLike[]): boolean {
  const modelNodeIds = new Set(nodes.filter((n) => n.type === 'model').map((n) => n.id));
  return domain.models.every((m) => modelNodeIds.has(m.name));
}
