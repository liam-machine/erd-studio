/**
 * Phase B of the onboarding guide (Show Me Around) on the canvas: a real
 * table, a real relationship, the toolbar's + Add and Layout, the Logical /
 * Physical switch (a dbt project only), the sidebar, the files and the AI
 * helper, and the finish with Star on GitHub. The steps and their text come
 * from the pure `canvasGuideSteps`, built once from the diagram on show when
 * it has settled (its first-open layout done), naming the user's tables.
 *
 * Wrapped around the editor, never inside `@erd-studio/renderer`: the viewer
 * path is untouched. It posts only `guide` messages with a fixed action id
 * (`GUIDE_ACTIONS`); the host maps each to its fixed command or URL.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';

import {
  GUIDE_LABELS,
  canvasGuideSteps,
  guideProgress,
  guideTargetSelector,
  type CanvasGuideStart,
  type GuideAction,
  type GuideStep,
} from '../../../src/types/onboardingGuide';
import { useSend } from '../../hooks/useMessageBus';
import { useEditorStore } from '../../store/editorStore';
import { CoachMark } from './CoachMark';
import { pickAnchor, type GuideRect } from './coachMarkPlacement';

/** How long the canvas settles (first-open layout, its fit) before the first step. */
export const CANVAS_GUIDE_SETTLE_MS = 900;

export interface CanvasGuideProps {
  start: CanvasGuideStart;
  /** The guide ended (Done, Star on GitHub, Skip guide, Esc): stop showing it. */
  onEnd(): void;
}

const quote = (value: string): string => value.replace(/["\\]/g, '\\$&');

function rectOf(el: Element | null | undefined): GuideRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function tableElement(table: string): Element | null {
  return document.querySelector(`.react-flow__node[data-id="${quote(table)}"]`);
}

function relationshipElement(from: string, to: string): Element | null {
  const edge = useEditorStore.getState().edges.find((e) => {
    const d = e.data as { fromModel?: string; toModel?: string } | undefined;
    return e.type === 'fk' && d !== undefined
      && ((d.fromModel === from && d.toModel === to) || (d.fromModel === to && d.toModel === from));
  });
  if (!edge) return null;
  const g = document.querySelector(`.react-flow__edge[data-id="${quote(edge.id)}"]`);
  return g?.querySelector('.react-flow__edge-path') ?? g;
}

/** The canvas area (the flow), for what is "in view" and the sidebar step's left edge. */
function flowRect(): GuideRect | null {
  return rectOf(document.querySelector('.editor-canvas .react-flow') ?? document.querySelector('.react-flow'));
}

function inside(inner: GuideRect, outer: GuideRect): boolean {
  return inner.left >= outer.left && inner.top >= outer.top
    && inner.left + inner.width <= outer.left + outer.width && inner.top + inner.height <= outer.top + outer.height;
}

/** The anchor's rect now, or null (a centred card). */
export function canvasAnchorRect(step: GuideStep): GuideRect | null {
  const { anchor } = step;
  switch (anchor.kind) {
    case 'target':
      return pickAnchor(
        anchor.targets.map((target) => rectOf(document.querySelector(guideTargetSelector(target)))),
        { width: window.innerWidth, height: window.innerHeight },
      );
    case 'table':
      return rectOf(tableElement(anchor.table));
    case 'relationship':
      return rectOf(relationshipElement(anchor.from, anchor.to));
    case 'leftEdge': {
      const area = flowRect();
      return area ? { left: area.left, top: area.top + area.height / 2 - 20, width: 1, height: 40 } : null;
    }
    case 'none':
      return null;
  }
}

/** The toolbar and its corner actions: a callout never covers them. */
function toolbarRects(): GuideRect[] {
  return [...document.querySelectorAll('.toolbar-container, .toolbar__corner')]
    .map((el) => rectOf(el))
    .filter((r): r is GuideRect => r !== null && (r.width > 0 || r.height > 0));
}

/** The tables whose nodes are wholly in view now. */
function visibleTables(names: readonly string[]): string[] {
  const area = flowRect();
  if (!area || area.width <= 0) return [];
  return names.filter((name) => {
    const r = rectOf(tableElement(name));
    return r !== null && r.width > 0 && inside(r, area);
  });
}

export function CanvasGuide({ start, onEnd }: CanvasGuideProps) {
  const send = useSend();
  const { fitView } = useReactFlow();
  const domain = useEditorStore((s) => s.domain);
  const logicalOnly = useEditorStore((s) => s.logicalOnly);
  const pendingAutoLayout = useEditorStore((s) => s.pendingAutoLayout);
  const nodeCount = useEditorStore((s) => s.nodes.length);
  const [steps, setSteps] = useState<GuideStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const revealed = useRef(false);

  const ready = domain !== null && !pendingAutoLayout && (nodeCount > 0 || domain.models.length === 0);

  // Build the steps once, from the diagram as it settled (the tables in view first).
  useEffect(() => {
    if (!ready || steps !== null || !domain) return;
    const timer = window.setTimeout(() => {
      const current = useEditorStore.getState().domain ?? domain;
      setSteps(canvasGuideSteps({
        display: current,
        hasDbt: !useEditorStore.getState().logicalOnly,
        dbml: start.dbml,
        semanticDir: start.semanticDir,
        visibleTables: visibleTables(current.models.map((m) => m.name)),
      }));
    }, CANVAS_GUIDE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [ready, steps, domain, start, logicalOnly]);

  const post = useCallback((action: GuideAction, extra: { step?: GuideStep['id'] } = {}) => {
    send({ type: 'guide', payload: { action, ...extra } });
  }, [send]);

  const step = steps ? steps[Math.min(index, steps.length - 1)] : undefined;

  // Each step: logged on the host; the sidebar step reveals the sidebar; a
  // table or relationship out of view is brought into view.
  useEffect(() => {
    if (!step) return;
    post('step', { step: step.id });
    if (step.onShow === 'revealSidebar' && !revealed.current) {
      revealed.current = true;
      post('revealSidebar');
    }
    const ids = step.anchor.kind === 'table'
      ? [step.anchor.table]
      : step.anchor.kind === 'relationship' ? [step.anchor.from, step.anchor.to] : [];
    const area = flowRect();
    if (ids.length > 0 && area && area.width > 0) {
      const hidden = ids.some((id) => {
        const r = rectOf(tableElement(id));
        return !r || r.width <= 0 || !inside(r, area);
      });
      if (hidden) void fitView({ nodes: ids.map((id) => ({ id })), padding: 0.4, maxZoom: 1, duration: 300 });
    }
  }, [step?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const end = useCallback((action: 'skip' | 'complete' | 'star') => {
    post(action);
    onEnd();
  }, [post, onEnd]);

  const progress = useMemo(() => (steps && step ? guideProgress(steps.indexOf(step), steps.length) : ''), [steps, step]);

  if (!steps || !step) return null;
  const at = steps.indexOf(step);
  const buttons = (step.buttons ?? []).map((b) => (b.action === 'star'
    ? { label: b.label, primary: true, star: true, onClick: () => end('star') }
    : { label: b.label, onClick: () => post('aiHelper') }));

  return (
    <CoachMark
      stepKey={step.id}
      title={step.title}
      text={step.text}
      {...(step.note ? { note: step.note } : {})}
      progress={progress}
      resolveAnchor={() => canvasAnchorRect(step)}
      avoid={toolbarRects}
      {...(step.anchor.kind === 'leftEdge' ? { prefer: 'right' as const, ring: false } : {})}
      {...(at > 0 ? { onBack: () => setIndex(at - 1) } : {})}
      next={step.finish
        ? { label: GUIDE_LABELS.done, onClick: () => end('complete'), quiet: true }
        : { label: GUIDE_LABELS.next, onClick: () => setIndex(at + 1) }}
      buttons={buttons}
      backLabel={GUIDE_LABELS.back}
      skipLabel={GUIDE_LABELS.skip}
      onSkip={() => end('skip')}
      onEscape={() => end(step.finish ? 'complete' : 'skip')}
    />
  );
}
