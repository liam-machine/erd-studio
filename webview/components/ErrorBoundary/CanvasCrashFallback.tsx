/**
 * The canvas's crash screen: {@link CrashFallback} whose buttons post
 * `crashFallback` to the host, which reloads this panel or opens Send
 * Feedback (the canvas-less flow: the in-page dialog went down with the
 * tree). Feedback carries the crash's area and its redacted first line, for
 * the report's prefill only.
 */

import { useSend } from '../../hooks/useMessageBus';
import { CrashFallback, type CaughtCrash } from './CrashFallback';

export function CanvasCrashFallback({ crash }: { crash: CaughtCrash }) {
  const send = useSend();
  return (
    <CrashFallback
      surface="canvas"
      onReload={() => send({ type: 'crashFallback', payload: { action: 'reload' } })}
      onSendFeedback={() =>
        send({
          type: 'crashFallback',
          payload: {
            action: 'feedback',
            ...(crash.area ? { area: crash.area } : {}),
            ...(crash.detail ? { detail: crash.detail } : {}),
          },
        })
      }
    />
  );
}
