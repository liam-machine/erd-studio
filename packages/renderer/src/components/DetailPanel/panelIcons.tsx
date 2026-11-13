/**
 * Small line icons for the detail panel and its column rows.
 *
 * Inline SVG (no fonts, images or network: the webview CSP allows none),
 * drawn in `currentColor` so every icon takes its button's text colour and
 * follows the theme. Decorative: each is `aria-hidden`, and the button that
 * holds it keeps its own `aria-label` / `title`. An icon has no text, so a
 * button's `textContent` is only the words beside it.
 */

import type { ReactNode } from 'react';

interface IconProps {
  /** Rendered size in px (the drawing is on a 16-unit grid). */
  size?: number;
  className?: string;
}

function Svg({ size = 14, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className ? `panel-icon ${className}` : 'panel-icon'}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function IconClose(props: IconProps) {
  return <Svg {...props}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></Svg>;
}

export function IconPencil(props: IconProps) {
  return <Svg {...props}><path d="M10.6 2.9l2.5 2.5-7.4 7.4-3.2.7.7-3.2z" /><path d="M9.3 4.2l2.5 2.5" /></Svg>;
}

/** Points right; a disclosure rotates it a quarter turn when open. */
export function IconChevron(props: IconProps) {
  return <Svg {...props}><path d="M6.25 3.75L10.5 8l-4.25 4.25" /></Svg>;
}

export function IconPlus(props: IconProps) {
  return <Svg {...props}><path d="M8 3.25v9.5M3.25 8h9.5" /></Svg>;
}

export function IconExpandAll(props: IconProps) {
  return <Svg {...props}><path d="M4.5 3.75L8 7l3.5-3.25M4.5 9L8 12.25 11.5 9" /></Svg>;
}

export function IconCollapseAll(props: IconProps) {
  return <Svg {...props}><path d="M4.5 7L8 3.75 11.5 7M4.5 12.25L8 9l3.5 3.25" /></Svg>;
}

/** Open in the editor: an arrow out of a box. */
export function IconOpen(props: IconProps) {
  return <Svg {...props}><path d="M9.25 2.75h4v4M13.25 2.75L8 8M11.5 9.5v3.25a.5.5 0 01-.5.5H3.25a.5.5 0 01-.5-.5V5a.5.5 0 01.5-.5H6.5" /></Svg>;
}

/** A column's description is set: three lines of text. */
export function IconNote(props: IconProps) {
  return <Svg {...props}><path d="M3.5 4.5h9M3.5 8h9M3.5 11.5h5.5" /></Svg>;
}

/** The six-dot grip of a draggable row. */
export function IconGrip({ size = 14, className }: IconProps) {
  return (
    <svg
      className={className ? `panel-icon ${className}` : 'panel-icon'}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="6" cy="4" r="1.1" />
      <circle cx="10" cy="4" r="1.1" />
      <circle cx="6" cy="8" r="1.1" />
      <circle cx="10" cy="8" r="1.1" />
      <circle cx="6" cy="12" r="1.1" />
      <circle cx="10" cy="12" r="1.1" />
    </svg>
  );
}

/** A table outline: the empty state of a column list. */
export function IconTable(props: IconProps) {
  return <Svg {...props}><rect x="2.5" y="3" width="11" height="10" rx="2" /><path d="M2.5 6.5h11M6.5 6.5V13" /></Svg>;
}
