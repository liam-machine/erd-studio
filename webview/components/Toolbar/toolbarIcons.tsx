/**
 * Line icons for the toolbar and the corner actions: one 16-unit stroke set
 * (the same drawing language as the detail panel's `panelIcons`), so the
 * chrome no longer mixes text glyphs, emoji and symbols.
 *
 * Inline SVG (no fonts, images or network: the webview CSP allows none),
 * drawn in `currentColor`. Decorative: each is `aria-hidden`, and the button
 * holding it keeps its own `aria-label` / `title`. `data-icon` names the
 * drawing, for tests and for CSS that needs to tell two apart.
 */

import type { ReactNode } from 'react';

interface IconProps {
  /** Rendered size in px (the drawing is on a 16-unit grid). */
  size?: number;
}

function Svg({ size = 16, name, children }: IconProps & { name: string; children: ReactNode }) {
  return (
    <svg
      className="toolbar-icon"
      data-icon={name}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconMinus = (p: IconProps) => <Svg {...p} name="minus"><path d="M3.5 8h9" /></Svg>;

export const IconPlus = (p: IconProps) => <Svg {...p} name="plus"><path d="M8 3.5v9M3.5 8h9" /></Svg>;

/** Fit: four corner brackets. */
export const IconFit = (p: IconProps) => (
  <Svg {...p} name="fit">
    <path d="M2.75 5.75v-3h3M10.25 2.75h3v3M13.25 10.25v3h-3M5.75 13.25h-3v-3" />
  </Svg>
);

export const IconUndo = (p: IconProps) => (
  <Svg {...p} name="undo">
    <path d="M5.5 3.5L2.75 6.25 5.5 9" />
    <path d="M2.75 6.25h6.5a3.5 3.5 0 0 1 0 7H6.5" />
  </Svg>
);

export const IconRedo = (p: IconProps) => (
  <Svg {...p} name="redo">
    <path d="M10.5 3.5l2.75 2.75L10.5 9" />
    <path d="M13.25 6.25h-6.5a3.5 3.5 0 0 0 0 7H9.5" />
  </Svg>
);

/** Auto layout: a small arranged grid. */
export const IconLayout = (p: IconProps) => (
  <Svg {...p} name="layout">
    <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2" />
    <rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2" />
    <rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2" />
    <rect x="9" y="9" width="4.5" height="4.5" rx="1.2" />
  </Svg>
);

/** Re-run layout (options changed): a circular arrow. */
export const IconRelayout = (p: IconProps) => (
  <Svg {...p} name="relayout">
    <path d="M12.75 8a4.75 4.75 0 1 1-1.4-3.36" />
    <path d="M12.5 2.75v2.5H10" />
  </Svg>
);

/** Refresh dbt data: two arrows chasing round. */
export const IconRefresh = (p: IconProps) => (
  <Svg {...p} name="refresh">
    <path d="M12.9 6.25A5 5 0 0 0 3.6 5.1" />
    <path d="M3.1 9.75a5 5 0 0 0 9.3 1.15" />
    <path d="M3.25 2.75v2.6h2.6M12.75 13.25v-2.6h-2.6" />
  </Svg>
);

/** Select mode: a dashed marquee with a pointer. */
export const IconMarquee = (p: IconProps) => (
  <Svg {...p} name="marquee">
    <path d="M2.5 5V3.5a1 1 0 0 1 1-1H5M7.25 2.5h1.5M11 2.5h1.5a1 1 0 0 1 1 1V5M2.5 7.25v1.5M2.5 11v1.5a1 1 0 0 0 1 1H5M7.25 13.5H8" />
    <path d="M9.5 9.5l4.25 1.6-1.85.75-.75 1.85z" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => <Svg {...p} name="chevron-down"><path d="M4.25 6.25L8 10l3.75-3.75" /></Svg>;

/** Compare stages: two panes side by side. */
export const IconCompare = (p: IconProps) => (
  <Svg {...p} name="compare">
    <rect x="2.5" y="3" width="11" height="10" rx="2" />
    <path d="M8 3v10" />
    <path d="M4.75 6.5h1.25M4.75 9h1.25M10 6.5h1.25M10 9h1.25" />
  </Svg>
);

/** Export: an arrow down into a tray. */
export const IconExport = (p: IconProps) => (
  <Svg {...p} name="export">
    <path d="M8 2.75v7M5 7l3 3 3-3" />
    <path d="M2.75 10.5v1.75a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1V10.5" />
  </Svg>
);

/** Feedback: an outlined speech bubble. */
export const IconFeedback = (p: IconProps) => (
  <Svg {...p} name="feedback">
    <path d="M3.5 3h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.25L4.5 13.25V11h-1a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
  </Svg>
);

/** Open the file: a page with code brackets. */
export const IconFile = (p: IconProps) => (
  <Svg {...p} name="file">
    <path d="M9.25 2.5H4.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.75z" />
    <path d="M9.25 2.5v3.25h3.25" />
    <path d="M6.75 8.25L5.5 9.5l1.25 1.25M9.25 8.25l1.25 1.25-1.25 1.25" />
  </Svg>
);

/** More actions: three dots. */
export const IconMore = (p: IconProps) => (
  <Svg {...p} name="more">
    <circle cx="3.75" cy="8" r="0.6" fill="currentColor" />
    <circle cx="8" cy="8" r="0.6" fill="currentColor" />
    <circle cx="12.25" cy="8" r="0.6" fill="currentColor" />
  </Svg>
);

/** View options (shown on a narrow editor): sliders. */
export const IconView = (p: IconProps) => (
  <Svg {...p} name="view">
    <path d="M2.75 5h1.65M7.6 5h5.65M2.75 11h6.15M12.1 11h1.15" />
    <circle cx="6" cy="5" r="1.6" />
    <circle cx="10.5" cy="11" r="1.6" />
  </Svg>
);
