/**
 * useFirstOpenAutoLayout — run the ELK auto layout once when the host flags a
 * domain with no stored position (`domainLoaded.autoLayout`: models, but not
 * one stored position — typically a domain an AI assistant just wrote with
 * `viewConfig: {}`).
 *
 * The host sends its simple fallback placement with that payload and writes
 * nothing; this hook hands the canvas to the same `runLayout` the Layout
 * button and Shift+L use, and the viewport is fitted. Opening a diagram never
 * writes a file, so the result goes back as an `updatePositions` with
 * `unsaved`: the host holds it as what this canvas draws, draws it again on
 * every refresh (no second layout), and the user's first edit of the layout
 * saves it. Only when the host says the layout is the user's own doing
 * (`domainLoaded.saveLayout`, kept as `pendingAutoLayoutSaves`: they just
 * created the diagram, or added tables to an empty one) is it posted plainly
 * and saved, one edit and one undo step. A layout ELK cannot finish (a
 * timeout, the worker dying, a stack overflow, …) falls back to the grid's
 * tidy columns, which are sent the same way (#294). Only if even the grid
 * fails is nothing sent: the layout's toast says so in plain words and the
 * next load asks again.
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
import type { DisplaySubjectArea } from '../../src/types/display';

interface NodeLike {
  id: string;
  type?: string;
}

export function useFirstOpenAutoLayout(
  runLayout: (firstOpen: boolean, save: boolean) => Promise<void> | void,
  domain: DisplaySubjectArea | null,
  nodes: readonly NodeLike[],
  isLayouting: boolean,
): void {
  const pending = useEditorStore((s) => s.pendingAutoLayout);
  const saves = useEditorStore((s) => s.pendingAutoLayoutSaves);
  const setPendingAutoLayout = useEditorStore((s) => s.setPendingAutoLayout);
  const inFlight = useRef(false);

  const graphReady =
    !!domain &&
    domain.stage === 'logical' &&
    domain.models.length > 0 &&
    hasNodeForEveryTable(domain, nodes);

  useEffect(() => {
    if (!pending || !graphReady || isLayouting || inFlight.current) {
      return;
    }
    setPendingAutoLayout(false);
    inFlight.current = true;
    Promise.resolve(runLayout(true, saves))
      .catch((err) => console.error('[useFirstOpenAutoLayout] auto layout failed:', err))
      .finally(() => {
        inFlight.current = false;
      });
  }, [pending, saves, graphReady, isLayouting, runLayout, setPendingAutoLayout]);
}

function hasNodeForEveryTable(domain: DisplaySubjectArea, nodes: readonly NodeLike[]): boolean {
  const modelNodeIds = new Set(nodes.filter((n) => n.type === 'model').map((n) => n.id));
  return domain.models.every((m) => modelNodeIds.has(m.name));
}
