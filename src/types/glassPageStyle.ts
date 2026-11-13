/**
 * The glass look for the STANDALONE pages: the webview panels that are one
 * self-contained HTML string with an inline nonce'd `<style>` and a
 * nonce-only CSP (Getting Started, the import guide, the import report, the
 * Convert to DBML review). They cannot link `dist/webview.css`, so this module
 * carries the editor's glass tokens and a small shared kit as plain strings.
 *
 * Pure strings: no imports (no `vscode`, no Node built-ins, no React), because
 * some of these services are bundled into the CLI. It lives in `src/types/`
 * because Getting Started's page is built there, and `src/types/` never
 * imports from `src/services/`.
 *
 * How a page uses it
 * ------------------
 *   import { GLASS_PAGE_STYLE } from '../types/glassPageStyle';
 *   const STYLE = GLASS_PAGE_STYLE + String.raw`
 *     .my-page__thing { ... }   // page CSS after, so it wins ties
 *   `;
 *   <style nonce="${nonce}">${STYLE}</style>
 *
 * - Put GLASS_PAGE_STYLE FIRST in the page's one `<style>`. Nothing else is
 *   needed: no stylesheet link, no font, no image, so the CSP is unchanged.
 * - Leave `body` without a background of its own: `html` paints the editor
 *   background and a fixed `body::before` paints the ambient wash behind the
 *   content (a body background would cover the wash). Content needs no
 *   z-index.
 * - Colour only from these tokens (or `--vscode-*`), never a literal. The
 *   tokens already handle light, both high-contrast themes, reduced
 *   transparency and reduced motion, so page CSS never special-cases a theme
 *   for colour.
 * - Theme-dependent tokens (surfaces, borders, shadows, tints, text tiers,
 *   control fills, the wash) are declared on `body`, as in theme.css, so
 *   `body.vscode-light` / `body.vscode-high-contrast` can redefine them. Use
 *   them on body or anything inside it, not on `html`.
 * - Kit classes are `gp-` prefixed BEM and listed in GLASS_PAGE_BASE below.
 *   Page CSS adds its own `pagename-` classes beside them.
 *
 * GLASS_PAGE_TOKENS mirrors packages/renderer/src/styles/theme.css: same
 * names, same values, same selectors. test/unit/glassPageStyle.test.ts fails
 * if a token here drifts from theme.css, so change theme.css first and copy
 * the change here.
 */

/**
 * The glass design tokens, copied from theme.css (the aliases the glass layer
 * derives from, the scales, the theme-dependent glass tokens and every theme /
 * accessibility override of them). No selectors other than theme.css's own.
 */
export const GLASS_PAGE_TOKENS = String.raw`
*,
*::before,
*::after {
  box-sizing: border-box;
}

/* Aliases of the VS Code theme (theme.css "editor surfaces"). */
:root {
  --editor-bg: var(--vscode-editor-background);
  --editor-fg: var(--vscode-editor-foreground);
  --panel-bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
  --panel-border: var(--vscode-panel-border, var(--vscode-editorGroup-border, #444));
  --button-bg: var(--vscode-button-background);
  --button-fg: var(--vscode-button-foreground);
  --button-hover-bg: var(--vscode-button-hoverBackground);
  --input-bg: var(--vscode-input-background);
  --input-fg: var(--vscode-input-foreground);
  --input-border: var(--vscode-input-border, transparent);
  --focus-border: var(--vscode-focusBorder);
  --selection-bg: var(--vscode-editor-selectionBackground);
  --error-fg: var(--vscode-errorForeground);
  --warning-fg: var(--vscode-editorWarning-foreground, #cca700);
  --ok-fg:      var(--vscode-charts-green, #2f8a48);
  --ai-fg:      var(--vscode-charts-purple, #b48ce8);
  --dim-fg:     var(--vscode-descriptionForeground, #8a94a3);
  --stage-logical:       #60a5fa;
  --stage-physical:       #22c55e;
  --stage-ghost:    #9ca3af;
  --model-approved:      #14b8a6;
}

/* Theme-independent scales. */
:root {
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 18px;
  --radius-pill: 999px;

  --space-0: 0;
  --space-1: 2px;
  --space-2: 4px;
  --space-3: 6px;
  --space-4: 8px;
  --space-5: 12px;
  --space-6: 16px;
  --space-7: 20px;
  --space-8: 24px;
  --space-9: 32px;

  --font-ui: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif);
  --font-mono: var(--vscode-editor-font-family, ui-monospace, 'SF Mono', Menlo, Consolas, monospace);
  --text-2xs: 10px;
  --text-xs: 11px;
  --text-sm: 12px;
  --text-md: 13px;
  --text-lg: 15px;
  --text-xl: 18px;
  --weight-regular: 400;
  --weight-medium: 500;
  --weight-semibold: 600;
  --weight-bold: 700;
  --leading-tight: 1.25;
  --leading-normal: 1.45;
  --tracking-tight: -0.01em;
  --tracking-normal: 0;
  --tracking-caps: 0.06em;

  --duration-instant: 80ms;
  --duration-fast: 140ms;
  --duration-base: 220ms;
  --duration-slow: 360ms;
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.4, 0, 1, 1);
  --ease-spring: cubic-bezier(0.34, 1.32, 0.64, 1);

  --z-popover: 100;
  --z-modal: 200;
  --z-menu: 1000;
  --z-toast: 1000;
  --z-tooltip: 10000;

  --focus-ring-color: var(--focus-border);
  --focus-outline: 2px solid var(--focus-ring-color);
  --focus-offset: 2px;
}

/* Theme-dependent glass tokens (on body, so the theme classes can redefine them). */
body {
  --glass-tone: color-mix(in srgb, var(--editor-bg) 88%, white 12%);
  --glass-surface-1: color-mix(in srgb, var(--glass-tone) 55%, transparent);
  --glass-surface-2: color-mix(in srgb, var(--glass-tone) 70%, transparent);
  --glass-surface-3: color-mix(in srgb, var(--glass-tone) 84%, transparent);
  --glass-surface-solid: var(--glass-tone);
  --glass-well: color-mix(in srgb, var(--editor-fg) 5%, transparent);

  --glass-blur: 24px;
  --glass-saturate: 180%;
  --glass-backdrop: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  --glass-backdrop-thin: blur(12px) saturate(160%);

  --glass-border: color-mix(in srgb, var(--editor-fg) 13%, transparent);
  --glass-border-strong: color-mix(in srgb, var(--editor-fg) 22%, transparent);
  --glass-divider: color-mix(in srgb, var(--editor-fg) 9%, transparent);
  --glass-highlight: inset 0 1px 0 0 color-mix(in srgb, white 7%, transparent);

  --glass-shadow-sm:
    0 1px 2px color-mix(in srgb, black 28%, transparent),
    0 4px 12px -4px color-mix(in srgb, black 30%, transparent);
  --glass-shadow-md:
    0 2px 6px -1px color-mix(in srgb, black 24%, transparent),
    0 12px 32px -8px color-mix(in srgb, black 45%, transparent);
  --glass-shadow-lg:
    0 4px 12px -2px color-mix(in srgb, black 26%, transparent),
    0 28px 72px -16px color-mix(in srgb, black 60%, transparent);
  --glass-elevation-1: var(--glass-highlight), var(--glass-shadow-sm);
  --glass-elevation-2: var(--glass-highlight), var(--glass-shadow-md);
  --glass-elevation-3: var(--glass-highlight), var(--glass-shadow-lg);

  --glass-tint-logical: color-mix(in srgb, var(--stage-logical) 14%, transparent);
  --glass-tint-logical-strong: color-mix(in srgb, var(--stage-logical) 26%, transparent);
  --glass-tint-logical-edge: color-mix(in srgb, var(--stage-logical) 45%, transparent);
  --glass-tint-physical: color-mix(in srgb, var(--stage-physical) 14%, transparent);
  --glass-tint-physical-strong: color-mix(in srgb, var(--stage-physical) 26%, transparent);
  --glass-tint-physical-edge: color-mix(in srgb, var(--stage-physical) 45%, transparent);
  --glass-tint-ghost: color-mix(in srgb, var(--stage-ghost) 14%, transparent);
  --glass-tint-accent: color-mix(in srgb, var(--accent) 16%, transparent);
  --glass-tint-accent-strong: color-mix(in srgb, var(--accent) 28%, transparent);
  --glass-tint-warning: color-mix(in srgb, var(--warning-fg) 14%, transparent);
  --glass-tint-warning-edge: color-mix(in srgb, var(--warning-fg) 38%, transparent);
  --glass-tint-error: color-mix(in srgb, var(--error-fg) 14%, transparent);
  --glass-tint-error-edge: color-mix(in srgb, var(--error-fg) 40%, transparent);
  --glass-tint-ok: color-mix(in srgb, var(--ok-fg) 14%, transparent);
  --glass-tint-ai: color-mix(in srgb, var(--ai-fg) 14%, transparent);

  --accent: var(--vscode-button-background, var(--focus-border));
  --accent-fg: var(--vscode-button-foreground, var(--editor-fg));
  --accent-hover: var(--vscode-button-hoverBackground, var(--accent));

  --control-fill: color-mix(in srgb, var(--editor-fg) 6%, transparent);
  --control-fill-hover: color-mix(in srgb, var(--editor-fg) 11%, transparent);
  --control-fill-active: color-mix(in srgb, var(--editor-fg) 16%, transparent);
  --control-fill-selected: color-mix(in srgb, var(--accent) 24%, transparent);
  --control-fg-selected: var(--editor-fg);
  --control-border: transparent;
  --control-border-hover: transparent;
  --control-border-selected: color-mix(in srgb, var(--accent) 45%, transparent);
  --control-thumb: color-mix(in srgb, var(--glass-tone) 92%, white 8%);
  --control-thumb-shadow: 0 1px 2px color-mix(in srgb, black 30%, transparent), 0 0 0 0.5px color-mix(in srgb, black 20%, transparent);
  --control-height: 28px;
  --control-height-sm: 24px;
  --control-height-lg: 32px;

  --glass-input-bg: color-mix(in srgb, var(--input-bg) 72%, transparent);
  --glass-input-border: var(--glass-border);
  --glass-input-border-focus: var(--focus-border);

  --text-primary: var(--editor-fg);
  --text-secondary: color-mix(in srgb, var(--editor-fg) 78%, transparent);
  --text-tertiary: color-mix(in srgb, var(--editor-fg) 60%, transparent);
  --text-quaternary: color-mix(in srgb, var(--editor-fg) 36%, transparent);
  --text-on-accent: var(--accent-fg);

  --focus-halo: 0 0 0 3px color-mix(in srgb, var(--focus-ring-color) 35%, transparent);

  --glass-scrollbar: color-mix(in srgb, var(--editor-fg) 22%, transparent);

  --ambient-1: color-mix(in srgb, var(--stage-logical) 22%, transparent);
  --ambient-2: color-mix(in srgb, var(--vscode-charts-purple, #b48ce8) 15%, transparent);
  --ambient-3: color-mix(in srgb, var(--model-approved) 12%, transparent);
  --canvas-wash:
    radial-gradient(60% 45% at 50% 0%, var(--ambient-1) 0%, transparent 72%),
    radial-gradient(38% 60% at 100% 40%, var(--ambient-2) 0%, transparent 74%),
    radial-gradient(45% 50% at 0% 100%, var(--ambient-3) 0%, transparent 72%),
    radial-gradient(40% 40% at 88% 100%, var(--ambient-1) 0%, transparent 75%);
}

/* Light themes: whiter, more opaque glass; lighter shadows. */
body.vscode-light {
  --glass-tone: color-mix(in srgb, var(--editor-bg) 35%, white 65%);
  --glass-surface-1: color-mix(in srgb, var(--glass-tone) 62%, transparent);
  --glass-surface-2: color-mix(in srgb, var(--glass-tone) 74%, transparent);
  --glass-surface-3: color-mix(in srgb, var(--glass-tone) 86%, transparent);
  --glass-saturate: 160%;
  --glass-border: color-mix(in srgb, var(--editor-fg) 11%, transparent);
  --glass-border-strong: color-mix(in srgb, var(--editor-fg) 19%, transparent);
  --glass-divider: color-mix(in srgb, var(--editor-fg) 8%, transparent);
  --glass-highlight: inset 0 1px 0 0 color-mix(in srgb, white 85%, transparent);
  --glass-shadow-sm:
    0 1px 2px color-mix(in srgb, black 7%, transparent),
    0 4px 12px -4px color-mix(in srgb, black 10%, transparent);
  --glass-shadow-md:
    0 2px 6px -1px color-mix(in srgb, black 7%, transparent),
    0 12px 32px -8px color-mix(in srgb, black 16%, transparent);
  --glass-shadow-lg:
    0 4px 12px -2px color-mix(in srgb, black 8%, transparent),
    0 28px 72px -16px color-mix(in srgb, black 24%, transparent);
  --control-fill: color-mix(in srgb, var(--editor-fg) 5%, transparent);
  --control-fill-hover: color-mix(in srgb, var(--editor-fg) 9%, transparent);
  --control-fill-active: color-mix(in srgb, var(--editor-fg) 14%, transparent);
  --control-fill-selected: color-mix(in srgb, var(--accent) 16%, transparent);
  --control-thumb: white;
  --control-thumb-shadow: 0 1px 3px color-mix(in srgb, black 12%, transparent), 0 0 0 0.5px color-mix(in srgb, black 8%, transparent);
  --glass-input-bg: color-mix(in srgb, white 70%, transparent);
  --text-secondary: color-mix(in srgb, var(--editor-fg) 72%, transparent);
  --text-tertiary: color-mix(in srgb, var(--editor-fg) 56%, transparent);
  --ambient-1: color-mix(in srgb, var(--stage-logical) 14%, transparent);
  --ambient-2: color-mix(in srgb, var(--vscode-charts-purple, #b48ce8) 11%, transparent);
  --ambient-3: color-mix(in srgb, var(--model-approved) 9%, transparent);
}

/* Browsers without backdrop-filter: more opaque surfaces. */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  body,
  body.vscode-light {
    --glass-surface-1: color-mix(in srgb, var(--glass-tone) 92%, transparent);
    --glass-surface-2: color-mix(in srgb, var(--glass-tone) 95%, transparent);
    --glass-surface-3: color-mix(in srgb, var(--glass-tone) 97%, transparent);
  }
}

/* Reduced transparency: opaque surfaces, no blur, no wash. */
@media (prefers-reduced-transparency: reduce) {
  body,
  body.vscode-light {
    --glass-surface-1: var(--glass-tone);
    --glass-surface-2: var(--glass-tone);
    --glass-surface-3: var(--glass-tone);
    --glass-input-bg: var(--input-bg);
    --glass-backdrop: none;
    --glass-backdrop-thin: none;
    --glass-border: var(--panel-border);
    --canvas-wash: none;
  }
}

/* High contrast (dark and light): opaque, bordered, no shadows, no wash,
   full-strength text. Hover and selection show as borders. */
body.vscode-high-contrast,
body.vscode-high-contrast-light {
  --glass-tone: var(--editor-bg);
  --glass-surface-1: var(--editor-bg);
  --glass-surface-2: var(--editor-bg);
  --glass-surface-3: var(--editor-bg);
  --glass-surface-solid: var(--editor-bg);
  --glass-well: transparent;
  --glass-backdrop: none;
  --glass-backdrop-thin: none;
  --glass-border: var(--vscode-contrastBorder, var(--panel-border));
  --glass-border-strong: var(--vscode-contrastActiveBorder, var(--vscode-contrastBorder, var(--panel-border)));
  --glass-divider: var(--vscode-contrastBorder, var(--panel-border));
  --glass-highlight: 0 0 0 0 transparent;
  --glass-shadow-sm: 0 0 0 0 transparent;
  --glass-shadow-md: 0 0 0 0 transparent;
  --glass-shadow-lg: 0 0 0 0 transparent;
  --glass-tint-logical: transparent;
  --glass-tint-logical-strong: transparent;
  --glass-tint-physical: transparent;
  --glass-tint-physical-strong: transparent;
  --glass-tint-ghost: transparent;
  --glass-tint-accent: transparent;
  --glass-tint-accent-strong: transparent;
  --glass-tint-warning: transparent;
  --glass-tint-error: transparent;
  --glass-tint-ok: transparent;
  --glass-tint-ai: transparent;
  --control-fill: transparent;
  --control-fill-hover: transparent;
  --control-fill-active: transparent;
  --control-fill-selected: transparent;
  --control-border: transparent;
  --control-border-hover: var(--vscode-contrastActiveBorder, var(--focus-border));
  --control-border-selected: var(--vscode-contrastActiveBorder, var(--focus-border));
  --control-thumb: var(--editor-bg);
  --control-thumb-shadow: 0 0 0 1px var(--vscode-contrastActiveBorder, var(--focus-border));
  --glass-input-bg: var(--input-bg);
  --glass-input-border: var(--vscode-contrastBorder, var(--input-border));
  --text-secondary: var(--editor-fg);
  --text-tertiary: var(--editor-fg);
  --text-quaternary: var(--editor-fg);
  --focus-halo: 0 0 0 0 transparent;
  --glass-scrollbar: var(--vscode-contrastBorder, var(--editor-fg));
  --ambient-1: transparent;
  --ambient-2: transparent;
  --ambient-3: transparent;
  --canvas-wash: none;
}

/* Reduced motion: every duration collapses; springs stop overshooting. */
@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-instant: 0.01ms;
    --duration-fast: 0.01ms;
    --duration-base: 0.01ms;
    --duration-slow: 0.01ms;
    --ease-spring: var(--ease-standard);
  }
}
`;

/**
 * The shared page chrome and kit. Every class is `gp-` prefixed; the only
 * custom properties declared here are `--gp-*` page-local ones.
 *
 * Page chrome (no class needed): `html` background and the document
 * scrollbar, `body` type and colour, the fixed ambient wash, thin scrollbars
 * everywhere, one focus-visible ring, link colour.
 *
 * Kit:
 *   .gp-page                    centred page column (max width --gp-page-width, 880px)
 *   .gp-title / .gp-heading     page title (18px) / section heading (15px)
 *   .gp-label                   small uppercase section label
 *   .gp-muted / .gp-hint        secondary text / small tertiary hint line
 *   .gp-card                    glass card (surface 2, 12px radius, elevation 1)
 *   .gp-card--raised            denser, higher card (surface 3, 18px radius, elevation 2)
 *   .gp-card--well              sunken group inside a card (no glass, no shadow)
 *   .gp-card--interactive       a card that is itself a button or link: hover lift, press, focus ring
 *   .gp-button                  secondary button (28px, control fill, hairline)
 *   .gp-button--primary         the one primary action (accent fill)
 *   .gp-button--quiet           transparent until hovered (toolbar-style)
 *   .gp-button--lg              32px button (dialog footers, page calls to action)
 *   .gp-icon-button             square 28px quiet icon button (16px svg inside); needs aria-label
 *   .gp-link                    a <button> that looks like a link
 *   .gp-input                   input / select / textarea on glass (28px)
 *   .gp-input--lg / --error     32px input / error border and halo
 *   .gp-pill                    neutral capsule (counts, chips, statuses)
 *   .gp-pill--accent|--logical|--physical|--ok|--warning|--error|--ai   tinted pill
 *   .gp-badge                   small solid count badge (theme badge colours)
 *   .gp-notice                  an inline notice strip; --warning|--error|--ok|--info
 *   .gp-divider / --vertical    hairline rule (horizontal, or 18px vertical)
 *   .gp-kbd                     a keyboard key
 *   .gp-code                    a code block surface (monospace, scrolls sideways)
 *   .gp-code-inline             inline code
 */
export const GLASS_PAGE_BASE = String.raw`
/* --- Page chrome ----------------------------------------------------------- */

/* The document scrolls on html, so html paints the background and owns the
   page scrollbar. The body-level tokens are not visible on html, so the
   scrollbar colour is a page-local token (same recipe as --glass-scrollbar). */
html {
  --gp-scrollbar: color-mix(in srgb, var(--editor-fg) 22%, transparent);
  background-color: var(--editor-bg);
  scrollbar-width: thin;
  scrollbar-color: var(--gp-scrollbar) transparent;
}

html:has(> body.vscode-high-contrast),
html:has(> body.vscode-high-contrast-light) {
  --gp-scrollbar: var(--vscode-contrastBorder, var(--editor-fg));
}

body {
  margin: 0;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: var(--text-md);
  font-weight: var(--weight-regular);
  line-height: var(--leading-normal);
  -webkit-font-smoothing: antialiased;
  /* Native bits (scrollbars, form controls, selection) follow the VS Code
     theme, not the OS: one rule for every standalone page. */
  color-scheme: dark;
}
body.vscode-light,
body.vscode-high-contrast-light { color-scheme: light; }

/* The ambient wash: soft colour fields fixed to the viewport, behind all
   content (z-index -1 under the root's background-free stacking context),
   so it never scrolls or repaints with the page. The tokens turn it off for
   high contrast and reduced transparency. */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background-image: var(--canvas-wash);
  background-repeat: no-repeat;
}

* {
  scrollbar-width: thin;
  scrollbar-color: var(--gp-scrollbar) transparent;
}

::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb {
  background: var(--gp-scrollbar);
  border: 3px solid transparent;
  border-radius: var(--radius-pill);
  background-clip: padding-box;
}
::-webkit-scrollbar-track,
::-webkit-scrollbar-corner { background: transparent; }

/* One keyboard focus ring for everything (zero specificity: a component's
   own :focus-visible rule wins). */
:where(:focus-visible) {
  outline: var(--focus-outline);
  outline-offset: var(--focus-offset);
}

:where(a) {
  color: var(--vscode-textLink-foreground, var(--accent));
  text-decoration: none;
}
:where(a):hover {
  color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
  text-decoration: underline;
}

:where(button, input, select, textarea) {
  font: inherit;
  color: inherit;
}

/* --- Layout and type ------------------------------------------------------- */

.gp-page {
  --gp-page-width: 880px;
  width: 100%;
  max-width: calc(var(--gp-page-width) + 2 * var(--space-8));
  margin: 0 auto;
  padding: var(--space-9) var(--space-8) var(--space-9);
}

.gp-title {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  line-height: var(--leading-tight);
}

.gp-heading {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  line-height: var(--leading-tight);
}

.gp-label {
  color: var(--text-tertiary);
  font-size: var(--text-2xs);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-caps);
  line-height: var(--leading-tight);
  text-transform: uppercase;
}

.gp-muted { color: var(--text-secondary); }

.gp-hint {
  color: var(--text-tertiary);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
}

/* --- Cards ----------------------------------------------------------------- */

.gp-card {
  padding: var(--space-6);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  background:
    linear-gradient(180deg, color-mix(in srgb, white 3%, transparent), transparent 40%),
    var(--glass-surface-2);
  -webkit-backdrop-filter: var(--glass-backdrop);
  backdrop-filter: var(--glass-backdrop);
  box-shadow: var(--glass-elevation-1);
  color: var(--text-primary);
}

.gp-card--raised {
  border-radius: var(--radius-xl);
  background: var(--glass-surface-3);
  box-shadow: var(--glass-elevation-2);
}

.gp-card--well {
  border-color: var(--glass-divider);
  border-radius: var(--radius-md);
  background: var(--glass-well);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow: none;
}

.gp-card--interactive {
  display: block;
  width: 100%;
  font: inherit;
  text-align: left;
  text-decoration: none;
  color: var(--text-primary);
  cursor: pointer;
  transition:
    background-color var(--duration-fast) var(--ease-standard),
    border-color var(--duration-fast) var(--ease-standard),
    box-shadow var(--duration-base) var(--ease-standard),
    transform var(--duration-base) var(--ease-out);
}
.gp-card--interactive:hover {
  border-color: var(--glass-border-strong);
  box-shadow: var(--glass-elevation-2);
  transform: translateY(-1px);
  text-decoration: none;
  color: var(--text-primary);
}
.gp-card--interactive:active {
  transform: scale(0.99);
  transition-duration: var(--duration-instant);
}
.gp-card--interactive:focus-visible {
  outline: var(--focus-outline);
  outline-offset: var(--focus-offset);
}

/* --- Buttons --------------------------------------------------------------- */

.gp-button,
.gp-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  min-height: var(--control-height);
  margin: 0;
  padding: 0 var(--space-5);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--control-fill);
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  transition:
    background-color var(--duration-fast) var(--ease-standard),
    border-color var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard),
    box-shadow var(--duration-fast) var(--ease-standard),
    opacity var(--duration-fast) var(--ease-standard),
    transform var(--duration-instant) var(--ease-standard);
}

.gp-button:hover,
.gp-icon-button:hover {
  background: var(--control-fill-hover);
  color: var(--text-primary);
  text-decoration: none;
}

.gp-button:active,
.gp-icon-button:active {
  background: var(--control-fill-active);
  transform: scale(0.97);
}

.gp-button:focus-visible,
.gp-icon-button:focus-visible {
  outline: var(--focus-outline);
  outline-offset: var(--focus-offset);
}

.gp-button[aria-pressed='true'],
.gp-icon-button[aria-pressed='true'] {
  background: var(--control-fill-selected);
  border-color: var(--control-border-selected);
  color: var(--control-fg-selected);
}

.gp-button--primary {
  border-color: var(--glass-border);
  background: var(--accent);
  box-shadow: var(--glass-elevation-1);
  color: var(--text-on-accent);
}
.gp-button--primary:hover {
  background: var(--accent-hover);
  color: var(--text-on-accent);
}
.gp-button--primary:active { background: var(--accent-hover); }

.gp-button--quiet,
.gp-icon-button {
  border-color: transparent;
  background: transparent;
  color: var(--text-secondary);
}
.gp-button--quiet:hover,
.gp-icon-button:hover { color: var(--text-primary); }

.gp-button--lg {
  min-height: var(--control-height-lg);
  padding: 0 var(--space-6);
  font-size: var(--text-md);
}

.gp-icon-button {
  flex: none;
  width: var(--control-height);
  height: var(--control-height);
  padding: 0;
}
.gp-icon-button svg {
  display: block;
  width: 16px;
  height: 16px;
  flex: none;
}

.gp-button > svg {
  width: 14px;
  height: 14px;
  flex: none;
}

.gp-button:disabled,
.gp-button[aria-disabled='true'],
.gp-icon-button:disabled,
.gp-icon-button[aria-disabled='true'] {
  opacity: 0.45;
  cursor: not-allowed;
  box-shadow: none;
  transform: none;
}
.gp-button:disabled:hover,
.gp-button[aria-disabled='true']:hover {
  background: var(--control-fill);
}
.gp-button--primary:disabled:hover,
.gp-button--primary[aria-disabled='true']:hover {
  background: var(--accent);
}
.gp-button--quiet:disabled:hover,
.gp-icon-button:disabled:hover,
.gp-icon-button[aria-disabled='true']:hover {
  background: transparent;
}

/* A <button> that reads as a link. */
.gp-link {
  display: inline;
  padding: 0;
  border: 0;
  background: none;
  color: var(--vscode-textLink-foreground, var(--accent));
  font: inherit;
  text-align: inherit;
  text-decoration: none;
  cursor: pointer;
}
.gp-link:hover {
  color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
  text-decoration: underline;
}
.gp-link:focus-visible {
  outline: var(--focus-outline);
  outline-offset: 1px;
  border-radius: var(--radius-xs);
}

/* --- Inputs ---------------------------------------------------------------- */

.gp-input {
  min-height: var(--control-height);
  padding: 0 var(--space-4);
  border: 1px solid var(--glass-input-border);
  border-radius: var(--radius-md);
  background: var(--glass-input-bg);
  color: var(--input-fg);
  font-family: inherit;
  font-size: var(--text-sm);
  transition:
    border-color var(--duration-fast) var(--ease-standard),
    box-shadow var(--duration-fast) var(--ease-standard),
    background-color var(--duration-fast) var(--ease-standard);
}
.gp-input:hover { border-color: var(--glass-border-strong); }
.gp-input:focus,
.gp-input:focus-visible {
  outline: none;
  border-color: var(--glass-input-border-focus);
  box-shadow: var(--focus-halo);
}
.gp-input::placeholder {
  color: var(--vscode-input-placeholderForeground, var(--text-quaternary));
  opacity: 1;
}
.gp-input:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
textarea.gp-input {
  min-height: 64px;
  padding: var(--space-3) var(--space-4);
  line-height: var(--leading-normal);
  resize: vertical;
}
.gp-input--lg {
  min-height: var(--control-height-lg);
  padding: 0 var(--space-5);
  font-size: var(--text-md);
}
.gp-input--error,
.gp-input--error:hover { border-color: var(--error-fg); }
.gp-input--error:focus { border-color: var(--error-fg); box-shadow: 0 0 0 3px var(--glass-tint-error); }

/* --- Pills and badges ------------------------------------------------------ */

.gp-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-4);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-pill);
  background: var(--control-fill);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  line-height: 1.4;
  white-space: nowrap;
}
.gp-pill--accent   { border-color: var(--control-border-selected); background: var(--glass-tint-accent); color: var(--text-primary); }
.gp-pill--logical  { border-color: var(--glass-tint-logical-edge); background: var(--glass-tint-logical); color: var(--text-primary); }
.gp-pill--physical { border-color: var(--glass-tint-physical-edge); background: var(--glass-tint-physical); color: var(--text-primary); }
.gp-pill--ok       { border-color: color-mix(in srgb, var(--ok-fg) 40%, transparent); background: var(--glass-tint-ok); color: var(--text-primary); }
.gp-pill--warning  { border-color: var(--glass-tint-warning-edge); background: var(--glass-tint-warning); color: var(--text-primary); }
.gp-pill--error    { border-color: var(--glass-tint-error-edge); background: var(--glass-tint-error); color: var(--text-primary); }
.gp-pill--ai       { border-color: color-mix(in srgb, var(--ai-fg) 40%, transparent); background: var(--glass-tint-ai); color: var(--text-primary); }

.gp-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 var(--space-3);
  border: 1px solid var(--vscode-contrastBorder, transparent);
  border-radius: var(--radius-pill);
  background: var(--vscode-badge-background, var(--control-fill-active));
  color: var(--vscode-badge-foreground, var(--text-primary));
  font-size: var(--text-2xs);
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
}

/* --- Notices --------------------------------------------------------------- */

.gp-notice {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--glass-well);
  color: var(--text-primary);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}
.gp-notice--info    { border-color: var(--glass-tint-logical-edge); background: var(--glass-tint-logical); }
.gp-notice--ok      { border-color: color-mix(in srgb, var(--ok-fg) 40%, transparent); background: var(--glass-tint-ok); }
.gp-notice--warning { border-color: var(--glass-tint-warning-edge); background: var(--glass-tint-warning); }
.gp-notice--error   { border-color: var(--glass-tint-error-edge); background: var(--glass-tint-error); }

/* --- Dividers, keys, code -------------------------------------------------- */

.gp-divider {
  height: 1px;
  margin: var(--space-6) 0;
  border: 0;
  background: var(--glass-divider);
}
.gp-divider--vertical {
  width: 1px;
  height: 18px;
  margin: 0 var(--space-2);
  align-self: center;
}

.gp-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 var(--space-2);
  border: 1px solid var(--glass-border);
  border-bottom-width: 2px;
  border-radius: var(--radius-xs);
  background: var(--control-fill);
  color: var(--text-secondary);
  font-family: var(--font-ui);
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
  line-height: 1;
  white-space: nowrap;
}

.gp-code {
  display: block;
  margin: 0;
  padding: var(--space-4) var(--space-5);
  overflow-x: auto;
  border: 1px solid var(--glass-divider);
  border-radius: var(--radius-md);
  background: var(--glass-well);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  white-space: pre;
  tab-size: 2;
}

.gp-code-inline {
  padding: 0 var(--space-2);
  border: 1px solid var(--glass-divider);
  border-radius: var(--radius-xs);
  background: var(--glass-well);
  font-family: var(--font-mono);
  font-size: 0.92em;
  overflow-wrap: anywhere;
}

/* --- High contrast: hover shows as a border, as VS Code does. -------------- */

body.vscode-high-contrast .gp-button:hover,
body.vscode-high-contrast .gp-icon-button:hover,
body.vscode-high-contrast .gp-card--interactive:hover,
body.vscode-high-contrast-light .gp-button:hover,
body.vscode-high-contrast-light .gp-icon-button:hover,
body.vscode-high-contrast-light .gp-card--interactive:hover {
  border-color: var(--control-border-hover);
  border-style: dashed;
}

body.vscode-high-contrast .gp-button--primary,
body.vscode-high-contrast-light .gp-button--primary {
  border-color: var(--vscode-button-border, var(--glass-border));
}

/* The tints are off in high contrast, so a coloured pill or notice keeps its
   meaning through a full-strength border. */
body.vscode-high-contrast .gp-pill--logical,
body.vscode-high-contrast-light .gp-pill--logical { border-color: var(--stage-logical); }
body.vscode-high-contrast .gp-pill--physical,
body.vscode-high-contrast-light .gp-pill--physical { border-color: var(--stage-physical); }
body.vscode-high-contrast .gp-pill--ok,
body.vscode-high-contrast .gp-notice--ok,
body.vscode-high-contrast-light .gp-pill--ok,
body.vscode-high-contrast-light .gp-notice--ok { border-color: var(--ok-fg); }
body.vscode-high-contrast .gp-pill--warning,
body.vscode-high-contrast .gp-notice--warning,
body.vscode-high-contrast-light .gp-pill--warning,
body.vscode-high-contrast-light .gp-notice--warning { border-color: var(--warning-fg); }
body.vscode-high-contrast .gp-pill--error,
body.vscode-high-contrast .gp-notice--error,
body.vscode-high-contrast-light .gp-pill--error,
body.vscode-high-contrast-light .gp-notice--error { border-color: var(--error-fg); }
body.vscode-high-contrast .gp-pill--ai,
body.vscode-high-contrast-light .gp-pill--ai { border-color: var(--ai-fg); }
body.vscode-high-contrast .gp-notice--info,
body.vscode-high-contrast-light .gp-notice--info { border-color: var(--glass-border); }

body.vscode-high-contrast .gp-card:not(.gp-card--raised):not(.gp-card--well),
body.vscode-high-contrast-light .gp-card:not(.gp-card--raised):not(.gp-card--well) {
  background: var(--glass-surface-2);
}

@media (prefers-reduced-motion: reduce) {
  .gp-card--interactive:hover,
  .gp-card--interactive:active,
  .gp-button:active,
  .gp-icon-button:active { transform: none; }
}
`;

/** Tokens then base: put first in a standalone page's `<style>`. */
export const GLASS_PAGE_STYLE = GLASS_PAGE_TOKENS + GLASS_PAGE_BASE;
