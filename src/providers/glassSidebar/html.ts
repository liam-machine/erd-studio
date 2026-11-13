/**
 * The glass sidebar's page: one self-contained HTML string (an inline nonce'd
 * `<style>` and `<script>`, the pattern `GettingStartedPanel` uses), plus
 * `dist/webview.css` linked for the glass tokens (theme.css) the editor
 * shares. No new build target; no fonts, no network.
 *
 * The script owns only presentation: rows, expansion, selection, search,
 * keyboard, popovers. Every action goes to the host as a row id plus a menu
 * entry index; the host decides (and validates) what runs.
 */
import { GLASS_ICON_FALLBACK, GLASS_ICONS } from './icons';

export interface GlassSidebarHtmlOptions {
  cspSource: string;
  nonce: string;
  /** `dist/webview.css` as a webview URI (the glass tokens). */
  tokensCssUri: string;
}

export function buildGlassSidebarCsp(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource}`,
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ') + ';';
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** JSON safe to inline in a `<script>` block. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function buildGlassSidebarHtml(options: GlassSidebarHtmlOptions): string {
  const n = escapeAttr(options.nonce);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(buildGlassSidebarCsp(options.cspSource, options.nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeAttr(options.tokensCssUri)}">
<style nonce="${n}">${GLASS_SIDEBAR_STYLE}</style>
<title>ERD Studio</title>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
<div class="gs-app">
  <div class="gs-search" role="search">
    <span class="gs-search__icon" aria-hidden="true"></span>
    <input class="gs-search__input" type="text" placeholder="Search" aria-label="Search diagrams, tables and relationships" aria-keyshortcuts="/ Control+F Meta+F" spellcheck="false" autocomplete="off">
    <kbd class="gs-search__kbd" aria-hidden="true">/</kbd>
    <button class="gs-search__clear" type="button" aria-label="Clear search" title="Clear search" hidden></button>
  </div>
  <main class="gs-sections" aria-busy="true"></main>
  <div class="gs-noresults" hidden></div>
</div>
<div class="gs-menu-layer"></div>
<div class="gs-live" aria-live="polite"></div>
<script type="application/json" id="gs-icons" nonce="${n}">${inlineJson({ icons: GLASS_ICONS, fallback: GLASS_ICON_FALLBACK })}</script>
<script nonce="${n}">${GLASS_SIDEBAR_SCRIPT}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

export const GLASS_SIDEBAR_STYLE = String.raw`
/* The sidebar's own surface: the glass tokens derive from --editor-bg and
   --editor-fg (theme.css), so point them at the side bar's colours. */
:root {
  --editor-bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
  --editor-fg: var(--vscode-sideBar-foreground, var(--vscode-foreground, var(--vscode-editor-foreground)));
  --gs-indent: 14px;
  --gs-row-height: 28px;
  --gs-gutter: 8px;
}

/* dist/webview.css is the editor's bundle: its host.css pins html and body to
   the viewport with overflow hidden (the canvas never scrolls). The sidebar
   is a scrolling document, so undo that here. */
html, body {
  width: auto;
  height: auto;
  min-height: 100%;
  margin: 0;
  padding: 0;
  overflow: visible;
}

html {
  overflow-x: hidden;
  overflow-y: auto;
}

/* Only html scrolls. An overflow other than visible on body (even overflow-x
   alone, which turns its overflow-y to auto) makes body a second scroll
   container with a scrollbar of its own beside the page's. */
body {
  position: relative;
  background-color: var(--editor-bg);
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: var(--text-md);
  line-height: var(--leading-tight);
  -webkit-font-smoothing: antialiased;
  scrollbar-width: thin;
  scrollbar-color: var(--glass-scrollbar) transparent;
  /* The ambient wash, as on the canvas: soft colour fields the cards float over. */
  /* Fixed to the viewport (so it never scrolls or repaints with the list):
     the stage blue at the top, violet down the right, teal at the bottom. */
  --gs-wash:
    radial-gradient(150% 34% at 0% 0%, var(--ambient-1) 0%, transparent 74%),
    radial-gradient(110% 40% at 100% 38%, var(--ambient-2) 0%, transparent 72%),
    radial-gradient(130% 30% at 0% 72%, var(--ambient-1) 0%, transparent 76%),
    radial-gradient(150% 36% at 30% 100%, var(--ambient-3) 0%, transparent 72%);
}

body::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-image: var(--gs-wash);
  background-repeat: no-repeat;
}

/* High contrast zeroes the ambient tokens already; reduced transparency
   keeps them, so drop the wash here (the canvas does the same). */
body.vscode-high-contrast::before,
body.vscode-high-contrast-light::before {
  background-image: none;
}

@media (prefers-reduced-transparency: reduce) {
  body::before { background-image: none; }
}

::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb {
  background: var(--glass-scrollbar);
  border: 3px solid transparent;
  border-radius: var(--radius-pill);
  background-clip: padding-box;
}
::-webkit-scrollbar-track { background: transparent; }

.gs-app {
  position: relative;
  z-index: 1;
  padding-bottom: var(--space-6);
}

button {
  font: inherit;
  color: inherit;
}

svg.gs-icon {
  display: block;
  width: 16px;
  height: 16px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* --- Search ------------------------------------------------------------- */

.gs-search {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  padding: var(--space-4) var(--gs-gutter) var(--space-3);
  /* Clear over the wash at rest; once the list scrolls under it, a frosted
     strip with a hairline, so rows never show through the field. */
  border-bottom: 1px solid transparent;
  transition: background-color var(--duration-base) var(--ease-standard), border-color var(--duration-base) var(--ease-standard);
}

.gs-app.is-scrolled .gs-search {
  border-bottom-color: var(--glass-divider);
  background: var(--glass-surface-2);
  -webkit-backdrop-filter: var(--glass-backdrop);
  backdrop-filter: var(--glass-backdrop);
}

.gs-search__icon {
  position: absolute;
  z-index: 1;
  left: calc(var(--gs-gutter) + 10px);
  top: 50%;
  margin-top: -6px;
  color: var(--text-tertiary);
  pointer-events: none;
  transition: color var(--duration-fast) var(--ease-standard);
}

.gs-search__icon svg.gs-icon { width: 14px; height: 14px; }

.gs-search__input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 30px 0 30px;
  border: 1px solid var(--glass-input-border);
  border-radius: var(--radius-pill);
  background: var(--glass-surface-2);
  -webkit-backdrop-filter: var(--glass-backdrop);
  backdrop-filter: var(--glass-backdrop);
  box-shadow: var(--glass-elevation-1);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-sm);
  outline: none;
  transition:
    border-color var(--duration-fast) var(--ease-standard),
    box-shadow var(--duration-fast) var(--ease-standard),
    background-color var(--duration-fast) var(--ease-standard);
}

.gs-search__input::placeholder {
  color: var(--text-tertiary);
}

.gs-search__input:hover {
  border-color: var(--glass-border-strong);
}

.gs-search__input:focus {
  border-color: var(--glass-input-border-focus);
  box-shadow: var(--glass-highlight), var(--focus-halo);
}

.gs-search:focus-within .gs-search__icon {
  color: var(--text-secondary);
}

.gs-search__clear {
  position: absolute;
  z-index: 1;
  right: calc(var(--gs-gutter) + 5px);
  top: 50%;
  margin-top: -9px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-pill);
  background: var(--control-fill-hover);
  color: var(--text-secondary);
  cursor: pointer;
}

/* The "/" keycap: a hint at rest, gone once the field is in use. */
.gs-search__kbd {
  position: absolute;
  z-index: 1;
  right: calc(var(--gs-gutter) + 8px);
  top: 50%;
  margin-top: -8px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-xs);
  background: var(--control-fill);
  color: var(--text-tertiary);
  font-family: var(--font-ui);
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
  line-height: 14px;
  text-align: center;
  pointer-events: none;
  transition: opacity var(--duration-fast) var(--ease-standard);
}

.gs-search__input:focus ~ .gs-search__kbd,
.gs-search__input:not(:placeholder-shown) ~ .gs-search__kbd {
  opacity: 0;
}

.gs-search__clear svg.gs-icon { width: 12px; height: 12px; stroke-width: 1.6; }
.gs-search__clear:hover { background: var(--control-fill-active); color: var(--text-primary); }
.gs-search__clear:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.gs-search__clear[hidden] { display: none; }

/* --- Section cards -------------------------------------------------------- */

.gs-sections {
  display: flex;
  flex-direction: column;
  padding: var(--space-2) var(--gs-gutter) 0;
}

/* A section is one card to the eye, drawn as two boxes: its header and its
   body. The section element itself has no box (display: contents), so the
   header's sticky range is the whole list, not its own card: every header
   stays in view, parked in order under the search field or at the foot of
   the pane, while the bodies scroll past (pinHeaders() sets the offsets). */
.gs-section { display: contents; }

.gs-section[hidden] { display: none; }

.gs-section__header {
  position: sticky;
  top: var(--gs-pin-top, auto);
  bottom: var(--gs-pin-bottom, auto);
  z-index: 3;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 36px;
  margin-top: var(--space-4);
  padding: 0 var(--space-3) 0 var(--space-2);
  border: 1px solid var(--glass-border);
  border-bottom-color: transparent;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  background:
    linear-gradient(180deg, color-mix(in srgb, white 3%, transparent), transparent),
    var(--glass-surface-2);
}

.gs-section:first-child .gs-section__header { margin-top: 0; }

body.vscode-light .gs-section__header,
body.vscode-light .gs-section__body {
  background: var(--glass-surface-3);
}

/* Held at its parking place with rows passing under it: opaque enough to read. */
.gs-section__header.is-stuck,
body.vscode-light .gs-section__header.is-stuck {
  background:
    linear-gradient(var(--glass-surface-3), var(--glass-surface-3)),
    color-mix(in srgb, var(--editor-bg) 86%, transparent);
  -webkit-backdrop-filter: var(--glass-backdrop);
  backdrop-filter: var(--glass-backdrop);
}

/* Folded, or parked away from its body: the header is the whole card. An
   open one keeps its chevron down, and a click brings its section back. */
.gs-section--collapsed .gs-section__header,
.gs-section__header.is-parked {
  border-bottom-color: var(--glass-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--glass-elevation-1);
}

.gs-section--collapsed .gs-section__header {
  transition: border-radius 0s linear var(--duration-base), border-color 0s linear var(--duration-base);
}

.gs-sections--intro .gs-section__header,
.gs-sections--intro .gs-section__body {
  animation: gs-rise var(--duration-slow) var(--ease-out) both;
  animation-delay: inherit;
}

@keyframes gs-rise {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}

.gs-section__toggle {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 var(--space-3) 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.gs-section__toggle:focus-visible {
  outline: var(--focus-outline);
  outline-offset: -1px;
}

.gs-section__chevron {
  color: var(--text-tertiary);
  transition: transform var(--duration-base) var(--ease-spring), color var(--duration-fast) var(--ease-standard);
  transform: rotate(90deg);
}

.gs-section__chevron svg.gs-icon { width: 12px; height: 12px; stroke-width: 1.7; }

.gs-section--collapsed .gs-section__chevron {
  transform: rotate(0deg);
}

.gs-section__toggle:hover .gs-section__chevron { color: var(--text-primary); }

.gs-section__title {
  overflow: hidden;
  color: var(--text-primary);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gs-section__count {
  flex: none;
  min-width: 18px;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--control-fill);
  color: var(--text-tertiary);
  font-size: var(--text-2xs);
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
  line-height: 14px;
  text-align: center;
}

.gs-section__count--hits {
  background: var(--glass-tint-accent-strong);
  color: var(--text-primary);
}

.gs-section__filter {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 45%;
  flex: 0 1 auto;
  padding: 1px 7px 1px 5px;
  border: 1px solid var(--glass-tint-logical-edge);
  border-radius: var(--radius-pill);
  background: var(--glass-tint-logical);
  color: var(--text-secondary);
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
  line-height: 14px;
  white-space: nowrap;
}

.gs-section__filter svg.gs-icon { width: 10px; height: 10px; }
.gs-section__filter span { overflow: hidden; text-overflow: ellipsis; }

/* Title actions take no room until shown (the header hovered, keyboard
   focus in the header, or their menu open), so a narrow view keeps its
   titles whole: pointing at the card's rows leaves its title alone.
   Hidden with display, not opacity: the buttons are in the Tab order only
   once the header has focus, as on VS Code's own view headers. */
.gs-section__actions {
  display: none;
  align-items: center;
  gap: 1px;
  flex: none;
}

.gs-section__header:hover .gs-section__actions,
.gs-section__header:focus-within .gs-section__actions,
.gs-section__actions.is-open {
  display: flex;
  animation: gs-fade-in var(--duration-fast) var(--ease-standard);
}

@keyframes gs-fade-in { from { opacity: 0; } }

.gs-iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--control-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    background-color var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard),
    transform var(--duration-instant) var(--ease-standard);
}

.gs-iconbtn:hover {
  background: var(--control-fill-hover);
  border-color: var(--control-border-hover);
  color: var(--text-primary);
}

.gs-iconbtn:active { background: var(--control-fill-active); transform: scale(0.94); }
.gs-iconbtn:focus-visible { outline: var(--focus-outline); outline-offset: -1px; opacity: 1; }
.gs-iconbtn[aria-expanded='true'] { background: var(--control-fill-active); color: var(--text-primary); }

.gs-iconbtn--text {
  width: auto;
  padding: 0 var(--space-3);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
}

/* The section body folds smoothly (grid rows 1fr → 0fr). */
.gs-section__body {
  display: grid;
  grid-template-rows: 1fr;
  border: 1px solid var(--glass-border);
  border-top: 0;
  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
  background: var(--glass-surface-2);
  box-shadow: var(--glass-elevation-1);
  transition: grid-template-rows var(--duration-base) var(--ease-standard);
}

.gs-section--collapsed .gs-section__body,
body.vscode-light .gs-section--collapsed .gs-section__body {
  grid-template-rows: 0fr;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  transition: grid-template-rows var(--duration-base) var(--ease-standard),
    border-color 0s linear var(--duration-base), background-color 0s linear var(--duration-base), box-shadow 0s linear var(--duration-base);
}

/* A row brought into view (arrow keys, a reveal) stops clear of the headers parked above and below its section. */
.gs-row {
  scroll-margin-top: calc(var(--gs-pin-top, 0px) + 48px);
  scroll-margin-bottom: calc(var(--gs-pin-bottom, 0px) + 4px);
}

.gs-section__inner {
  min-height: 0;
  overflow: hidden;
}

.gs-section__content {
  padding: 0 var(--space-2) var(--space-3);
  border-top: 1px solid transparent;
}

.gs-section--collapsed .gs-section__content {
  visibility: hidden;
  transition: visibility 0s linear var(--duration-base);
}

/* --- Tree rows -------------------------------------------------------------- */

.gs-tree {
  position: relative;
  outline: none;
}

.gs-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: var(--gs-row-height);
  padding: 0 var(--space-2) 0 calc(4px + var(--depth, 0) * var(--gs-indent));
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  cursor: pointer;
  user-select: none;
  transition: background-color var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard);
}

.gs-row:hover {
  background: var(--control-fill-hover);
  border-color: var(--control-border-hover);
}

.gs-row:active {
  background: var(--control-fill-active);
}

/* Selected: the accent wash; while the tree has focus, its hairline too
   (VS Code's focused versus inactive selection). */
.gs-row.is-selected {
  background: var(--control-fill-selected);
}

.gs-tree:focus-within .gs-row.is-selected {
  border-color: var(--control-border-selected);
}

/* Inactive selection in high contrast still needs an edge (fills are transparent there). */
body.vscode-high-contrast .gs-row.is-selected,
body.vscode-high-contrast-light .gs-row.is-selected {
  border-color: var(--control-border-selected);
}

.gs-row:focus { outline: none; }
.gs-row:focus-visible {
  outline: var(--focus-outline);
  outline-offset: -2px;
}

.gs-row.is-menu-open {
  background: var(--control-fill-active);
}

/* Indent guides: a hairline under each ancestor's chevron, quiet until the tree is hovered. */
.gs-guide {
  position: absolute;
  top: -1px;
  bottom: -1px;
  width: 1px;
  left: calc(4px + var(--level) * var(--gs-indent) + 7.5px);
  background: var(--glass-divider);
  opacity: 0.55;
  pointer-events: none;
  transition: opacity var(--duration-fast) var(--ease-standard);
}

.gs-tree:hover .gs-guide { opacity: 1; }

.gs-row__twistie {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: none;
  margin-right: -2px;
  border-radius: var(--radius-xs);
  color: var(--text-tertiary);
  transition: transform var(--duration-base) var(--ease-spring), color var(--duration-fast) var(--ease-standard);
}

.gs-row__twistie svg.gs-icon { width: 12px; height: 12px; stroke-width: 1.7; }
.gs-row[aria-expanded='true'] > .gs-row__twistie { transform: rotate(90deg); }
.gs-row:hover > .gs-row__twistie { color: var(--text-secondary); }
.gs-tree--flat .gs-row__twistie { display: none; }

.gs-row__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--text-secondary);
}

.gs-row__icon img {
  display: block;
  width: 16px;
  height: 16px;
}

.gs-row__text {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.gs-row__label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--text-md);
}

.gs-row__desc {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}

.gs-mark {
  border-radius: 3px;
  background: var(--glass-tint-accent-strong);
  color: inherit;
  box-shadow: 0 0 0 1px var(--glass-tint-accent-strong);
}

body.vscode-high-contrast .gs-mark,
body.vscode-high-contrast-light .gs-mark {
  outline: 1px dotted var(--vscode-contrastActiveBorder, var(--focus-border));
  background: transparent;
}

/* Hover actions: inline menu entries, and the row's More button. Like the
   title actions they take no room until shown, so a label only gives way
   to them on the row being pointed at, focused or selected. */
.gs-row__actions {
  display: none;
  align-items: center;
  gap: 1px;
  flex: none;
  margin-right: -2px;
}

.gs-row__actions .gs-iconbtn { width: 22px; height: 22px; }
.gs-row__actions .gs-iconbtn svg.gs-icon { width: 14px; height: 14px; }

.gs-row:hover > .gs-row__actions,
.gs-row:focus-within > .gs-row__actions,
.gs-tree:focus-within .gs-row.is-selected > .gs-row__actions,
.gs-row.is-menu-open > .gs-row__actions {
  display: flex;
  animation: gs-fade-in var(--duration-fast) var(--ease-standard);
}

/* A layer row reads as a group header: its swatch, a semibold label. */
.gs-row--group .gs-row__label {
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
}

.gs-row--group .gs-row__icon {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--swatch, transparent) 16%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--swatch, transparent) 30%, transparent);
}

.gs-row--group .gs-row__icon svg.gs-icon { width: 14px; height: 14px; }

.gs-row--group:not(:first-child) {
  margin-top: 4px;
}

.gs-row--quiet .gs-row__label {
  color: var(--text-secondary);
}

.gs-row--quiet .gs-row__icon {
  color: var(--text-tertiary);
}

/* Rows that only offer an action (+ New Diagram…, New Layer…). */
.gs-row--action .gs-row__label,
.gs-row--action .gs-row__icon {
  color: var(--text-tertiary);
}

.gs-row--action:hover .gs-row__label,
.gs-row--action:hover .gs-row__icon {
  color: var(--text-primary);
}

.gs-row--enter {
  animation: gs-row-in var(--duration-base) var(--ease-out) both;
}

@keyframes gs-row-in {
  from { opacity: 0; transform: translateY(-3px); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .gs-row--enter { animation: none; }
}

.gs-row--loading {
  cursor: default;
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}

.gs-row--loading:hover { background: transparent; border-color: transparent; }

/* A small ring with a bright arc, turning; under reduced motion it breathes instead. */
.gs-spinner {
  width: 12px;
  height: 12px;
  margin: 0 2px;
  flex: none;
  border: 1.5px solid var(--glass-border-strong);
  border-top-color: var(--accent);
  border-radius: var(--radius-pill);
  animation: gs-spin 0.8s linear infinite;
}

@keyframes gs-spin { to { transform: rotate(360deg); } }
@keyframes gs-breathe { 50% { opacity: 0.4; } }

@media (prefers-reduced-motion: reduce) {
  .gs-spinner { animation: gs-breathe 1.6s ease-in-out infinite; }
}

/* --- Help & Feedback: a compact list of tappable rows ---------------------- */

.gs-section--help .gs-row {
  height: 30px;
}

.gs-section--help .gs-row__icon {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--control-fill);
  color: var(--text-secondary);
  transition: background-color var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard);
}

.gs-section--help .gs-row__icon svg.gs-icon { width: 14px; height: 14px; }

.gs-section--help .gs-row:hover .gs-row__icon {
  background: var(--glass-tint-accent-strong);
  color: var(--text-primary);
}

.gs-section--help .gs-row__label {
  font-size: var(--text-sm);
}

/* No twistie column for the plain action rows; a row that folds (My
   Reports) carries its chevron at the trailing edge, iOS style. */
.gs-section--help .gs-row__twistie:empty { display: none; }
.gs-section--help .gs-row__twistie:not(:empty) { order: 2; margin: 0 0 0 auto; }
.gs-section--help .gs-row__actions { order: 1; }
.gs-section--help .gs-row { padding-left: calc(4px + var(--depth, 0) * 22px); }
.gs-section--help .gs-guide { display: none; }

/* --- Welcome / empty states ------------------------------------------------- */

.gs-welcome {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-1) var(--space-3) var(--space-3);
}

.gs-welcome p {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}

.gs-welcome p + p { margin-top: -2px; }

/* A soft tile with the section's glyph: the empty state's one visual. */
.gs-welcome__glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  margin-bottom: calc(var(--space-1) * -1);
  border: 1px solid var(--glass-tint-logical-edge);
  border-radius: var(--radius-md);
  background: linear-gradient(180deg, var(--glass-tint-logical-strong), var(--glass-tint-logical));
  box-shadow: var(--glass-highlight);
  color: var(--stage-logical);
}

.gs-welcome__glyph svg.gs-icon { width: 18px; height: 18px; stroke-width: 1.3; }

body.vscode-high-contrast .gs-welcome__glyph,
body.vscode-high-contrast-light .gs-welcome__glyph {
  border-color: var(--glass-border);
  color: var(--text-primary);
}

.gs-welcome .gs-welcome__lead {
  color: var(--text-primary);
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
}

.gs-welcome .gs-welcome__lead + p { margin-top: calc(var(--space-3) * -1); }

.gs-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  width: 100%;
  min-height: var(--control-height);
  padding: 0 var(--space-5);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--control-fill);
  color: var(--text-primary);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  cursor: pointer;
  transition:
    background-color var(--duration-fast) var(--ease-standard),
    transform var(--duration-instant) var(--ease-standard),
    box-shadow var(--duration-fast) var(--ease-standard);
}

.gs-button:hover { background: var(--control-fill-hover); }
.gs-button:active { transform: scale(0.98); }
.gs-button:focus-visible { outline: var(--focus-outline); outline-offset: var(--focus-offset); }

.gs-button--primary {
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  background: var(--accent);
  box-shadow: var(--glass-highlight), 0 1px 2px color-mix(in srgb, black 20%, transparent);
  color: var(--text-on-accent);
}

.gs-button--primary:hover { background: var(--accent-hover); }

.gs-link {
  display: inline;
  padding: 0;
  border: 0;
  background: none;
  color: var(--vscode-textLink-foreground, var(--accent));
  font-size: inherit;
  cursor: pointer;
  text-decoration: none;
}

.gs-link:hover { text-decoration: underline; color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); }
.gs-link:focus-visible { outline: var(--focus-outline); outline-offset: 1px; border-radius: 2px; }

/* Loading: shimmering placeholder rows instead of a line of text. */
.gs-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: var(--space-2) var(--space-3) var(--space-3);
}

.gs-skeleton__row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 14px;
}

.gs-skeleton__dot,
.gs-skeleton__bar {
  border-radius: var(--radius-pill);
  background: linear-gradient(90deg, var(--control-fill) 0%, var(--control-fill-hover) 40%, var(--control-fill) 80%);
  background-size: 200% 100%;
  animation: gs-shimmer 1.4s var(--ease-standard) infinite;
}

.gs-skeleton__dot { width: 14px; height: 14px; border-radius: 4px; flex: none; }
.gs-skeleton__bar { height: 10px; }

@keyframes gs-shimmer {
  from { background-position: 100% 0; }
  to { background-position: -100% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .gs-skeleton__dot, .gs-skeleton__bar, .gs-section__header, .gs-section__body { animation: none; }
}

.gs-noresults {
  margin: var(--space-6) var(--gs-gutter) 0;
  padding: var(--space-6) var(--space-5);
  border: 1px dashed var(--glass-border);
  border-radius: var(--radius-lg);
  color: var(--text-tertiary);
  font-size: var(--text-sm);
  text-align: center;
}

.gs-noresults[hidden] { display: none; }

/* --- Popover menu (matches the canvas context menu) ------------------------- */

.gs-menu {
  position: fixed;
  z-index: var(--z-menu);
  box-sizing: border-box;
  min-width: 196px;
  max-width: min(280px, calc(100vw - 12px));
  max-height: calc(100vh - 12px);
  overflow-y: auto;
  padding: var(--space-2);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  background: var(--glass-surface-3);
  -webkit-backdrop-filter: var(--glass-backdrop);
  backdrop-filter: var(--glass-backdrop);
  box-shadow: var(--glass-elevation-3);
  color: var(--text-primary);
  font-size: var(--text-sm);
  animation: gs-menu-in var(--duration-base) var(--ease-out);
}

@keyframes gs-menu-in {
  from { opacity: 0; transform: translateY(-3px); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .gs-menu { animation: none; }
}

.gs-menu__title {
  padding: 3px var(--space-4) 4px;
  overflow: hidden;
  color: var(--text-tertiary);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gs-menu__item {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  box-sizing: border-box;
  width: 100%;
  min-height: 26px;
  padding: 0 var(--space-4);
  border: 1px solid var(--control-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
  outline: none;
  transition: background-color var(--duration-fast) var(--ease-standard);
}

/* Pointer hover and keyboard focus light a row; a menu opened by the mouse
   focuses its first entry without lighting it (focus-visible), as macOS does. */
.gs-menu__item:hover,
.gs-menu__item:focus-visible {
  background: var(--glass-tint-accent-strong);
  border-color: var(--control-border-hover);
}

.gs-menu__item:focus { outline: none; }

.gs-menu__item:active { background: var(--control-fill-selected); }

.gs-menu__item-icon {
  display: flex;
  width: 16px;
  flex: none;
  color: var(--text-secondary);
}

.gs-menu__item-icon svg.gs-icon { width: 15px; height: 15px; }

.gs-menu__item-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gs-menu__item--danger { color: var(--error-fg); }
.gs-menu__item--danger:hover, .gs-menu__item--danger:focus-visible { background: var(--glass-tint-error); }

.gs-menu__sep {
  height: 1px;
  margin: var(--space-2) var(--space-4);
  background: var(--glass-divider);
}

.gs-live {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

/* High contrast: hover and selection show as borders (through the tokens);
   hover is dashed, as VS Code draws it, so it never reads as the selection. */
body.vscode-high-contrast .gs-row:hover:not(.is-selected),
body.vscode-high-contrast-light .gs-row:hover:not(.is-selected) {
  border-style: dashed;
}

body.vscode-high-contrast .gs-menu__item:hover,
body.vscode-high-contrast .gs-menu__item:focus-visible,
body.vscode-high-contrast-light .gs-menu__item:hover,
body.vscode-high-contrast-light .gs-menu__item:focus-visible {
  border-color: var(--vscode-contrastActiveBorder, var(--focus-border));
}
`;

// ---------------------------------------------------------------------------
// Script (no template literals or interpolation inside: it is a raw string)
// ---------------------------------------------------------------------------

export const GLASS_SIDEBAR_SCRIPT = String.raw`
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var iconData = JSON.parse(document.getElementById('gs-icons').textContent || '{}');
  var ICONS = iconData.icons || {};
  var FALLBACK = iconData.fallback || '';

  var saved = vscode.getState() || {};
  var ui = {
    expanded: saved.expanded || {},
    collapsedSections: saved.collapsedSections || {},
    selected: saved.selected || null,
    query: typeof saved.query === 'string' ? saved.query : '',
    searchOpen: {}
  };
  var model = { sections: [] };
  var index = {};          // section key -> id -> { node, parent, depth }
  var lastFocus = null;    // { section, id }
  var pendingMenu = null;  // { section, id, anchor }
  var openMenuState = null;
  var pendingExpand = {};  // section/id -> true while the host lists children
  var renderCtx = null;    // per render: which rows the previous DOM showed (new ones enter)
  var rendered = false;
  var introActive = false; // the first render's cards rise in, staggered
  var lastStateJson = null; // the sections of the last 'state' drawn: an identical one is a no-op

  var sectionsEl = document.querySelector('.gs-sections');
  var noResultsEl = document.querySelector('.gs-noresults');
  var searchInput = document.querySelector('.gs-search__input');
  var searchClear = document.querySelector('.gs-search__clear');
  var menuLayer = document.querySelector('.gs-menu-layer');
  var liveEl = document.querySelector('.gs-live');

  // ------------------------------------------------------------------ utils

  function persist() {
    var keys = Object.keys(ui.expanded);
    if (keys.length > 3000) {
      keys.slice(0, keys.length - 3000).forEach(function (k) { delete ui.expanded[k]; });
    }
    vscode.setState({ expanded: ui.expanded, collapsedSections: ui.collapsedSections, selected: ui.selected, query: ui.query });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  // Icons: the constant markup from icons.ts (never host data) is parsed once
  // per id and cloned after that. Host values (ids, colours) only ever pick
  // an entry or go through setAttribute.
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var iconCache = {};

  function icon(id) {
    var key = Object.prototype.hasOwnProperty.call(ICONS, id) ? id : '';
    if (!iconCache[key]) {
      var parsed = new DOMParser().parseFromString(
        '<svg xmlns="' + SVG_NS + '" class="gs-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' + (key ? ICONS[key] : FALLBACK) + '</svg>',
        'image/svg+xml');
      iconCache[key] = document.importNode(parsed.documentElement, true);
    }
    return iconCache[key].cloneNode(true);
  }

  var HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  var COLOR_ID = /^[A-Za-z0-9.]+$/;

  /** A layer swatch: three stacked plates in the layer's colour (built node by node). */
  function swatch(color) {
    var c = HEX.test(color) ? color : 'currentColor';
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('class', 'gs-icon gs-icon--swatch');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    [['M8 2.25 13.75 5.4 8 8.55 2.25 5.4Z', '1'],
     ['M4.1 7.55 2.25 8.55 8 11.7l5.75-3.15-1.85-1L8 9.65Z', '.6'],
     ['M4.1 10.7 2.25 11.7 8 14.85l5.75-3.15-1.85-1L8 12.8Z', '.32']].forEach(function (p) {
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', p[0]);
      path.setAttribute('fill', c);
      path.setAttribute('fill-opacity', p[1]);
      path.setAttribute('stroke', 'none');
      s.appendChild(path);
    });
    return s;
  }

  document.querySelector('.gs-search__icon').appendChild(icon('search'));
  searchClear.appendChild(icon('close'));

  function isLightTheme() {
    var c = document.body.classList;
    return c.contains('vscode-light') || c.contains('vscode-high-contrast-light');
  }

  function rowIcon(spec, node) {
    var holder = el('span', 'gs-row__icon');
    holder.setAttribute('aria-hidden', 'true');
    if (!spec) return holder;
    if (spec.kind === 'theme') {
      holder.appendChild(icon(spec.id));
      if (spec.color && COLOR_ID.test(spec.color)) {
        // As VS Code names a theme colour's variable: only the FIRST dot becomes
        // '-' (erdStudio.layer.gold -> --vscode-erdStudio-layer.gold); any
        // other dot stays in the name, so it is escaped for var().
        holder.style.color = 'var(--vscode-' + spec.color.replace('.', '-').replace(/\./g, '\\.') + ')';
      }
    } else if (spec.kind === 'swatch') {
      holder.appendChild(swatch(spec.color));
      if (HEX.test(spec.color)) holder.style.setProperty('--swatch', spec.color);
    } else if (spec.kind === 'uri') {
      var img = document.createElement('img');
      img.alt = '';
      img.src = isLightTheme() ? spec.light : spec.dark;
      holder.appendChild(img);
    }
    return holder;
  }

  function announce(text) {
    liveEl.textContent = '';
    setTimeout(function () { liveEl.textContent = text; }, 30);
  }

  // --------------------------------------------------------------- the model

  function buildIndex() {
    index = {};
    model.sections.forEach(function (s) {
      var map = {};
      (function walk(nodes, parent, depth) {
        (nodes || []).forEach(function (n) {
          map[n.id] = { node: n, parent: parent, depth: depth };
          if (n.children) walk(n.children, n, depth + 1);
        });
      })(s.nodes, null, 0);
      index[s.key] = map;
    });
  }

  function sectionByKey(key) {
    for (var i = 0; i < model.sections.length; i++) if (model.sections[i].key === key) return model.sections[i];
    return null;
  }

  function query() { return ui.query.trim().toLowerCase(); }

  function matches(n, q) {
    return n.label.toLowerCase().indexOf(q) >= 0 || (n.description || '').toLowerCase().indexOf(q) >= 0;
  }

  /** Search: the ids that match, and the ids that have a matching descendant. */
  function searchSets(section, q) {
    var hit = {}, keep = {};
    (function walk(nodes) {
      var any = false;
      (nodes || []).forEach(function (n) {
        var inside = walk(n.children);
        var self = matches(n, q);
        if (self) hit[n.id] = true;
        if (inside) keep[n.id] = true;
        if (self || inside) any = true;
      });
      return any;
    })(section.nodes);
    return { hit: hit, keep: keep };
  }

  function isExpanded(sectionKey, n, sets) {
    if (!n.collapsible) return false;
    if (sets) {
      if (ui.searchOpen[sectionKey + '\u0000' + n.id] !== undefined) return ui.searchOpen[sectionKey + '\u0000' + n.id];
      return !!sets.keep[n.id];
    }
    var v = ui.expanded[sectionKey + '\u0000' + n.id];
    if (v !== undefined) return v;
    return n.collapsible === 2;
  }

  /** The rows a section shows now, flattened with their depth. */
  function visibleRows(section) {
    var q = query();
    var sets = q ? searchSets(section, q) : null;
    var rows = [];
    (function walk(nodes, depth, parentShowsAll) {
      // Rows are a flat list, so each states its place among its shown siblings.
      var shown = (nodes || []).filter(function (n) { return !sets || parentShowsAll || sets.hit[n.id] || sets.keep[n.id]; });
      shown.forEach(function (n, at) {
        var open = isExpanded(section.key, n, sets);
        rows.push({ node: n, depth: depth, open: open, pos: at + 1, size: shown.length });
        if (open) {
          if (n.childrenLoaded === false) {
            rows.push({ loading: true, depth: depth + 1, parent: n });
          } else {
            // A matched row the user opened shows all of its children.
            var showAll = !sets || parentShowsAll || (sets.hit[n.id] && ui.searchOpen[section.key + '\u0000' + n.id] === true);
            walk(n.children, depth + 1, showAll);
          }
        }
      });
    })(section.nodes, 0, false);
    return { rows: rows, sets: sets };
  }

  // -------------------------------------------------------------- rendering

  function highlightInto(target, text, ranges, q) {
    var marks = [];
    (ranges || []).forEach(function (r) { marks.push([r[0], r[1]]); });
    if (q) {
      var at = text.toLowerCase().indexOf(q);
      if (at >= 0) marks.push([at, at + q.length]);
    }
    if (!marks.length) { target.textContent = text; return; }
    marks.sort(function (a, b) { return a[0] - b[0]; });
    var pos = 0;
    marks.forEach(function (m) {
      var s = Math.max(m[0], pos), e = Math.min(m[1], text.length);
      if (e <= s) return;
      if (s > pos) target.appendChild(document.createTextNode(text.slice(pos, s)));
      target.appendChild(el('mark', 'gs-mark', text.slice(s, e)));
      pos = e;
    });
    if (pos < text.length) target.appendChild(document.createTextNode(text.slice(pos)));
  }

  function rowKind(section, n) {
    var cv = n.contextValue || '';
    var cls = '';
    if ((n.icon && n.icon.kind === 'swatch') || /^(layer|tableLibraryLayer|relationshipsLayer)/.test(cv) || (n.icon && n.icon.kind === 'theme' && n.icon.id === 'layers')) cls += ' gs-row--group';
    if (/^(newDomain|newLayer)$/.test(cv) || (n.icon && n.icon.kind === 'theme' && (n.icon.id === 'add' || n.icon.id === 'new-folder') && !n.collapsible)) cls += ' gs-row--action';
    if (cv === 'filterNoMatch') cls += ' gs-row--quiet';
    return cls;
  }

  /** The open menu's owner (identifiers, never elements: a render may replace them). */
  function menuOwner() { return openMenuState ? openMenuState.owner : null; }

  function renderRow(section, r, sets, pickId) {
    var row = el('div', 'gs-row');
    if (r.loading) {
      row.className += ' gs-row--loading';
      row.dataset.loading = r.parent.id;
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(r.depth + 1));
      row.style.setProperty('--depth', String(r.depth));
      row.setAttribute('aria-busy', 'true');
      row.setAttribute('aria-label', 'Loading ' + r.parent.label);
      addGuides(row, r.depth);
      row.appendChild(el('span', 'gs-row__twistie'));
      var spin = el('span', 'gs-spinner');
      spin.setAttribute('aria-hidden', 'true');
      row.appendChild(spin);
      row.appendChild(el('span', 'gs-row__text', 'Loading…'));
      return row;
    }
    var n = r.node;
    row.className += rowKind(section, n);
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(r.depth + 1));
    row.setAttribute('aria-posinset', String(r.pos));
    row.setAttribute('aria-setsize', String(r.size));
    // Roving tabindex: one row in the tree takes Tab.
    row.setAttribute('tabindex', n.id === pickId ? '0' : '-1');
    row.dataset.id = n.id;
    row.dataset.section = section.key;
    row.style.setProperty('--depth', String(r.depth));
    // The live row is patched in place (reconcile), so a changed aria-expanded
    // turns the chevron through its CSS transition.
    if (n.collapsible) row.setAttribute('aria-expanded', r.open ? 'true' : 'false');
    if (renderCtx && renderCtx.animateNew && !renderCtx.ids[section.key + '\u0000' + n.id]) row.className += ' gs-row--enter';
    var selected = ui.selected && ui.selected.section === section.key && ui.selected.id === n.id;
    row.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected) row.className += ' is-selected';
    var owner = menuOwner();
    var ownsMenu = !!(owner && owner.id === n.id && owner.section === section.key);
    if (ownsMenu) row.className += ' is-menu-open';
    var aria = n.label + (n.description ? ', ' + n.description : '');
    row.setAttribute('aria-label', aria);
    if (n.tooltip) row.title = n.tooltip;

    addGuides(row, r.depth);
    var tw = el('span', 'gs-row__twistie');
    tw.setAttribute('aria-hidden', 'true');
    if (n.collapsible) { tw.appendChild(icon('chevron-right')); tw.dataset.role = 'twistie'; }
    row.appendChild(tw);
    row.appendChild(rowIcon(n.icon, n));

    var text = el('span', 'gs-row__text');
    var label = el('span', 'gs-row__label');
    highlightInto(label, n.label, n.highlights, sets ? query() : '');
    text.appendChild(label);
    if (n.description) {
      var desc = el('span', 'gs-row__desc');
      highlightInto(desc, n.description, null, sets ? query() : '');
      text.appendChild(desc);
    }
    row.appendChild(text);

    // Buttons carry what they are (data-act, data-i), never a handler: clicks
    // are delegated (sectionsEl), and look the entry up in the current model.
    if ((n.inline && n.inline.length) || n.hasMenu) {
      var actions = el('span', 'gs-row__actions');
      (n.inline || []).forEach(function (a, i) {
        var b = el('button', 'gs-iconbtn');
        b.type = 'button';
        b.tabIndex = -1;
        b.title = a.title;
        b.setAttribute('aria-label', a.title);
        b.dataset.act = 'inline';
        b.dataset.i = String(i);
        b.dataset.slot = 'i' + i;
        b.appendChild(icon(a.icon || ''));
        actions.appendChild(b);
      });
      if (n.hasMenu) {
        var more = el('button', 'gs-iconbtn');
        more.type = 'button';
        more.tabIndex = -1;
        more.title = 'More Actions…';
        more.setAttribute('aria-label', 'More actions for ' + n.label);
        more.setAttribute('aria-haspopup', 'menu');
        more.setAttribute('aria-expanded', ownsMenu && owner.slot === 'more' ? 'true' : 'false');
        more.dataset.act = 'row-more';
        more.dataset.slot = 'more';
        more.appendChild(icon('ellipsis'));
        actions.appendChild(more);
      }
      row.appendChild(actions);
    }
    return row;
  }

  function addGuides(row, depth) {
    for (var level = 0; level < depth; level++) {
      var g = el('span', 'gs-guide');
      g.style.setProperty('--level', String(level));
      row.appendChild(g);
    }
  }

  function countText(section) {
    if (!section.count) return '';
    var m = /^([0-9][0-9,]*)/.exec(section.count);
    return m ? m[1] : section.count;
  }

  function renderHeader(section, collapsed, searching, hits) {
    var header = el('div', 'gs-section__header');
    var toggle = el('button', 'gs-section__toggle');
    toggle.type = 'button';
    toggle.dataset.act = 'toggle';
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.setAttribute('aria-controls', 'gs-body-' + section.key);
    toggle.id = 'gs-head-' + section.key;
    var chev = el('span', 'gs-section__chevron');
    chev.setAttribute('aria-hidden', 'true');
    chev.appendChild(icon('chevron-right'));
    toggle.appendChild(chev);
    toggle.appendChild(el('span', 'gs-section__title', section.title));
    // While searching, the pill counts this section's matches (accent); otherwise the view's total.
    if (searching) {
      var found = el('span', 'gs-section__count gs-section__count--hits', String(hits));
      found.title = hits + (hits === 1 ? ' match' : ' matches');
      toggle.appendChild(found);
    } else {
      var count = countText(section);
      if (count && !section.filter) {
        var pill = el('span', 'gs-section__count', count);
        pill.title = section.count;
        toggle.appendChild(pill);
      }
    }
    if (searching) toggle.setAttribute('aria-disabled', 'true');
    header.appendChild(toggle);

    if (section.filter) {
      var chip = el('span', 'gs-section__filter');
      chip.title = 'Filtered: ' + section.filter;
      chip.appendChild(icon('filter-filled'));
      chip.appendChild(el('span', '', section.filter));
      header.appendChild(chip);
    }

    var owner = menuOwner();
    var ownsMenu = !!(owner && !owner.id && owner.section === section.key);
    var actions = el('div', 'gs-section__actions' + (ownsMenu ? ' is-open' : ''));
    (section.actions.navigation || []).forEach(function (a, i) {
      var b = el('button', 'gs-iconbtn' + (a.icon ? '' : ' gs-iconbtn--text'));
      b.type = 'button';
      b.title = a.title.replace(/…$/, '');
      b.setAttribute('aria-label', a.title);
      b.dataset.act = 'title';
      b.dataset.i = String(i);
      b.dataset.slot = 'n' + i;
      if (a.icon) b.appendChild(icon(a.icon)); else b.textContent = a.title;
      if (a.submenu) {
        b.setAttribute('aria-haspopup', 'menu');
        b.setAttribute('aria-expanded', ownsMenu && owner.slot === b.dataset.slot ? 'true' : 'false');
      }
      actions.appendChild(b);
    });
    if (section.actions.groups && section.actions.groups.length) {
      var more = el('button', 'gs-iconbtn');
      more.type = 'button';
      more.title = 'More Actions…';
      more.setAttribute('aria-label', section.title + ': more actions');
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', ownsMenu && owner.slot === 'more' ? 'true' : 'false');
      more.dataset.act = 'title-more';
      more.dataset.slot = 'more';
      more.appendChild(icon('ellipsis'));
      actions.appendChild(more);
    }
    header.appendChild(actions);
    return header;
  }

  /** An overflow group may hold a submenu: its entries are listed in place. */
  function flattenSub(group) {
    var out = [];
    group.forEach(function (a) {
      if (a.submenu) a.submenu.forEach(function (g) { g.forEach(function (x) { out.push(x); }); });
      else out.push(a);
    });
    return out;
  }

  function titleItem(section) {
    return function (a) {
      return { title: a.title, icon: a.icon, run: function () { post({ type: 'invoke', section: section.key, menu: a.menu, index: a.index }); } };
    };
  }

  function welcomeTarget(b, entry, link) {
    b.dataset.act = 'welcome';
    b.dataset.entry = String(entry);
    b.dataset.link = String(link);
  }

  var WELCOME_GLYPH = { diagrams: 'layers', tables: 'symbol-class', relationships: 'references', help: 'question' };

  function renderWelcome(section) {
    var wrap = el('div', 'gs-welcome');
    var welcome = section.welcome || [];
    var onlyText = welcome.length === 1 && welcome[0].paragraphs.length === 1 && welcome[0].paragraphs[0].parts.length === 1 && welcome[0].paragraphs[0].parts[0].kind === 'text';
    if (onlyText && /^Loading/.test(welcome[0].paragraphs[0].parts[0].text)) {
      var sk = el('div', 'gs-skeleton');
      sk.setAttribute('role', 'status');
      sk.setAttribute('aria-label', welcome[0].paragraphs[0].parts[0].text);
      [72, 54, 64].forEach(function (w) {
        var line = el('div', 'gs-skeleton__row');
        line.appendChild(el('span', 'gs-skeleton__dot'));
        var bar = el('span', 'gs-skeleton__bar');
        bar.style.width = w + '%';
        line.appendChild(bar);
        sk.appendChild(line);
      });
      return sk;
    }
    var glyph = el('span', 'gs-welcome__glyph gs-welcome__glyph--' + section.key);
    glyph.setAttribute('aria-hidden', 'true');
    glyph.appendChild(icon(WELCOME_GLYPH[section.key] || 'sparkle'));
    wrap.appendChild(glyph);
    var firstButton = true, leadDone = false;
    welcome.forEach(function (entry) {
      entry.paragraphs.forEach(function (p) {
        // The opening sentence ("No tables yet.") reads as the state's title.
        if (!leadDone) {
          leadDone = true;
          if (!p.button && p.parts.length === 1 && p.parts[0].kind === 'text') {
            var m = /^([^.!?]{1,40}[.!?])(?:\s+([\s\S]+))?$/.exec(p.parts[0].text.trim());
            if (m) {
              wrap.appendChild(el('p', 'gs-welcome__lead', m[1]));
              if (m[2]) wrap.appendChild(el('p', '', m[2]));
              return;
            }
          }
        }
        if (p.button) {
          var part = p.parts[0];
          var b = el('button', 'gs-button' + (firstButton ? ' gs-button--primary' : ''), part.label);
          firstButton = false;
          b.type = 'button';
          welcomeTarget(b, entry.entry, part.link);
          wrap.appendChild(b);
          return;
        }
        var para = el('p');
        p.parts.forEach(function (part) {
          if (part.kind === 'text') { para.appendChild(document.createTextNode(part.text)); return; }
          var a = el('button', 'gs-link', part.label);
          a.type = 'button';
          welcomeTarget(a, entry.entry, part.link);
          para.appendChild(a);
        });
        wrap.appendChild(para);
      });
    });
    return wrap;
  }

  // Rendering builds the wanted DOM off-document, then reconciles the live
  // DOM to it: cards and rows are matched by key and patched in place, so an
  // unchanged row is never re-inserted. The row under a resting pointer keeps
  // its :hover (no replayed fill, fade-in or tooltip delay), and focus, open
  // menus, running spinners and the chevron's turn all survive a new state.

  /** A child's identity among its siblings: cards by section, rows by id; null for the rest (matched by position). */
  function keyOf(node) {
    if (node.nodeType !== 1) return null;
    if (node.hasAttribute('data-key')) return 'c' + node.getAttribute('data-key');
    if (node.hasAttribute('data-id')) return 'r' + node.getAttribute('data-id');
    if (node.hasAttribute('data-loading')) return 'l' + node.getAttribute('data-loading');
    return null;
  }

  function syncAttrs(a, b) {
    var i, at;
    for (i = a.attributes.length - 1; i >= 0; i--) {
      at = a.attributes[i];
      if (!b.hasAttribute(at.name)) a.removeAttribute(at.name);
    }
    for (i = 0; i < b.attributes.length; i++) {
      at = b.attributes[i];
      if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
    }
  }

  /** Make live node a match fresh node b (same type and tag). Writes only what differs. */
  function patch(a, b) {
    if (a.nodeType === 3) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
    if (a.nodeType !== 1) return;
    syncAttrs(a, b);
    reconcile(a, Array.prototype.slice.call(b.childNodes));
  }

  /**
   * Make parent's children match fresh (a list of off-document nodes). Keyed
   * children are reused by key, the rest by position and tag. A reused node
   * is moved only when it is out of order; nothing is touched when nothing
   * changed.
   */
  function reconcile(parent, fresh) {
    var live = Array.prototype.slice.call(parent.childNodes);
    var byKey = new Map();
    live.forEach(function (x) { var k = keyOf(x); if (k !== null && !byKey.has(k)) byKey.set(k, x); });
    var wanted = new Set();
    fresh.forEach(function (y) { var k = keyOf(y); if (k !== null) wanted.add(k); });
    var used = new Set();
    var cursor = parent.firstChild;
    // Step over live nodes that will not be reused in place (removed at the end), so they never force a move.
    function settle() {
      while (cursor) {
        var k = keyOf(cursor);
        if (used.has(cursor) || (k !== null && (!wanted.has(k) || byKey.get(k) !== cursor))) { cursor = cursor.nextSibling; continue; }
        break;
      }
    }
    fresh.forEach(function (y) {
      settle();
      var k = keyOf(y), x = null;
      if (k !== null) {
        var c = byKey.get(k);
        if (c && !used.has(c) && c.nodeName === y.nodeName) x = c;
      } else if (cursor && keyOf(cursor) === null && cursor.nodeType === y.nodeType && cursor.nodeName === y.nodeName) {
        x = cursor;
      }
      if (x) {
        used.add(x);
        patch(x, y);
        if (x === cursor) cursor = cursor.nextSibling;
        else parent.insertBefore(x, cursor);
      } else {
        parent.insertBefore(y, cursor);
      }
    });
    live.forEach(function (x) { if (!used.has(x) && x.parentNode === parent) parent.removeChild(x); });
  }

  function cardEl(key) {
    var list = cards();
    for (var i = 0; i < list.length; i++) if (list[i].dataset.key === key) return list[i];
    return null;
  }

  /** What has keyboard focus in the list, by identity (the element itself may be replaced). */
  function captureFocus() {
    var a = document.activeElement;
    if (!a || a === document.body || !sectionsEl.contains(a)) return null;
    var card = a.closest('.gs-section');
    var row = a.closest('.gs-row[data-id]');
    return {
      el: a,
      section: card ? card.dataset.key : null,
      id: row ? row.dataset.id : null,
      onRow: a === row,
      act: a.getAttribute('data-act'),
      slot: a.getAttribute('data-slot'),
      entry: a.getAttribute('data-entry'),
      link: a.getAttribute('data-link')
    };
  }

  function focusTarget(k) {
    var card = k.section && cardEl(k.section);
    if (!card) return null;
    if (k.id) {
      var row = rowEl(k.section, k.id);
      if (!row || k.onRow || !k.slot) return row;
      return row.querySelector('.gs-row__actions [data-slot="' + k.slot + '"]') || row;
    }
    if (k.act === 'toggle') return document.getElementById('gs-head-' + k.section);
    if (k.slot) return card.querySelector('.gs-section__actions [data-slot="' + k.slot + '"]');
    if (k.act === 'welcome') {
      var links = card.querySelectorAll('[data-act="welcome"]');
      for (var i = 0; i < links.length; i++) {
        if (links[i].getAttribute('data-entry') === k.entry && links[i].getAttribute('data-link') === k.link) return links[i];
      }
    }
    return null;
  }

  /** Put focus back when the render removed the focused element (and only then). */
  function restoreFocus(k) {
    if (!k || k.el.isConnected) return;
    var now = document.activeElement;
    if (now && now !== document.body) return;
    var target = focusTarget(k);
    if (target) target.focus({ preventScroll: true });
  }

  function render() {
    var prevIds = {};
    var existing = sectionsEl.querySelectorAll('.gs-row[data-id]');
    for (var e = 0; e < existing.length; e++) {
      prevIds[existing[e].dataset.section + '\u0000' + existing[e].dataset.id] = true;
    }
    renderCtx = { ids: prevIds, animateNew: rendered && existing.length > 0 && !query() };
    var intro = !rendered;
    rendered = true;
    if (intro) introActive = true;
    var scrollY = window.scrollY;
    var focus = lastFocus;
    var focusKey = captureFocus();
    var q = query();
    var searching = !!q;
    var anyVisible = false;
    var fresh = [];
    model.sections.forEach(function (section, i) {
      if (!section.visible) return;
      var vis = visibleRows(section);
      if (searching && vis.rows.length === 0) return;
      anyVisible = true;
      var collapsed = !searching && (ui.collapsedSections[section.key] !== undefined ? ui.collapsedSections[section.key] : section.defaultCollapsed);
      var card = el('section', 'gs-section' + (collapsed ? ' gs-section--collapsed' : '') + (section.key === 'help' ? ' gs-section--help' : ''));
      card.dataset.key = section.key;
      if (introActive) card.style.animationDelay = (i * 40) + 'ms';
      card.setAttribute('aria-labelledby', 'gs-head-' + section.key);
      card.appendChild(renderHeader(section, collapsed, searching, vis.sets ? Object.keys(vis.sets.hit).length : 0));
      var body = el('div', 'gs-section__body');
      body.id = 'gs-body-' + section.key;
      var inner = el('div', 'gs-section__inner');
      var content = el('div', 'gs-section__content');
      if (vis.rows.length === 0) {
        content.appendChild(renderWelcome(section));
      } else {
        var tree = el('div', 'gs-tree');
        tree.setAttribute('role', 'tree');
        tree.setAttribute('aria-label', section.title);
        tree.dataset.section = section.key;
        var flat = !vis.rows.some(function (r) { return r.node && r.node.collapsible; }) && vis.rows.every(function (r) { return r.depth === 0; });
        if (flat) tree.className += ' gs-tree--flat';
        // The row that takes Tab: the last focused, else the selected, else the first.
        var ids = {}, firstId = null, pickId = null;
        vis.rows.forEach(function (r) { if (r.node) { ids[r.node.id] = true; if (firstId === null) firstId = r.node.id; } });
        if (focus && focus.section === section.key && ids[focus.id]) pickId = focus.id;
        else if (ui.selected && ui.selected.section === section.key && ids[ui.selected.id]) pickId = ui.selected.id;
        else pickId = firstId;
        vis.rows.forEach(function (r) { tree.appendChild(renderRow(section, r, vis.sets, pickId)); });
        content.appendChild(tree);
      }
      inner.appendChild(content);
      body.appendChild(inner);
      card.appendChild(body);
      fresh.push(card);
    });
    pinHeaders(fresh);
    reconcile(sectionsEl, fresh);
    markParked();
    if (sectionsEl.getAttribute('aria-busy') !== 'false') sectionsEl.setAttribute('aria-busy', 'false');
    if (intro) {
      sectionsEl.classList.add('gs-sections--intro');
      setTimeout(function () {
        introActive = false;
        sectionsEl.classList.remove('gs-sections--intro');
        cards().forEach(function (c) { c.style.animationDelay = ''; });
      }, 700);
    }
    renderCtx = null;
    var showNone = searching && !anyVisible;
    if (noResultsEl.hidden !== !showNone) noResultsEl.hidden = !showNone;
    if (showNone) {
      var none = 'Nothing matches “' + ui.query.trim() + '”.';
      if (noResultsEl.textContent !== none) noResultsEl.textContent = none;
    }
    if (searchClear.hidden !== !ui.query) searchClear.hidden = !ui.query;
    restoreFocus(focusKey);
    // Only when the rebuild moved it: an unconditional scrollTo would cut a smooth scroll short.
    if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
  }

  function rowEl(sectionKey, id) {
    var rows = document.querySelectorAll('.gs-tree[data-section="' + sectionKey + '"] .gs-row[data-id]');
    for (var i = 0; i < rows.length; i++) if (rows[i].dataset.id === id) return rows[i];
    return null;
  }

  // ----------------------------------------------------------------- actions

  function post(message) { vscode.postMessage(message); }

  function setExpanded(sectionKey, id, open) {
    var info = index[sectionKey] && index[sectionKey][id];
    if (!info || !info.node.collapsible) return;
    var key = sectionKey + '\u0000' + id;
    if (query()) ui.searchOpen[key] = open;
    else ui.expanded[key] = open;
    if (open && info.node.childrenLoaded === false && !pendingExpand[key]) {
      pendingExpand[key] = true;
      post({ type: 'expand', section: sectionKey, id: id });
    }
    persist();
    render();
  }

  function toggle(sectionKey, id) {
    var row = rowEl(sectionKey, id);
    setExpanded(sectionKey, id, !(row && row.getAttribute('aria-expanded') === 'true'));
  }

  function select(sectionKey, id) {
    ui.selected = { section: sectionKey, id: id };
    lastFocus = { section: sectionKey, id: id };
    var prev = document.querySelectorAll('.gs-row.is-selected');
    for (var i = 0; i < prev.length; i++) { prev[i].classList.remove('is-selected'); prev[i].setAttribute('aria-selected', 'false'); }
    var row = rowEl(sectionKey, id);
    if (row) { row.classList.add('is-selected'); row.setAttribute('aria-selected', 'true'); }
    persist();
  }

  function activate(sectionKey, id) {
    var info = index[sectionKey] && index[sectionKey][id];
    if (!info) return;
    select(sectionKey, id);
    if (info.node.hasCommand) post({ type: 'activate', section: sectionKey, id: id });
    else if (info.node.collapsible) toggle(sectionKey, id);
  }

  /** The host answers with itemMenu; the menu opens then, at the anchor. slot: the row button that asked ('more'), if any. */
  function requestItemMenu(sectionKey, id, anchor, slot) {
    var info = index[sectionKey] && index[sectionKey][id];
    if (!info || !info.node.hasMenu) return;
    pendingMenu = { section: sectionKey, id: id, anchor: anchor, slot: slot || null };
    post({ type: 'itemMenu', section: sectionKey, id: id });
  }

  /** Under a button, right-aligned with it; above it when there is no room below. */
  function buttonAnchor(button) {
    var r = button.getBoundingClientRect();
    return { x: r.right, y: r.bottom + 4, top: r.top - 4, alignRight: true };
  }

  /** Under a row (keyboard), indented past its chevron. */
  function rowAnchor(row) {
    var r = row.getBoundingClientRect();
    var label = row.querySelector('.gs-row__label');
    var x = label ? label.getBoundingClientRect().left - 8 : r.left + 24;
    return { x: x, y: r.bottom + 2, top: r.top - 2 };
  }

  /** A click on a button the render marked with data-act: look its entry up in the current model. */
  function runAct(b) {
    var card = b.closest('.gs-section');
    var section = card && sectionByKey(card.dataset.key);
    if (!section) return;
    var act = b.getAttribute('data-act');
    var i = Number(b.getAttribute('data-i'));
    if (act === 'toggle') {
      // An open section whose header is parked away from it: the click brings it back.
      var parkedHead = b.closest('.gs-section__header');
      if (parkedHead && parkedHead.classList.contains('is-parked') && !card.classList.contains('gs-section--collapsed')) {
        bringSectionBack(card);
        return;
      }
      // In place (no re-render), so the body folds and the chevron turns.
      setSectionCollapsed(card, !card.classList.contains('gs-section--collapsed'));
    } else if (act === 'welcome') {
      post({ type: 'welcomeLink', section: section.key, entry: Number(b.getAttribute('data-entry')), link: Number(b.getAttribute('data-link')) });
    } else if (act === 'title') {
      var a = (section.actions.navigation || [])[i];
      if (!a) return;
      if (a.submenu) {
        if (swallowReopen(b)) return;
        openMenu(a.submenu.map(function (g) { return g.map(titleItem(section)); }), buttonAnchor(b), { section: section.key, slot: b.getAttribute('data-slot'), title: a.title });
      } else {
        post({ type: 'invoke', section: section.key, menu: a.menu, index: a.index });
      }
    } else if (act === 'title-more') {
      if (swallowReopen(b)) return;
      openMenu((section.actions.groups || []).map(function (g) { return flattenSub(g).map(titleItem(section)); }), buttonAnchor(b), { section: section.key, slot: 'more', title: section.title });
    } else {
      var row = b.closest('.gs-row[data-id]');
      var info = row && index[section.key] && index[section.key][row.dataset.id];
      if (!info) return;
      if (act === 'inline') {
        var x = (info.node.inline || [])[i];
        if (x) post({ type: 'invoke', section: section.key, id: info.node.id, menu: x.menu, index: x.index });
      } else if (act === 'row-more') {
        if (swallowReopen(b)) return;
        select(section.key, info.node.id);
        requestItemMenu(section.key, info.node.id, buttonAnchor(b), 'more');
      }
    }
  }

  sectionsEl.addEventListener('click', function (ev) {
    var act = ev.target.closest && ev.target.closest('[data-act]');
    if (act && sectionsEl.contains(act)) { runAct(act); return; }
    var row = ev.target.closest && ev.target.closest('.gs-row[data-id]');
    if (!row) return;
    var sectionKey = row.dataset.section, id = row.dataset.id;
    if (ev.target.closest('[data-role="twistie"]')) {
      select(sectionKey, id);
      toggle(sectionKey, id);
      return;
    }
    activate(sectionKey, id);
  });

  sectionsEl.addEventListener('dblclick', function (ev) {
    var row = ev.target.closest && ev.target.closest('.gs-row[data-id]');
    if (!row || ev.target.closest('.gs-row__actions') || ev.target.closest('[data-role="twistie"]')) return;
    var info = index[row.dataset.section] && index[row.dataset.section][row.dataset.id];
    if (info && info.node.collapsible && info.node.hasCommand) toggle(row.dataset.section, row.dataset.id);
  });

  sectionsEl.addEventListener('contextmenu', function (ev) {
    var row = ev.target.closest && ev.target.closest('.gs-row[data-id]');
    ev.preventDefault();
    if (!row) return;
    select(row.dataset.section, row.dataset.id);
    // A pointer opens it at the pointer; the keyboard's ContextMenu key (no coordinates) under the row.
    var anchor = ev.button === 2 || ev.clientX || ev.clientY ? { x: ev.clientX + 2, y: ev.clientY + 2, top: ev.clientY - 2 } : rowAnchor(row);
    requestItemMenu(row.dataset.section, row.dataset.id, anchor);
  });

  sectionsEl.addEventListener('focusin', function (ev) {
    var row = ev.target.closest && ev.target.closest('.gs-row[data-id]');
    if (!row) return;
    lastFocus = { section: row.dataset.section, id: row.dataset.id };
    var tree = row.closest('.gs-tree');
    var rows = tree.querySelectorAll('.gs-row[data-id]');
    for (var i = 0; i < rows.length; i++) {
      var want = rows[i] === row ? 0 : -1;
      if (rows[i].tabIndex !== want) rows[i].tabIndex = want;
    }
  });

  // A row's entrance animation runs once; drop its class after, so nothing can replay it.
  sectionsEl.addEventListener('animationend', function (ev) {
    var t = ev.target;
    if (ev.animationName === 'gs-row-in' && t.classList && t.classList.contains('gs-row--enter')) t.classList.remove('gs-row--enter');
  });

  // Outside the rows (empty space, the search strip's padding) there is no
  // menu to offer: keep VS Code's webview menu away too. Text fields keep it
  // (Cut / Copy / Paste).
  document.addEventListener('contextmenu', function (ev) {
    if (ev.defaultPrevented) return;
    var t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    ev.preventDefault();
  });

  // ---------------------------------------------------------------- keyboard

  function rowsOf(tree) { return Array.prototype.slice.call(tree.querySelectorAll('.gs-row[data-id]')); }

  function focusRow(row) {
    if (!row) return;
    row.focus();
    row.scrollIntoView({ block: 'nearest' });
  }

  sectionsEl.addEventListener('keydown', function (ev) {
    var row = ev.target.closest && ev.target.closest('.gs-row[data-id]');
    if (!row || ev.target !== row) return;
    var tree = row.closest('.gs-tree');
    var rows = rowsOf(tree);
    var i = rows.indexOf(row);
    var sectionKey = row.dataset.section, id = row.dataset.id;
    var info = index[sectionKey][id];
    var expanded = row.getAttribute('aria-expanded') === 'true';
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        if (i === rows.length - 1) focusSectionHead(nextSectionKey(sectionKey, 1));
        else focusRow(rows[i + 1]);
        break;
      case 'ArrowUp':
        ev.preventDefault();
        if (i === 0) focusSectionHead(sectionKey);
        else focusRow(rows[i - 1]);
        break;
      case 'Home': ev.preventDefault(); focusRow(rows[0]); break;
      case 'End': ev.preventDefault(); focusRow(rows[rows.length - 1]); break;
      case 'ArrowRight':
        ev.preventDefault();
        if (info.node.collapsible && !expanded) setExpanded(sectionKey, id, true);
        else if (expanded) focusRow(rows[i + 1]);
        break;
      case 'ArrowLeft':
        ev.preventDefault();
        if (expanded) setExpanded(sectionKey, id, false);
        else if (info.parent && rowEl(sectionKey, info.parent.id)) focusRow(rowEl(sectionKey, info.parent.id));
        else focusSectionHead(sectionKey);
        break;
      case 'Enter':
      case ' ':
        ev.preventDefault();
        activate(sectionKey, id);
        break;
      case 'ContextMenu':
        ev.preventDefault();
        select(sectionKey, id);
        requestItemMenu(sectionKey, id, rowAnchor(row));
        break;
      case 'F10':
        if (ev.shiftKey) {
          ev.preventDefault();
          select(sectionKey, id);
          requestItemMenu(sectionKey, id, rowAnchor(row));
        }
        break;
      default: break;
    }
  });

  // Section headers join the arrow-key path: Down enters the section's tree
  // (or the next header when it is folded or empty), Up leaves for the
  // previous section's last row; Left / Right fold and unfold.
  function cards() { return Array.prototype.slice.call(sectionsEl.querySelectorAll('.gs-section')); }

  function nextSectionKey(key, step) {
    var list = cards();
    for (var i = 0; i < list.length; i++) {
      if (list[i].dataset.key === key) return list[i + step] ? list[i + step].dataset.key : null;
    }
    return null;
  }

  function focusSectionHead(key) {
    var head = key && document.getElementById('gs-head-' + key);
    if (head) { head.focus(); head.scrollIntoView({ block: 'nearest' }); }
  }

  /**
   * Keeps every section header in view: each gets the sticky offsets that
   * stack it under the search field (after the headers above it) and above
   * the foot of the pane (before the headers below it). When the headers
   * alone would take over half the pane, nothing is pinned.
   */
  function pinHeaders(list) {
    var search = document.querySelector('.gs-search');
    var head = sectionsEl.querySelector('.gs-section__header');
    // Parked headers stack almost touching: no room between two for the rows passing under to show.
    var gap = 2;
    var slot = (head ? head.offsetHeight : 38) + gap;
    var top = search ? search.offsetHeight : 0;
    var pin = list.length > 1 && list.length * slot <= (window.innerHeight - top) / 2;
    list.forEach(function (c, k) {
      if (pin) {
        c.style.setProperty('--gs-pin-top', (top + k * slot) + 'px');
        c.style.setProperty('--gs-pin-bottom', (gap + (list.length - 1 - k) * slot) + 'px');
      } else {
        c.style.removeProperty('--gs-pin-top');
        c.style.removeProperty('--gs-pin-bottom');
      }
    });
  }

  /**
   * Marks the headers held at their parking place (is-stuck), and of those
   * the ones that stand alone there: folded, or open with the body scrolled
   * out from under them (is-parked). Runs after a render and on scroll.
   */
  function markParked() {
    cards().forEach(function (c) {
      var head = c.querySelector('.gs-section__header');
      var body = c.querySelector('.gs-section__body');
      if (!head || !body) return;
      var pinTop = parseFloat(c.style.getPropertyValue('--gs-pin-top'));
      var pinBottom = parseFloat(c.style.getPropertyValue('--gs-pin-bottom'));
      var stuck = false, parked = false;
      if (!isNaN(pinTop)) {
        var hr = head.getBoundingClientRect();
        var atTop = hr.top <= pinTop + 0.5;
        var atBottom = hr.bottom >= window.innerHeight - pinBottom - 0.5;
        stuck = atTop || atBottom;
        // Detached: the body is still below the pane's foot, or has scrolled out above.
        var br = body.getBoundingClientRect();
        parked = stuck && (c.classList.contains('gs-section--collapsed') || br.top > hr.bottom + 1 || br.bottom <= hr.bottom + 1);
      }
      if (head.classList.contains('is-stuck') !== stuck) head.classList.toggle('is-stuck', stuck);
      if (head.classList.contains('is-parked') !== parked) head.classList.toggle('is-parked', parked);
    });
  }

  /** Scrolls an open section whose header is parked back under that header. */
  function bringSectionBack(card) {
    var head = card.querySelector('.gs-section__header');
    var body = card.querySelector('.gs-section__body');
    var pinTop = parseFloat(card.style.getPropertyValue('--gs-pin-top')) || 0;
    var y = body.getBoundingClientRect().top + window.scrollY - pinTop - head.offsetHeight;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }

  function setSectionCollapsed(card, collapsed) {
    var key = card.dataset.key;
    if (query()) return;
    ui.collapsedSections[key] = collapsed;
    persist();
    card.classList.toggle('gs-section--collapsed', collapsed);
    var head = document.getElementById('gs-head-' + key);
    if (head) head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    markParked();
    // Again once the body has folded or opened: the headers below have moved.
    setTimeout(markParked, 320);
  }

  sectionsEl.addEventListener('keydown', function (ev) {
    if (!ev.target.classList || !ev.target.classList.contains('gs-section__toggle')) return;
    var card = ev.target.closest('.gs-section');
    var collapsed = card.classList.contains('gs-section--collapsed');
    var rows = collapsed ? [] : card.querySelectorAll('.gs-row[data-id]');
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (rows.length) focusRow(rows[0]); else focusSectionHead(nextSectionKey(card.dataset.key, 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      var prevKey = nextSectionKey(card.dataset.key, -1);
      var prevCard = prevKey && sectionsEl.querySelector('.gs-section[data-key="' + prevKey + '"]');
      var prevRows = prevCard && !prevCard.classList.contains('gs-section--collapsed') ? prevCard.querySelectorAll('.gs-row[data-id]') : [];
      if (prevRows.length) focusRow(prevRows[prevRows.length - 1]); else focusSectionHead(prevKey);
    } else if (ev.key === 'ArrowRight' && collapsed) {
      ev.preventDefault();
      setSectionCollapsed(card, false);
    } else if (ev.key === 'ArrowLeft' && !collapsed) {
      ev.preventDefault();
      setSectionCollapsed(card, true);
    }
  });

  // ------------------------------------------------------------------ search

  var persistTimer = null, announceTimer = null, searchFrame = 0;
  searchInput.value = ui.query;
  searchInput.addEventListener('input', function () {
    ui.query = searchInput.value;
    ui.searchOpen = {};
    searchClear.hidden = !ui.query;
    // One render per frame, however fast the typing.
    if (!searchFrame) searchFrame = requestAnimationFrame(function () { searchFrame = 0; render(); });
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 250);
    clearTimeout(announceTimer);
    announceTimer = setTimeout(function () {
      if (!query()) return;
      var n = document.querySelectorAll('.gs-row[data-id] .gs-mark').length;
      announce(n ? n + (n === 1 ? ' match' : ' matches') : 'No matches');
    }, 400);
  });
  searchInput.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && searchInput.value) {
      ev.preventDefault();
      clearSearch();
    } else if (ev.key === 'ArrowDown' || ev.key === 'Enter') {
      var first = document.querySelector('.gs-row[data-id]');
      if (first) { ev.preventDefault(); focusRow(first); }
    }
  });
  function clearSearch(keepFocus) {
    searchInput.value = '';
    ui.query = '';
    ui.searchOpen = {};
    persist();
    render();
    if (keepFocus !== true) searchInput.focus();
    announce('Search cleared');
  }
  searchClear.addEventListener('click', function () { clearSearch(); });

  document.addEventListener('keydown', function (ev) {
    var editing = ev.target === searchInput;
    if (!editing && ((ev.key === 'f' && (ev.metaKey || ev.ctrlKey)) || (ev.key === '/' && !ev.metaKey && !ev.ctrlKey && !ev.altKey))) {
      ev.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (ev.key === 'Escape' && !editing && !openMenuState && ui.query) {
      // Escape closes a menu first (its own handler); with none open, it clears the search.
      ev.preventDefault();
      var back = lastFocus;
      clearSearch(true);
      var row = back && rowEl(back.section, back.id);
      if (row) focusRow(row);
    }
  });

  // The search strip frosts once the list scrolls under it.
  var appEl = document.querySelector('.gs-app');
  var scrolledFrame = 0;
  window.addEventListener('scroll', function () {
    if (scrolledFrame) return;
    scrolledFrame = requestAnimationFrame(function () {
      scrolledFrame = 0;
      appEl.classList.toggle('is-scrolled', window.scrollY > 2);
      markParked();
    });
  }, { passive: true });

  // ------------------------------------------------------------------- menus

  /**
   * groups: [[{ title, icon, run }]]; anchor: { x, y, alignRight };
   * owner: { section, id?, slot?, title }: what to mark open and refocus, as
   * identifiers (a row by section + id, a button by its data-slot), looked up
   * again whenever needed, since a new state may replace the elements.
   */
  function openMenu(groups, anchor, owner) {
    closeMenu(false);
    groups = groups.filter(function (g) { return g.length > 0; });
    if (!groups.length) return;
    var menu = el('div', 'gs-menu');
    menu.setAttribute('role', 'menu');
    if (owner && owner.title) {
      menu.setAttribute('aria-label', owner.title);
      menu.appendChild(el('div', 'gs-menu__title', owner.title.replace(/…$/, '')));
    }
    var withIcons = groups.some(function (g) { return g.some(function (a) { return !!a.icon; }); });
    groups.forEach(function (g, gi) {
      if (gi > 0) {
        var sep = el('div', 'gs-menu__sep');
        sep.setAttribute('role', 'separator');
        menu.appendChild(sep);
      }
      g.forEach(function (a) {
        var item = el('button', 'gs-menu__item' + (/^(Delete|Remove)\b/.test(a.title) ? ' gs-menu__item--danger' : ''));
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        item.tabIndex = -1;
        if (withIcons) {
          var ic = el('span', 'gs-menu__item-icon');
          if (a.icon) ic.appendChild(icon(a.icon));
          item.appendChild(ic);
        }
        item.appendChild(el('span', 'gs-menu__item-label', a.title));
        item.addEventListener('click', function () { closeMenu(true); a.run(); });
        menu.appendChild(item);
      });
    });
    menuLayer.appendChild(menu);
    // Keep it inside the (narrow) view: shift left, flip above the anchor
    // when there is no room below, and as a last resort pin and scroll.
    var w = menu.offsetWidth, h = menu.offsetHeight;
    var x = anchor.alignRight ? anchor.x - w : anchor.x;
    var y = anchor.y;
    x = Math.max(6, Math.min(x, window.innerWidth - w - 6));
    if (y + h > window.innerHeight - 6) {
      var above = (anchor.top !== undefined ? anchor.top : anchor.y) - h;
      y = above >= 6 ? above : Math.max(6, window.innerHeight - h - 6);
    }
    menu.style.transformOrigin = (anchor.alignRight ? 'right ' : 'left ') + (y < anchor.y ? 'bottom' : 'top');
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    openMenuState = { el: menu, owner: owner || {} };
    markOwner(openMenuState.owner, true);
    var first = menu.querySelector('.gs-menu__item');
    if (first) first.focus();
    menu.addEventListener('keydown', function (ev) {
      var items = Array.prototype.slice.call(menu.querySelectorAll('.gs-menu__item'));
      var at = items.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(at + 1) % items.length].focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
      else if (ev.key === 'Home') { ev.preventDefault(); items[0].focus(); }
      else if (ev.key === 'End') { ev.preventDefault(); items[items.length - 1].focus(); }
      else if (ev.key === 'Escape' || ev.key === 'Tab') { ev.preventDefault(); ev.stopPropagation(); closeMenu(true); }
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') { ev.preventDefault(); }
      else if (ev.key.length === 1 && /\S/.test(ev.key) && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        // Type-ahead: the next entry whose title starts with the letter.
        ev.preventDefault();
        var ch = ev.key.toLowerCase();
        for (var k = 1; k <= items.length; k++) {
          var cand = items[(at + k + items.length) % items.length];
          if ((cand.textContent || '').trim().toLowerCase().charAt(0) === ch) { cand.focus(); break; }
        }
      }
    });
  }

  /** The elements an owner names, as the DOM has them now. */
  function ownerEls(o) {
    var out = { row: null, button: null, actions: null };
    if (!o || !o.section) return out;
    if (o.id) {
      out.row = rowEl(o.section, o.id);
      if (out.row && o.slot) out.button = out.row.querySelector('.gs-row__actions [data-slot="' + o.slot + '"]');
    } else {
      var card = cardEl(o.section);
      out.actions = card && card.querySelector('.gs-section__actions');
      if (out.actions && o.slot) out.button = out.actions.querySelector('[data-slot="' + o.slot + '"]');
    }
    return out;
  }

  function markOwner(o, open) {
    var els = ownerEls(o);
    if (els.row && els.row.classList.contains('is-menu-open') !== open) els.row.classList.toggle('is-menu-open', open);
    if (els.actions && els.actions.classList.contains('is-open') !== open) els.actions.classList.toggle('is-open', open);
    if (els.button && els.button.getAttribute('aria-expanded') !== String(open)) els.button.setAttribute('aria-expanded', String(open));
  }

  function closeMenu(refocus) {
    if (!openMenuState) return;
    var owner = openMenuState.owner;
    openMenuState.el.remove();
    openMenuState = null;
    markOwner(owner, false);
    if (refocus) {
      var els = ownerEls(owner);
      var target = els.row || els.button;
      if (target) target.focus({ preventScroll: true });
    }
  }

  // A press outside closes the menu. A press on the button that opened it
  // closes it too, and the click that follows must not open it again.
  var closedByButton = null;
  document.addEventListener('mousedown', function (ev) {
    if (!openMenuState || openMenuState.el.contains(ev.target)) return;
    var button = ownerEls(openMenuState.owner).button;
    closedByButton = button && button.contains(ev.target) ? button : null;
    closeMenu(false);
  }, true);

  /** True (once) when this click lands on the button whose menu the press just closed. */
  function swallowReopen(button) {
    var hit = closedByButton === button;
    closedByButton = null;
    return hit;
  }
  window.addEventListener('blur', function () { closeMenu(false); });
  window.addEventListener('resize', function () { closeMenu(false); pinHeaders(cards()); markParked(); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && openMenuState) { ev.preventDefault(); closeMenu(true); }
  });

  // --------------------------------------------------------- host messages

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'state') {
      var sections = Array.isArray(msg.sections) ? msg.sections : [];
      pendingExpand = {};
      // The same state again (a refresh that changed nothing): nothing to draw.
      var json = JSON.stringify(sections);
      if (rendered && json === lastStateJson) return;
      lastStateJson = json;
      model = { sections: sections };
      buildIndex();
      if (ui.selected && !(index[ui.selected.section] && index[ui.selected.section][ui.selected.id])) ui.selected = null;
      render();
    } else if (msg.type === 'itemMenu') {
      if (!pendingMenu || pendingMenu.section !== msg.section || pendingMenu.id !== msg.id) return;
      var p = pendingMenu;
      pendingMenu = null;
      var info = index[p.section] && index[p.section][p.id];
      var row = rowEl(p.section, p.id);
      var groups = (msg.groups || []).map(function (g) {
        return g.map(function (a) {
          return { title: a.title, icon: a.icon, run: function () { post({ type: 'invoke', section: p.section, id: p.id, menu: a.menu, index: a.index }); } };
        });
      });
      if (!row) return;
      openMenu(groups, p.anchor, { section: p.section, id: p.id, slot: p.slot, title: info ? info.node.label : '' });
    } else if (msg.type === 'reveal') {
      var key = msg.section;
      (msg.expand || []).forEach(function (id) { ui.expanded[key + '\u0000' + id] = true; });
      ui.collapsedSections[key] = false;
      if (msg.id) ui.selected = { section: key, id: msg.id };
      if (ui.query && msg.id) { ui.query = ''; searchInput.value = ''; }
      persist();
      render();
      var target = msg.id && rowEl(key, msg.id);
      if (target) {
        target.scrollIntoView({ block: 'center' });
        if (msg.focus) { lastFocus = { section: key, id: msg.id }; target.focus({ preventScroll: true }); }
      }
    } else if (msg.type === 'focusSearch') {
      searchInput.focus();
      searchInput.select();
    }
  });

  // A theme switch changes the body's class: redraw, so image icons pick
  // their light or dark variant (everything else follows the CSS tokens).
  var themeClass = document.body.className;
  new MutationObserver(function () {
    if (document.body.className === themeClass) return;
    themeClass = document.body.className;
    if (rendered) render();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  post({ type: 'ready' });
})();
`;
