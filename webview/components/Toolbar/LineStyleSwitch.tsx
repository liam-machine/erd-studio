/**
 * LineStyleSwitch — the toolbar's two-option control for how relationship
 * lines are drawn: Curved or Hops (`erdStudio.canvas.lineStyle`).
 *
 * A view preference, not an edit: shown on every stage and on read-only
 * diagrams. A click switches the canvas at once (the store's `lineStyle`) and
 * posts `setLineStyle`, which writes the user setting; the host then tells
 * every open canvas the value (`lineStyle`), so they all follow.
 */

import { useCallback } from 'react';
import { LINE_STYLES, type LineStyle } from '@erd-studio/renderer/editor';

import { useEditorStore } from '../../store/editorStore';
import { useSend } from '../../hooks/useMessageBus';
import './LineStyleSwitch.css';

/** Each option's label and hover text. */
export const LINE_STYLE_LABELS: Record<LineStyle, { label: string; title: string }> = {
  curved: { label: 'Curved', title: 'Curved lines: soft curves that go around tables' },
  hops: { label: 'Hops', title: 'Square lines that go around tables, with a small hop where two lines cross' },
};

export function LineStyleSwitch() {
  const lineStyle = useEditorStore((s) => s.lineStyle);
  const setLineStyle = useEditorStore((s) => s.setLineStyle);
  const send = useSend();

  const choose = useCallback(
    (style: LineStyle) => {
      if (style === useEditorStore.getState().lineStyle) return;
      setLineStyle(style);
      send({ type: 'setLineStyle', payload: { lineStyle: style } });
    },
    [setLineStyle, send],
  );

  return (
    <div className="line-style-switch" role="radiogroup" aria-label="Line style">
      {LINE_STYLES.map((style) => {
        const on = style === lineStyle;
        return (
          <button
            key={style}
            type="button"
            role="radio"
            aria-checked={on}
            className={`line-style-switch__option${on ? ' line-style-switch__option--on' : ''}`}
            title={LINE_STYLE_LABELS[style].title}
            onClick={() => choose(style)}
          >
            {LINE_STYLE_LABELS[style].label}
          </button>
        );
      })}
    </div>
  );
}
