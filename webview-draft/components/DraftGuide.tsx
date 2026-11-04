/**
 * Phase A of the onboarding guide (Show Me Around) on the draft page: the
 * banner, More ways to start, and the control that keeps the draft — the
 * last step waits for that click (no Next). Steps and text come from the
 * pure `draftGuideSteps` (the user's own source, tables and relationships);
 * the page posts only `{ type: 'guide', action: 'step' | 'skip' }`. Hidden
 * while the host works (Saving…, Drawing…), back if a Keep did not save.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { DraftToHost, DraftView } from '../../src/types/draft';
import {
  GUIDE_LABELS,
  draftGuideSteps,
  guideProgress,
  guideTargetSelector,
  type GuideStep,
} from '../../src/types/onboardingGuide';
import { CoachMark } from '../../webview/components/Guide/CoachMark';
import type { GuideRect } from '../../webview/components/Guide/coachMarkPlacement';

export interface DraftGuideProps {
  view: DraftView;
  nothingFound?: boolean;
  semanticDir?: string;
  /** The host is working on an answer: the guide steps aside until it is back. */
  hidden: boolean;
  post(message: DraftToHost): void;
  /** Skip guide (or Esc): the page stops showing it. */
  onEnd(): void;
}

function anchorRect(step: GuideStep): GuideRect | null {
  if (step.anchor.kind !== 'target') return null;
  for (const target of step.anchor.targets) {
    const el = document.querySelector(guideTargetSelector(target));
    if (el) {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }
  }
  return null;
}

/** The banner, its buttons and switcher included: a callout never covers what the step asks you to press. */
function bannerRects(): GuideRect[] {
  const banner = document.querySelector('.draft-banner');
  if (!banner) return [];
  const r = banner.getBoundingClientRect();
  return r.width > 0 || r.height > 0 ? [{ left: r.left, top: r.top, width: r.width, height: r.height }] : [];
}

export function DraftGuide({ view, nothingFound, semanticDir, hidden, post, onEnd }: DraftGuideProps) {
  const steps = useMemo(
    () => draftGuideSteps({ view, ...(nothingFound ? { nothingFound } : {}), ...(semanticDir !== undefined ? { semanticDir } : {}) }),
    [view, nothingFound, semanticDir],
  );
  const [index, setIndex] = useState(0);
  const at = Math.min(index, steps.length - 1);
  const step = steps[at];

  useEffect(() => {
    if (step) post({ type: 'guide', action: 'step', step: step.id });
  }, [step?.id, post]); // eslint-disable-line react-hooks/exhaustive-deps

  const skip = useCallback(() => {
    post({ type: 'guide', action: 'skip' });
    onEnd();
  }, [post, onEnd]);

  if (!step || hidden) return null;
  return (
    <CoachMark
      stepKey={step.id}
      title={step.title}
      text={step.text}
      progress={guideProgress(at, steps.length)}
      resolveAnchor={() => anchorRect(step)}
      avoid={bannerRects}
      {...(at > 0 ? { onBack: () => setIndex(at - 1) } : {})}
      {...(step.waitsForClick ? {} : { next: { label: GUIDE_LABELS.next, onClick: () => setIndex(at + 1) } })}
      backLabel={GUIDE_LABELS.back}
      skipLabel={GUIDE_LABELS.skip}
      onSkip={skip}
      onEscape={skip}
    />
  );
}
