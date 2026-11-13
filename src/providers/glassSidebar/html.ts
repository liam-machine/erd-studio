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
import { ADD_EXISTING_TABLES_LIMIT } from '../../types/messages';
import { GLASS_SEARCH_MAX_LENGTH, type GlassFilterGuide } from './protocol';

export interface GlassSidebarHtmlOptions {
  cspSource: string;
  nonce: string;
  /** `dist/webview.css` as a webview URI (the glass tokens). */
  tokensCssUri: string;
  /**
   * The search field's filter keys and debounce (the host passes
   * `glassFilterGuide()`, from sidebarFilter.ts). Without it the field has
   * no keys list and sends after {@link DEFAULT_SEARCH_DEBOUNCE_MS}.
   */
  filterGuide?: GlassFilterGuide;
}

/** The search field's debounce when the host gives none (sidebarFilter's FILTER_DEBOUNCE_MS). */
const DEFAULT_SEARCH_DEBOUNCE_MS = 150;

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
  const guide: GlassFilterGuide = options.filterGuide ?? { keys: [], syntax: '', debounceMs: DEFAULT_SEARCH_DEBOUNCE_MS };
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
    <span class="gs-search__busy gs-spinner" aria-hidden="true"></span>
    <input class="gs-search__input" type="text" placeholder="Search" maxlength="${GLASS_SEARCH_MAX_LENGTH}" aria-label="Search and filter diagrams, tables and relationships" aria-keyshortcuts="/ Control+F Meta+F" spellcheck="false" autocomplete="off">
    <kbd class="gs-search__kbd" aria-hidden="true">/</kbd>
    <button class="gs-search__clear" type="button" aria-label="Clear search" title="Clear search" hidden></button>
    <button class="gs-search__keys" type="button" aria-label="Filter keys" title="Filter by layer, column, owner…" aria-haspopup="menu" aria-expanded="false"${guide.keys.length ? '' : ' hidden'}></button>
  </div>
  <main class="gs-sections" aria-busy="true"></main>
  <div class="gs-noresults" hidden></div>
</div>
<div class="gs-menu-layer"></div>
<div class="gs-live" aria-live="polite"></div>
<script type="application/json" id="gs-icons" nonce="${n}">${inlineJson({ icons: GLASS_ICONS, fallback: GLASS_ICON_FALLBACK })}</script>
<script type="application/json" id="gs-config" nonce="${n}">${inlineJson({ filterGuide: guide, dragTablesLimit: ADD_EXISTING_TABLES_LIMIT })}</script>
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
  padding: 0 52px 0 30px;
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
  right: calc(var(--gs-gutter) + 27px);
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
  right: calc(var(--gs-gutter) + 30px);
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

/* The filter keys: a quiet funnel at the field's end, opening the list of keys. */
.gs-search__keys {
  position: absolute;
  z-index: 1;
  right: calc(var(--gs-gutter) + 5px);
  top: 50%;
  margin-top: -10px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: background-color var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard);
}

.gs-search__keys svg.gs-icon { width: 13px; height: 13px; }
.gs-search__keys:hover { background: var(--control-fill-hover); color: var(--text-primary); }
.gs-search__keys[aria-expanded='true'] { background: var(--control-fill-active); color: var(--text-primary); }
.gs-search__keys:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.gs-search__keys[hidden] { display: none; }

body.vscode-high-contrast .gs-search__keys:hover,
body.vscode-high-contrast-light .gs-search__keys:hover {
  border-color: var(--vscode-contrastActiveBorder, var(--focus-border));
}

/* A slow answer (or table files still being read for col:): the glass turns a small ring in place of the magnifier.
   Doubled class: wins over .gs-spinner's own size and margin, defined further down. */
.gs-search .gs-search__busy {
  position: absolute;
  z-index: 1;
  box-sizing: border-box;
  left: calc(var(--gs-gutter) + 10px);
  top: 50%;
  width: 14px;
  height: 14px;
  margin: -6px 0 0;
  visibility: hidden;
  pointer-events: none;
}

.gs-search.is-busy .gs-search__busy { visibility: visible; }
.gs-search.is-busy .gs-search__icon { visibility: hidden; }

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

/* Work under way for the section (the native view's progress): along the
   header's foot, inset from its rounded corners, a short accent glint slides
   across at an even pace, as VS Code's own view progress bar does (no track:
   at rest the header has no line there). The header is sticky, so it is the
   bar's box. */
.gs-section__progress {
  position: absolute;
  left: var(--radius-lg);
  right: var(--radius-lg);
  bottom: 0;
  height: 2px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  pointer-events: none;
}

.gs-section__progress::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 40%;
  border-radius: inherit;
  background: linear-gradient(90deg, transparent, var(--accent) 35%, var(--accent) 65%, transparent);
  animation: gs-progress 1.4s linear infinite;
}

@keyframes gs-progress {
  from { transform: translateX(-100%); }
  to { transform: translateX(250%); }
}

/* Reduced motion: no glint travelling; the whole track glows and fades slowly instead. */
@media (prefers-reduced-motion: reduce) {
  .gs-section__progress::before {
    width: 100%;
    background: var(--accent);
    animation: gs-breathe 1.6s ease-in-out infinite;
  }
}

/* High contrast: a solid line in the theme's contrast colour, never a soft gradient. */
body.vscode-high-contrast .gs-section__progress::before,
body.vscode-high-contrast-light .gs-section__progress::before {
  background: var(--vscode-contrastActiveBorder, var(--focus-border));
}

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

/* Selected rows next to each other read as one block (a range, Select All). */
.gs-row.is-selected:has(+ .gs-row.is-selected) {
  border-bottom-color: transparent;
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}

.gs-row.is-selected + .gs-row.is-selected {
  border-top-color: transparent;
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}

.gs-row:focus { outline: none; }
.gs-row:focus-visible {
  outline: var(--focus-outline);
  outline-offset: -2px;
}

.gs-row.is-menu-open {
  background: var(--control-fill-active);
}

/* --- Drag and drop ---------------------------------------------------------- */

/* The rows being dragged step back; nothing else answers the pointer until the drag is over. */
.gs-row.is-dragging { opacity: 0.45; }

body.gs-dragging .gs-row:hover {
  background: transparent;
  border-color: transparent;
}

body.gs-dragging .gs-row__actions { visibility: hidden; }

/* Where letting go adds the drag (a diagram's row under a table). */
.gs-row.is-drop-target,
body.gs-dragging .gs-row.is-drop-target:hover {
  background: var(--glass-tint-accent-strong);
  border-color: var(--accent);
}

/* Where letting go moves the drag to (a layer among layers): a line on the edge it will sit at. */
.gs-row.is-drop-before::after,
.gs-row.is-drop-after::after {
  content: '';
  position: absolute;
  left: var(--space-2);
  right: var(--space-2);
  height: 2px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  pointer-events: none;
}

.gs-row.is-drop-before::after { top: -2px; }
.gs-row.is-drop-after::after { bottom: -2px; }

/* A section header the drag is waiting on to open. */
body.gs-dragging .gs-section__header.is-drop-wait {
  border-color: var(--accent);
}

/* The drag's own picture: drawn off screen, handed to the browser at dragstart. */
.gs-dragpill {
  position: fixed;
  top: -200px;
  left: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  padding: 5px 12px 5px 8px;
  border: 1px solid var(--glass-border-strong);
  border-radius: var(--radius-pill);
  background: var(--glass-surface-3);
  color: var(--text-primary);
  font: var(--weight-medium) var(--text-sm) var(--font-ui);
  white-space: nowrap;
  pointer-events: none;
}

.gs-dragpill__label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.gs-dragpill svg.gs-icon { width: 14px; height: 14px; flex: none; }

/* Several rows: the pill is the top of a small stack. */
.gs-dragpill--many {
  box-shadow:
    3px 3px 0 -1px var(--glass-surface-3),
    3px 3px 0 0 var(--glass-border-strong);
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
.gs-tree:not(.gs-tree--many):focus-within .gs-row.is-selected > .gs-row__actions,
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

.gs-noresults p { margin: 0; }

.gs-noresults__lead {
  color: var(--text-secondary);
}

.gs-noresults p.gs-noresults__why {
  margin-top: var(--space-2);
  font-size: var(--text-xs);
}

.gs-noresults__actions {
  display: flex;
  justify-content: center;
  gap: var(--space-5);
  margin-top: var(--space-4);
}

/* A section the search found nothing in: one quiet line where its rows would be. */
.gs-section__none {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2) var(--space-3) var(--space-1);
  color: var(--text-tertiary);
  font-size: var(--text-sm);
}

.gs-section__none-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.gs-section__none-head svg.gs-icon { width: 12px; height: 12px; flex: none; }

.gs-section__none-why {
  padding-left: 18px;
  font-size: var(--text-xs);
}

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

/* Filter keys: the key as typed, then what it finds. */
.gs-menu--keys { max-width: min(320px, calc(100vw - 12px)); }

.gs-menu__item-label--code {
  flex: none;
  min-width: 72px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.gs-menu__item-hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-tertiary);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gs-menu__item:hover .gs-menu__item-hint,
.gs-menu__item:focus-visible .gs-menu__item-hint { color: var(--text-secondary); }

.gs-menu__note {
  margin: var(--space-2) var(--space-4) var(--space-1);
  padding-top: var(--space-3);
  border-top: 1px solid var(--glass-divider);
  color: var(--text-tertiary);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
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
  var config = JSON.parse(document.getElementById('gs-config').textContent || '{}');
  // The most tables one drag adds (ADD_EXISTING_TABLES_LIMIT): the host caps a drag there, and so does its picture.
  var DRAG_TABLES_LIMIT = typeof config.dragTablesLimit === 'number' ? config.dragTablesLimit : 200;
  // The filter keys (sidebarFilter.ts) and the field's debounce.
  var GUIDE = config.filterGuide || { keys: [], syntax: '', debounceMs: 150 };

  var saved = vscode.getState() || {};
  // A page that has been here before in this view (reloaded, or the view moved or
  // re-created): it comes back as it was, without the first visit's entrance.
  var restoredSession = Object.keys(saved).length > 0;
  // Where the list was scrolled to, put back once a state is drawn that is tall enough.
  var pendingScroll = typeof saved.scrollY === 'number' && isFinite(saved.scrollY) && saved.scrollY > 0 ? Math.round(saved.scrollY) : 0;
  var SCROLL_RESTORE_MS = 5000;
  var loadedAt = Date.now();
  var ui = {
    expanded: saved.expanded || {},
    collapsedSections: saved.collapsedSections || {},
    // The selection: rows of one section ({ section, ids, anchor }), or null.
    // anchor: where a Shift range starts. Several ids only where the section is multiSelect.
    sel: savedSelection(saved),
    // The search field's text. Not restored from saved state: the host's filters
    // (session only, as the native views') are the truth, and each state says
    // what the field shows (msg.search).
    query: '',
    searchOpen: {}
  };

  // The search field drives the host's filters (sections marked filterable):
  // its text is sent debounced (search.timer), each send numbered (seq), and
  // a state that holds the answer says so (searchSeq -> ack).
  var search = {
    timer: 0,
    sent: null,       // the text last sent (or adopted from the host)
    seq: 0,
    ack: 0,
    busy: false,      // drawn: the answer is slow
    busyTimer: 0,
    focusFirst: false, // Enter or Down while the answer was on its way: focus the first row once it arrives
    returnTo: null     // Escape cleared the field: where focus goes back to once the rows are back (a focusKeyOf shape)
  };
  var BUSY_DELAY_MS = 250;
  // What the host says the field shows: a string, null when the sections' filters differ, undefined before any state.
  var hostSearch;
  // Where focus was before the search field took it (Cmd/Ctrl+F, "/"): Escape there returns it.
  var searchReturn = null;
  var renderQuiet = false;  // the next render follows a search: no entrance animations

  /** The persisted selection; an older page saved one row as { section, id }. */
  function savedSelection(s) {
    var v = s.selection;
    if (v && typeof v.section === 'string' && Array.isArray(v.ids)) {
      var ids = v.ids.filter(function (x) { return typeof x === 'string'; });
      return ids.length ? { section: v.section, ids: ids, anchor: typeof v.anchor === 'string' ? v.anchor : ids[0] } : null;
    }
    var old = s.selected;
    if (old && typeof old.section === 'string' && typeof old.id === 'string') return { section: old.section, ids: [old.id], anchor: old.id };
    return null;
  }
  // Cmd on macOS, Ctrl elsewhere: what adds a row to the selection (and Cmd/Ctrl+A, +Left), as in VS Code.
  var IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || '') || /Mac OS X/.test(navigator.userAgent || '');
  function modKey(ev) { return IS_MAC ? ev.metaKey : ev.ctrlKey; }
  var model = { sections: [] };
  var index = {};          // section key -> id -> { node, parent, depth }
  var lastFocus = null;    // { section, id }
  var pendingMenu = null;  // { section, id, anchor }
  var openMenuState = null;
  var pendingExpand = {};  // section/id -> true while the host lists children
  var expandAsked = {};    // section/id -> true: asked for by the page itself (an open row restored unlisted); once per row
  var lastShownSig = null; // the open sections last told to the host (sectionsShown)
  var renderCtx = null;    // per render: which rows the previous DOM showed (new ones enter)
  var rendered = false;
  var introActive = false; // the first render's cards rise in, staggered
  var lastStateJson = null; // the sections of the last 'state' drawn: an identical one is a no-op

  var sectionsEl = document.querySelector('.gs-sections');
  var noResultsEl = document.querySelector('.gs-noresults');
  var searchEl = document.querySelector('.gs-search');
  var searchInput = document.querySelector('.gs-search__input');
  var searchClear = document.querySelector('.gs-search__clear');
  var keysButton = document.querySelector('.gs-search__keys');
  var menuLayer = document.querySelector('.gs-menu-layer');
  var liveEl = document.querySelector('.gs-live');

  // ------------------------------------------------------------------ utils

  function persist() {
    var keys = Object.keys(ui.expanded);
    if (keys.length > 3000) {
      keys.slice(0, keys.length - 3000).forEach(function (k) { delete ui.expanded[k]; });
    }
    // While a restore is still waiting, its target stays the saved place (not the 0 the page starts at).
    var y = pendingScroll || Math.max(0, Math.round(window.scrollY || 0));
    vscode.setState({ expanded: ui.expanded, collapsedSections: ui.collapsedSections, selection: ui.sel, scrollY: y });
  }

  // Scrolling saves its place, at most a few times a second (setState crosses to VS Code).
  var SCROLL_SAVE_MS = 250;
  var scrollSaveTimer = 0;
  function scheduleScrollSave() {
    if (scrollSaveTimer) return;
    scrollSaveTimer = setTimeout(function () { scrollSaveTimer = 0; persist(); }, SCROLL_SAVE_MS);
  }

  /** A section still shows its "Loading…" placeholder: the list has not reached its height yet. */
  function stillLoading() {
    return model.sections.some(function (s) {
      var w = s.welcome || [];
      return s.visible && !(s.nodes || []).length && w.length === 1 && w[0].paragraphs.length === 1
        && w[0].paragraphs[0].parts.length === 1 && /^Loading/.test(w[0].paragraphs[0].parts[0].text || '');
    });
  }

  /**
   * Put the saved scroll place back once a state is drawn: as far as the list
   * now reaches (it may have shrunk since). While a section is still loading
   * and the list too short, it waits for the next state, a few seconds at
   * most. Given up as soon as the user scrolls, types or clicks, or something
   * is revealed or shown.
   */
  function restoreScroll() {
    if (!pendingScroll) return;
    var max = document.documentElement.scrollHeight - window.innerHeight;
    if (max < pendingScroll && stillLoading() && Date.now() - loadedAt < SCROLL_RESTORE_MS) return;
    var y = Math.max(0, Math.min(pendingScroll, max));
    pendingScroll = 0;
    if (y > 0) window.scrollTo(0, y);
  }

  function cancelScrollRestore() { pendingScroll = 0; }
  ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach(function (t) {
    window.addEventListener(t, cancelScrollRestore, { capture: true, passive: true });
  });

  /** Under reduced motion a scroll jumps; otherwise it glides. */
  function scrollBehavior() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
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
  keysButton.appendChild(icon('filter'));

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

  /** The host filters this section by the field's text: the page never hides its rows by its own match. */
  function hostFiltered(section) { return !!(section && section.filterable); }

  function anyFilterable() { return model.sections.some(hostFiltered); }

  /** The field's text the page matches a section's rows against itself: Help & Feedback's, never a filterable section's. */
  function localQuery(section) { return hostFiltered(section) ? '' : query(); }

  /**
   * While searching, a section shows its results open (its fold waits until the
   * field is cleared). A host-filtered one only once the host has answered with
   * what it found: until then a folded section stays folded, never flashing its
   * unfiltered rows.
   */
  function heldOpen(section) {
    if (!section || !query()) return false;
    return hostFiltered(section) ? !!section.found : true;
  }

  /** The sections carry different filters (set one at a time from the Command Palette): the field cannot show them as one. */
  function filtersDiffer() { return hostSearch === null && model.sections.some(function (s) { return !!s.filter; }); }

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
    var q = localQuery(section);
    var sets = q ? searchSets(section, q) : null;
    var rows = [];
    // A host filter that found nothing lists one "No … match" row: the page says it in its own words instead.
    var nodes = section.found ? (section.nodes || []).filter(function (n) { return n.contextValue !== 'filterNoMatch'; }) : section.nodes;
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
    })(nodes, 0, false);
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
    var selected = isSelected(section.key, n.id);
    row.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected) row.className += ' is-selected';
    var owner = menuOwner();
    var ownsMenu = !!(owner && owner.id === n.id && owner.section === section.key);
    if (ownsMenu) row.className += ' is-menu-open';
    // Drag and drop: the classes are part of the render, so a redraw mid-drag keeps them.
    if (n.drag) row.setAttribute('draggable', 'true');
    if (drag) {
      if (drag.section === section.key && drag.ids.indexOf(n.id) !== -1) row.className += ' is-dragging';
      if (drag.over && drag.over.section === section.key && drag.over.mark === n.id) row.className += ' ' + drag.over.cls;
    }
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
      // No … that would only repeat the hover button (hideMore): right-click and Shift+F10 still list it.
      if (n.hasMenu && !n.hideMore) {
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
    // Filtered on the host: what it found, as the native view says it (4 of 52). Matched here
    // (Help & Feedback): the matches. Otherwise the view's total.
    var f = section.found;
    if (f) {
      // The accent only when it found something: "0 of 52" stays quiet.
      var shown = el('span', 'gs-section__count' + (f.shown > 0 ? ' gs-section__count--hits' : ''), f.shown + ' of ' + f.total);
      shown.title = f.text;
      shown.setAttribute('aria-label', f.shown + ' of ' + f.total + ' ' + f.noun);
      toggle.appendChild(shown);
    } else if (searching && !hostFiltered(section)) {
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
    if (heldOpen(section)) toggle.setAttribute('aria-disabled', 'true');
    header.appendChild(toggle);

    // The section's own filter, when the field cannot show it (the sections' filters differ).
    if (section.filter && filtersDiffer()) {
      var chip = el('span', 'gs-section__filter');
      chip.title = 'Filtered: ' + section.filter;
      chip.appendChild(icon('filter-filled'));
      chip.appendChild(el('span', '', section.filter));
      header.appendChild(chip);
    }

    var owner = menuOwner();
    var ownsMenu = !!(owner && !owner.id && owner.section === section.key);
    var actions = el('div', 'gs-section__actions' + (ownsMenu ? ' is-open' : ''));
    // One header order in every section: "+", then Collapse All, then "…" (titleActions.ts).
    var nav = section.actions.navigation || [];
    var addCount = 0;
    while (addCount < nav.length && (nav[addCount].submenu || nav[addCount].icon === 'add')) addCount++;
    var collapseBtn = null;
    if (section.collapseAll) {
      collapseBtn = el('button', 'gs-iconbtn');
      collapseBtn.type = 'button';
      collapseBtn.title = 'Collapse All';
      collapseBtn.setAttribute('aria-label', section.title + ': collapse all');
      collapseBtn.dataset.act = 'collapse-all';
      collapseBtn.dataset.slot = 'collapse';
      collapseBtn.appendChild(icon('collapse-all'));
    }
    if (collapseBtn && addCount === 0) actions.appendChild(collapseBtn);
    nav.forEach(function (a, i) {
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
      if (collapseBtn && i === addCount - 1) actions.appendChild(collapseBtn);
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
    // Work under way for the section (the native view's progress bar): a thin bar along the header's foot.
    if (section.busy) {
      var bar = el('span', 'gs-section__progress');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', section.title + ': working…');
      header.appendChild(bar);
    }
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

  /** A host-filtered section that found nothing: one quiet line (and what the filter could not use). */
  function renderNone(section) {
    var f = section.found;
    var wrap = el('div', 'gs-section__none');
    wrap.setAttribute('role', 'status');
    var head = el('span', 'gs-section__none-head');
    head.appendChild(icon('filter'));
    head.appendChild(el('span', '', f.reading ? 'Still reading table files…' : 'No ' + f.noun + ' match'));
    wrap.appendChild(head);
    if (f.warnings && f.warnings.length) wrap.appendChild(el('span', 'gs-section__none-why', f.warnings.join(' · ')));
    return wrap;
  }

  /**
   * Nothing anywhere: the one message, with Clear Search and the keys. Built
   * only when what it says changes (it is outside the reconciled list).
   */
  var noResultsSig = null;
  function renderNoResults(show) {
    if (noResultsEl.hidden !== !show) noResultsEl.hidden = !show;
    if (!show) { noResultsSig = null; return; }
    // What the filter could not use in every section (an unknown key, say): the likely reason.
    var lists = model.sections.filter(function (s) { return s.found; }).map(function (s) { return s.found.warnings || []; });
    var common = lists.length ? lists[0].filter(function (w) { return lists.every(function (l) { return l.indexOf(w) !== -1; }); }) : [];
    var lead = 'Nothing matches “' + ui.query.trim() + '”.';
    var sig = JSON.stringify([lead, common, GUIDE.keys.length > 0]);
    if (sig === noResultsSig) return;
    noResultsSig = sig;
    noResultsEl.textContent = '';
    noResultsEl.appendChild(el('p', 'gs-noresults__lead', lead));
    if (common.length) noResultsEl.appendChild(el('p', 'gs-noresults__why', common.join(' · ')));
    var actions = el('p', 'gs-noresults__actions');
    var clear = el('button', 'gs-link', 'Clear search');
    clear.type = 'button';
    clear.dataset.nr = 'clear';
    actions.appendChild(clear);
    if (GUIDE.keys.length) {
      var keys = el('button', 'gs-link', 'Filter keys');
      keys.type = 'button';
      keys.dataset.nr = 'keys';
      actions.appendChild(keys);
    }
    noResultsEl.appendChild(actions);
  }

  /** The search strip: Clear, the busy ring (a slow answer), the placeholder, from script state. */
  function paintSearch() {
    if (searchClear.hidden !== !ui.query) searchClear.hidden = !ui.query;
    var waiting = search.seq > search.ack || model.sections.some(function (s) { return !!(s.found && s.found.reading); });
    if (!waiting) {
      clearTimeout(search.busyTimer);
      search.busyTimer = 0;
      search.busy = false;
    } else if (!search.busy && !search.busyTimer) {
      // Only a slow answer shows it: most come back before the ring would be seen.
      search.busyTimer = setTimeout(function () { search.busyTimer = 0; search.busy = true; paintSearch(); }, BUSY_DELAY_MS);
    }
    if (searchEl.classList.contains('is-busy') !== search.busy) searchEl.classList.toggle('is-busy', search.busy);
    var busyAttr = search.busy ? 'true' : 'false';
    if (searchInput.getAttribute('aria-busy') !== busyAttr) searchInput.setAttribute('aria-busy', busyAttr);
    var placeholder = filtersDiffer() && !ui.query ? 'Filters differ per section' : 'Search';
    if (searchInput.placeholder !== placeholder) searchInput.placeholder = placeholder;
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
      if (a.getAttribute(at.name) === at.value) continue;
      // The CSP refuses a style attribute set as text; the style object is allowed.
      if (at.name === 'style') a.style.cssText = b.style.cssText;
      else a.setAttribute(at.name, at.value);
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
  function captureFocus() { return focusKeyOf(document.activeElement); }

  /** An element of the list, by identity (null for anything outside it). */
  function focusKeyOf(a) {
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
      var row = sameRowEl(k.section, k.id);
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
    // A search swaps the host's rows (new ids under each filter): none of them "enter".
    renderCtx = { ids: prevIds, animateNew: rendered && existing.length > 0 && !query() && !renderQuiet && !searchPending() };
    renderQuiet = false;
    var first = !rendered;
    // The cards rise in on a first visit only: a restored page is simply there.
    var intro = first && !restoredSession;
    rendered = true;
    if (intro) introActive = true;
    // Open rows whose children the host has not listed (restored from saved state past its budget).
    var unlisted = [];
    var scrollY = window.scrollY;
    var focus = lastFocus;
    var focusKey = captureFocus();
    var q = query();
    var searching = !!q;
    var fresh = [];
    // Each shown section and its rows. A section matched here (Help & Feedback) with
    // no match is left out; a host-filtered one that found nothing says so in a line.
    var shownSections = [];
    model.sections.forEach(function (section, i) {
      if (!section.visible) return;
      var vis = visibleRows(section);
      if (searching && !hostFiltered(section) && vis.rows.length === 0) return;
      shownSections.push({ section: section, i: i, vis: vis, none: !!section.found && vis.rows.length === 0 });
    });
    // Searching, and not one row anywhere: one message for the whole sidebar instead of a card per section.
    var nothing = searching && shownSections.every(function (x) { return x.vis.rows.length === 0; });
    if (nothing) shownSections = [];
    shownSections.forEach(function (x) {
      var section = x.section, i = x.i, vis = x.vis;
      var collapsed = !heldOpen(section) && (ui.collapsedSections[section.key] !== undefined ? ui.collapsedSections[section.key] : section.defaultCollapsed);
      var card = el('section', 'gs-section' + (collapsed ? ' gs-section--collapsed' : '') + (section.key === 'help' ? ' gs-section--help' : ''));
      card.dataset.key = section.key;
      if (introActive) card.style.animationDelay = (i * 40) + 'ms';
      card.setAttribute('aria-labelledby', 'gs-head-' + section.key);
      if (section.busy) card.setAttribute('aria-busy', 'true');
      vis.rows.forEach(function (r) { if (r.loading) unlisted.push([section.key, r.parent.id]); });
      card.appendChild(renderHeader(section, collapsed, searching, vis.sets ? Object.keys(vis.sets.hit).length : 0));
      var body = el('div', 'gs-section__body');
      body.id = 'gs-body-' + section.key;
      var inner = el('div', 'gs-section__inner');
      var content = el('div', 'gs-section__content');
      if (x.none) {
        content.appendChild(renderNone(section));
      } else if (vis.rows.length === 0) {
        content.appendChild(renderWelcome(section));
      } else {
        var tree = el('div', 'gs-tree' + treeSelectionClass(section.key));
        tree.setAttribute('role', 'tree');
        tree.setAttribute('aria-label', section.title);
        if (section.multiSelect) tree.setAttribute('aria-multiselectable', 'true');
        tree.dataset.section = section.key;
        var flat = !vis.rows.some(function (r) { return r.node && r.node.collapsible; }) && vis.rows.every(function (r) { return r.depth === 0; });
        if (flat) tree.className += ' gs-tree--flat';
        // The row that takes Tab: the last focused, else the selection's anchor (or first selected), else the first.
        var ids = {}, firstId = null, pickId = null;
        vis.rows.forEach(function (r) { if (r.node) { ids[r.node.id] = true; if (firstId === null) firstId = r.node.id; } });
        if (focus && focus.section === section.key && ids[focus.id]) pickId = focus.id;
        else if (ui.sel && ui.sel.section === section.key && ids[ui.sel.anchor]) pickId = ui.sel.anchor;
        else if (ui.sel && ui.sel.section === section.key) pickId = ui.sel.ids.filter(function (s) { return ids[s]; })[0] || firstId;
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
    renderNoResults(nothing);
    paintSearch();
    restoreFocus(focusKey);
    // Only when the rebuild moved it: an unconditional scrollTo would cut a smooth scroll short.
    if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
    requestUnlisted(unlisted);
    reportShown();
    // The first draw marks the session: a reload of this page later comes back without the entrance.
    if (first) persist();
  }

  /** Ask the host for each open row it has not listed, once (it lists any row asked for). */
  function requestUnlisted(list) {
    list.forEach(function (x) {
      var key = x[0] + '\u0000' + x[1];
      if (pendingExpand[key] || expandAsked[key]) return;
      pendingExpand[key] = true;
      expandAsked[key] = true;
      post({ type: 'expand', section: x[0], id: x[1] });
    });
  }

  /** Tell the host which sections are drawn open now, when that changed (it counts an empty Diagrams card as seen only then). */
  function reportShown() {
    var open = cards().filter(function (c) { return !c.classList.contains('gs-section--collapsed'); }).map(function (c) { return c.dataset.key; });
    var sig = open.join(',');
    if (sig === lastShownSig) return;
    lastShownSig = sig;
    post({ type: 'sectionsShown', open: open });
  }

  function rowEl(sectionKey, id) {
    var rows = document.querySelectorAll('.gs-tree[data-section="' + sectionKey + '"] .gs-row[data-id]');
    for (var i = 0; i < rows.length; i++) if (rows[i].dataset.id === id) return rows[i];
    return null;
  }

  /**
   * A row id without the host filter's mark. A container row listed under a
   * filter gets a new id each time (the tree's own id plus "#filterN", so a
   * native view opens it), and a child named after it carries the mark too:
   * the same row, listed again under another filter or none.
   */
  function plainId(id) { return String(id).replace(/#filter[0-9]+(?=[\/#]|$)/g, ''); }

  /** A row by id; else the same row listed under another filter (focus follows it across a search's answer). */
  function sameRowEl(sectionKey, id) {
    var exact = rowEl(sectionKey, id);
    if (exact || !id) return exact;
    var want = plainId(id);
    var rows = document.querySelectorAll('.gs-tree[data-section="' + sectionKey + '"] .gs-row[data-id]');
    for (var i = 0; i < rows.length; i++) if (plainId(rows[i].dataset.id) === want) return rows[i];
    return null;
  }

  // ----------------------------------------------------------------- actions

  function post(message) { vscode.postMessage(message); }

  function setExpanded(sectionKey, id, open) {
    var info = index[sectionKey] && index[sectionKey][id];
    if (!info || !info.node.collapsible) return;
    var key = sectionKey + '\u0000' + id;
    // Rows matched here keep their own open state while searching; host-filtered rows are the tree's own.
    if (localQuery(sectionByKey(sectionKey))) ui.searchOpen[key] = open;
    else ui.expanded[key] = open;
    if (open && info.node.childrenLoaded === false && !pendingExpand[key]) {
      pendingExpand[key] = true;
      post({ type: 'expand', section: sectionKey, id: id });
    }
    // Rows folded away leave the selection, as in a native tree: an action never runs on rows out of sight.
    if (!open) keepVisibleSelection(sectionKey);
    persist();
    render();
  }

  function toggle(sectionKey, id) {
    var row = rowEl(sectionKey, id);
    setExpanded(sectionKey, id, !(row && row.getAttribute('aria-expanded') === 'true'));
  }

  /**
   * Collapse All (the native view's title action, and Cmd/Ctrl+Left): every
   * row of the section folds; the card stays open. While searching, the
   * results fold too (typing again opens them to the matches). A focused row
   * folded away hands focus to its top-level row, as a native tree does.
   */
  function collapseAll(sectionKey) {
    var map = index[sectionKey];
    var section = sectionByKey(sectionKey);
    if (!map || !section) return;
    var searching = !!localQuery(section);
    Object.keys(map).forEach(function (id) {
      var n = map[id].node;
      if (!n.collapsible) return;
      var key = sectionKey + '\u0000' + id;
      // Folded is the default of a collapsed row: forget it rather than store it (the state stays small).
      if (n.collapsible === 2) ui.expanded[key] = false; else delete ui.expanded[key];
      if (searching) ui.searchOpen[key] = false;
    });
    var active = document.activeElement;
    var hadFocus = !!(active && active.closest && active.closest('.gs-tree[data-section="' + sectionKey + '"]'));
    var top = null;
    if (lastFocus && lastFocus.section === sectionKey && map[lastFocus.id]) {
      top = map[lastFocus.id];
      while (top.parent) top = map[top.parent.id];
      lastFocus = { section: sectionKey, id: top.node.id };
    }
    keepVisibleSelection(sectionKey);
    persist();
    render();
    if (hadFocus && top) {
      var row = rowEl(sectionKey, top.node.id);
      if (row) focusRow(row);
    }
    announce(section.title + ': all rows collapsed');
  }

  // ------------------------------------------------------------- selection
  //
  // One selection for the whole sidebar, in one section at a time (ui.sel).
  // render() draws it (is-selected, aria-selected, the tree's gs-tree--many);
  // paintSelection() writes the same onto the live rows between renders.

  function isMultiSection(key) { var s = sectionByKey(key); return !!(s && s.multiSelect); }

  function isSelected(key, id) { return !!(ui.sel && ui.sel.section === key && ui.sel.ids.indexOf(id) !== -1); }

  function selectedCount(key) { return ui.sel && ui.sel.section === key ? ui.sel.ids.length : 0; }

  function treeSelectionClass(key) { return selectedCount(key) > 1 ? ' gs-tree--many' : ''; }

  /** The ids of the rows a section shows now, in order. */
  function visibleIds(key) {
    var section = sectionByKey(key);
    if (!section) return [];
    return visibleRows(section).rows.filter(function (r) { return !!r.node; }).map(function (r) { return r.node.id; });
  }

  /** The selected ids in the order the tree shows them (rows out of sight after). */
  function orderedSelection(key) {
    if (!ui.sel || ui.sel.section !== key) return [];
    var order = visibleIds(key);
    var chosen = ui.sel.ids;
    var shown = order.filter(function (id) { return chosen.indexOf(id) !== -1; });
    return shown.concat(chosen.filter(function (id) { return shown.indexOf(id) === -1; }));
  }

  function paintSelection() {
    var rows = sectionsEl.querySelectorAll('.gs-row[data-id]');
    for (var i = 0; i < rows.length; i++) {
      var want = isSelected(rows[i].dataset.section, rows[i].dataset.id);
      if (rows[i].classList.contains('is-selected') !== want) rows[i].classList.toggle('is-selected', want);
      if (rows[i].getAttribute('aria-selected') !== String(want)) rows[i].setAttribute('aria-selected', String(want));
    }
    var trees = sectionsEl.querySelectorAll('.gs-tree');
    for (var t = 0; t < trees.length; t++) {
      var many = selectedCount(trees[t].dataset.section) > 1;
      if (trees[t].classList.contains('gs-tree--many') !== many) trees[t].classList.toggle('gs-tree--many', many);
    }
  }

  function setSelection(key, ids, anchor) {
    ui.sel = { section: key, ids: ids, anchor: anchor };
    paintSelection();
    persist();
  }

  /** The row alone (a plain click, a reveal). */
  function select(sectionKey, id) {
    lastFocus = { section: sectionKey, id: id };
    setSelection(sectionKey, [id], id);
  }

  /** Cmd/Ctrl-click, Cmd/Ctrl+Space: the row in or out of the selection; it becomes the anchor. */
  function toggleSelected(key, id) {
    lastFocus = { section: key, id: id };
    if (!isMultiSection(key) || !ui.sel || ui.sel.section !== key) { select(key, id); return; }
    var ids = ui.sel.ids.slice();
    var at = ids.indexOf(id);
    if (at === -1) ids.push(id); else ids.splice(at, 1);
    setSelection(key, ids, id);
  }

  /** Shift-click, Shift+arrows: the rows from the anchor to this one (added to the selection when additive). */
  function selectRange(key, id, additive) {
    if (!isMultiSection(key)) { select(key, id); return; }
    var order = visibleIds(key);
    var to = order.indexOf(id);
    if (to === -1) return;
    var anchor = ui.sel && ui.sel.section === key && order.indexOf(ui.sel.anchor) !== -1 ? ui.sel.anchor : id;
    var from = order.indexOf(anchor);
    var range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
    var ids = range;
    if (additive && ui.sel && ui.sel.section === key) {
      ids = ui.sel.ids.slice();
      range.forEach(function (r) { if (ids.indexOf(r) === -1) ids.push(r); });
    }
    lastFocus = { section: key, id: id };
    setSelection(key, ids, anchor);
  }

  /** Cmd/Ctrl+A: every row the section shows. */
  function selectAll(key, focusedId) {
    var order = visibleIds(key);
    if (!order.length) return;
    var anchor = ui.sel && ui.sel.section === key && order.indexOf(ui.sel.anchor) !== -1 ? ui.sel.anchor : (focusedId || order[0]);
    setSelection(key, order, anchor);
    announce(order.length === 1 ? '1 row selected' : order.length + ' rows selected');
  }

  /**
   * After a new state: the selection keeps the rows that are still listed
   * (by id), and one row where the section no longer selects many.
   */
  function keepListedSelection() {
    if (!ui.sel) return;
    var map = index[ui.sel.section];
    var ids = map ? ui.sel.ids.filter(function (id) { return !!map[id]; }) : [];
    var anchor = ids.indexOf(ui.sel.anchor) !== -1 ? ui.sel.anchor : ids[0];
    if (ids.length > 1 && !isMultiSection(ui.sel.section)) ids = [anchor];
    if (ids.length === ui.sel.ids.length && anchor === ui.sel.anchor) return;
    ui.sel = ids.length ? { section: ui.sel.section, ids: ids, anchor: anchor } : null;
    persist();
  }

  /** Drop the selected rows a fold has hidden. */
  function keepVisibleSelection(key) {
    if (!ui.sel || ui.sel.section !== key) return;
    var order = visibleIds(key);
    var ids = ui.sel.ids.filter(function (id) { return order.indexOf(id) !== -1; });
    if (ids.length === ui.sel.ids.length) return;
    ui.sel = ids.length ? { section: key, ids: ids, anchor: ids.indexOf(ui.sel.anchor) !== -1 ? ui.sel.anchor : ids[0] } : null;
  }

  /**
   * Before a row action (hover button, its … menu, right-click), as a native
   * tree: a row in the selection keeps the selection; any other row becomes it.
   */
  function selectForAction(key, id) {
    if (!isSelected(key, id)) select(key, id);
    else lastFocus = { section: key, id: id };
  }

  /** The ids a row action names besides its row: the selection, in a section that selects many. */
  function actionSelection(key, id) {
    if (!isMultiSection(key) || !isSelected(key, id)) return undefined;
    return orderedSelection(key);
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
      var groups = (section.actions.groups || []).map(function (g) { return flattenSub(g).map(titleItem(section)); });
      openMenu(groups, buttonAnchor(b), { section: section.key, slot: 'more', title: section.title });
    } else if (act === 'collapse-all') {
      // The header's own button (the native view's showCollapseAll): page-local, nothing is sent.
      if (section.collapseAll) collapseAll(section.key);
    } else {
      var row = b.closest('.gs-row[data-id]');
      var info = row && index[section.key] && index[section.key][row.dataset.id];
      if (!info) return;
      if (act === 'inline') {
        var x = (info.node.inline || [])[i];
        if (!x) return;
        selectForAction(section.key, info.node.id);
        postRowInvoke(section.key, info.node.id, x, actionSelection(section.key, info.node.id));
      } else if (act === 'row-more') {
        if (swallowReopen(b)) return;
        selectForAction(section.key, info.node.id);
        requestItemMenu(section.key, info.node.id, buttonAnchor(b), 'more');
      }
    }
  }

  /** A row's menu entry, run with the row's id and (multi-select sections) the selected rows' ids. */
  function postRowInvoke(sectionKey, id, entry, selection) {
    var msg = { type: 'invoke', section: sectionKey, id: id, menu: entry.menu, index: entry.index };
    if (selection) msg.selection = selection;
    post(msg);
  }

  // Clicks, as a VS Code tree takes them. A double-click is two clicks (detail
  // 1, then 2) and a dblclick: the first click does what one click does, the
  // second does nothing again, and the dblclick folds or unfolds a row that
  // has a command (whose click ran it). A row without one was already
  // toggled by its first click, so the dblclick leaves it as it is. A leaf
  // row the host gave a double-click action ('secondary': a table's or a
  // relationship's file, the code) sends 'doubleClick' with its id; the host
  // decides what it opens and closes anything the first click left asking.
  sectionsEl.addEventListener('click', function (ev) {
    var act = ev.target.closest && ev.target.closest('[data-act]');
    if (act && sectionsEl.contains(act)) {
      // A row's button runs once per double-click; section headers keep every click.
      if (ev.detail > 1 && act.closest('.gs-row')) return;
      runAct(act);
      return;
    }
    var row = ev.target.closest && ev.target.closest('.gs-row[data-id]');
    if (!row) return;
    // Ctrl-click on macOS is a right-click: the contextmenu event has it.
    if (IS_MAC && ev.ctrlKey && !ev.metaKey) return;
    var sectionKey = row.dataset.section, id = row.dataset.id;
    var mod = modKey(ev);
    if (ev.target.closest('[data-role="twistie"]')) {
      if (ev.detail > 1) return;
      if (!mod && !ev.shiftKey) select(sectionKey, id);
      toggle(sectionKey, id);
      return;
    }
    if (mod || ev.shiftKey) {
      // Selecting, never running: Shift adds the range from the anchor, Cmd/Ctrl one row.
      if (ev.shiftKey) selectRange(sectionKey, id, mod);
      else toggleSelected(sectionKey, id);
      if (document.activeElement !== row) row.focus({ preventScroll: true });
      return;
    }
    if (ev.detail > 1) return;
    activate(sectionKey, id);
  });

  sectionsEl.addEventListener('dblclick', function (ev) {
    var row = ev.target.closest && ev.target.closest('.gs-row[data-id]');
    if (!row || ev.target.closest('.gs-row__actions') || ev.target.closest('[data-role="twistie"]')) return;
    if (ev.shiftKey || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var info = index[row.dataset.section] && index[row.dataset.section][row.dataset.id];
    if (!info) return;
    if (info.node.secondary) { post({ type: 'doubleClick', section: row.dataset.section, id: row.dataset.id }); return; }
    if (info.node.collapsible && info.node.hasCommand) toggle(row.dataset.section, row.dataset.id);
  });

  sectionsEl.addEventListener('contextmenu', function (ev) {
    var row = ev.target.closest && ev.target.closest('.gs-row[data-id]');
    ev.preventDefault();
    if (!row) return;
    selectForAction(row.dataset.section, row.dataset.id);
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

  /** Rows per PageUp / PageDown: what fits under the search field, less one so a row stays in view. */
  function pageSize(row) {
    var h = row.offsetHeight || 28;
    var search = document.querySelector('.gs-search');
    var room = window.innerHeight - (search ? search.offsetHeight : 0);
    return Math.max(1, Math.floor(room / h) - 1);
  }

  // Type-ahead: letters typed on a row move focus to the next row whose label
  // starts with them (one letter again cycles through those rows).
  var TYPEAHEAD_MS = 800;
  var typed = { text: '', timer: 0 };

  function typeAhead(sectionKey, rows, i, ch) {
    clearTimeout(typed.timer);
    typed.timer = setTimeout(function () { typed.text = ''; }, TYPEAHEAD_MS);
    typed.text += ch;
    var text = typed.text;
    var labelOf = function (r) {
      var inf = index[sectionKey] && index[sectionKey][r.dataset.id];
      return inf ? inf.node.label.toLowerCase() : '';
    };
    var find = function (prefix, start) {
      for (var k = 0; k < rows.length; k++) {
        var r = rows[(start + k) % rows.length];
        if (labelOf(r).indexOf(prefix) === 0) return r;
      }
      return null;
    };
    // A first letter looks past the focused row; a longer prefix may still be on it.
    return find(text, text.length > 1 ? i : i + 1)
      || (/^(.)\1+$/.test(text) ? find(text.charAt(0), i + 1) : null);
  }

  sectionsEl.addEventListener('keydown', function (ev) {
    var row = ev.target.closest && ev.target.closest('.gs-row[data-id]');
    if (!row || ev.target !== row) return;
    var tree = row.closest('.gs-tree');
    var rows = rowsOf(tree);
    var i = rows.indexOf(row);
    var sectionKey = row.dataset.section, id = row.dataset.id;
    var info = index[sectionKey] && index[sectionKey][id];
    if (!info) return;
    var expanded = row.getAttribute('aria-expanded') === 'true';
    var multi = isMultiSection(sectionKey);
    var mod = modKey(ev);
    // Shift with a move extends the selection from its anchor, where the section selects many.
    var extend = multi && ev.shiftKey && !mod && !ev.altKey;
    var moveTo = function (target) {
      if (!target) return;
      focusRow(target);
      if (extend) selectRange(sectionKey, target.dataset.id, false);
    };
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        if (i < rows.length - 1) moveTo(rows[i + 1]);
        else if (!extend) focusSectionHead(nextSectionKey(sectionKey, 1));
        break;
      case 'ArrowUp':
        ev.preventDefault();
        if (i > 0) moveTo(rows[i - 1]);
        else if (!extend) focusSectionHead(sectionKey);
        break;
      case 'Home': ev.preventDefault(); moveTo(rows[0]); break;
      case 'End': ev.preventDefault(); moveTo(rows[rows.length - 1]); break;
      case 'PageDown': ev.preventDefault(); moveTo(rows[Math.min(rows.length - 1, i + pageSize(row))]); break;
      case 'PageUp': ev.preventDefault(); moveTo(rows[Math.max(0, i - pageSize(row))]); break;
      case 'ArrowRight':
        ev.preventDefault();
        if (info.node.collapsible && !expanded) setExpanded(sectionKey, id, true);
        else if (expanded) focusRow(rows[i + 1]);
        break;
      case 'ArrowLeft':
        ev.preventDefault();
        // Cmd/Ctrl+Left: Collapse All (VS Code's list.collapseAll key).
        if (mod) { if (sectionByKey(sectionKey) && sectionByKey(sectionKey).collapseAll) collapseAll(sectionKey); break; }
        if (expanded) setExpanded(sectionKey, id, false);
        else if (info.parent && rowEl(sectionKey, info.parent.id)) focusRow(rowEl(sectionKey, info.parent.id));
        else focusSectionHead(sectionKey);
        break;
      case 'Enter':
        ev.preventDefault();
        activate(sectionKey, id);
        break;
      case ' ':
        ev.preventDefault();
        // Cmd/Ctrl+Space: the row in or out of the selection. Space: fold or unfold a row that folds, else activate it.
        if (mod && multi) toggleSelected(sectionKey, id);
        else if (info.node.collapsible) toggle(sectionKey, id);
        else activate(sectionKey, id);
        break;
      case 'Escape':
        // A menu takes Escape first, then the search; after those, a selection of several shrinks to this row.
        if (multi && !openMenuState && !ui.query && !(selectedCount(sectionKey) === 1 && isSelected(sectionKey, id))) {
          ev.preventDefault();
          select(sectionKey, id);
        }
        break;
      case 'ContextMenu':
        ev.preventDefault();
        selectForAction(sectionKey, id);
        requestItemMenu(sectionKey, id, rowAnchor(row));
        break;
      case 'F10':
        if (ev.shiftKey) {
          ev.preventDefault();
          selectForAction(sectionKey, id);
          requestItemMenu(sectionKey, id, rowAnchor(row));
        }
        break;
      default:
        if ((ev.key === 'a' || ev.key === 'A') && mod && !ev.altKey && !ev.shiftKey) {
          ev.preventDefault();
          if (multi) selectAll(sectionKey, id);
          break;
        }
        // Type-ahead: printable keys only, never with Cmd/Ctrl/Alt, never "/" (the search field's key).
        if (ev.key.length === 1 && ev.key !== '/' && /\S/.test(ev.key) && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
          var hit = typeAhead(sectionKey, rows, i, ev.key.toLowerCase());
          if (hit) { ev.preventDefault(); focusRow(hit); }
        }
        break;
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

  /**
   * Scrolls a section's body to just under its header's parking place (under
   * the search field when headers are not pinned): an open section whose
   * header is parked comes back, and a section brought into view starts there.
   */
  function bringSectionBack(card) {
    var head = card.querySelector('.gs-section__header');
    var body = card.querySelector('.gs-section__body');
    if (!head || !body) return;
    var pin = parseFloat(card.style.getPropertyValue('--gs-pin-top'));
    var top = isNaN(pin) ? (searchEl ? searchEl.offsetHeight : 0) : pin;
    var y = body.getBoundingClientRect().top + window.scrollY - top - head.offsetHeight;
    window.scrollTo({ top: Math.max(0, y), behavior: scrollBehavior() });
  }

  /**
   * Show a section (the host's showSection: what focusing its native view
   * does). A search that hides its whole card is cleared; the card unfolds,
   * scrolls into place, and its header takes focus when asked.
   */
  function showSection(key, focus) {
    var section = sectionByKey(key);
    if (!section || !section.visible) return;
    cancelScrollRestore();
    closeMenu(false);
    if (!cardEl(key) && ui.query) {
      dropQuery();
      if (anyFilterable()) sendSearch();
    }
    var wasFolded = !!(cardEl(key) && cardEl(key).classList.contains('gs-section--collapsed'));
    ui.collapsedSections[key] = false;
    persist();
    render();
    var card = cardEl(key);
    if (!card) return;
    bringSectionBack(card);
    if (focus) {
      var head = document.getElementById('gs-head-' + key);
      if (head) head.focus({ preventScroll: true });
    }
    // Again once the body has opened (it unfolds over a moment, and the list
    // could not scroll that far before), unless the user has moved since.
    var mine = ++showSeq;
    setTimeout(function () {
      markParked();
      if (wasFolded && mine === showSeq && !userMovedSince(mine)) {
        var again = cardEl(key);
        if (again) bringSectionBack(again);
      }
    }, 320);
  }

  // A showSection's second scroll gives way to the user: any wheel, key or press since.
  var showSeq = 0, movedAt = 0;
  ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach(function (t) {
    window.addEventListener(t, function () { movedAt = showSeq; }, { capture: true, passive: true });
  });
  function userMovedSince(seq) { return movedAt >= seq; }

  function setSectionCollapsed(card, collapsed) {
    var key = card.dataset.key;
    if (heldOpen(sectionByKey(key))) return;
    ui.collapsedSections[key] = collapsed;
    persist();
    card.classList.toggle('gs-section--collapsed', collapsed);
    var head = document.getElementById('gs-head-' + key);
    if (head) head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    markParked();
    reportShown();
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
  //
  // One field for every section. Diagrams, Table Library and Relationships are
  // filtered by the host (the native views' own filter: keys such as layer:,
  // col:, is:unused, rows not listed yet): the text is sent debounced and the
  // filtered trees come back as the next state. Help & Feedback, which has no
  // filter, is matched here. While the answer is on its way the rows shown are
  // the last answer's: nothing flickers, and the field keeps focus and caret.

  var announceTimer = null, searchFrame = 0;

  /** Some time after the last keystroke, the field's text goes to the host (at once with flush). */
  function scheduleSend() {
    clearTimeout(search.timer);
    search.timer = setTimeout(sendSearch, GUIDE.debounceMs);
  }

  /** Whether the host has yet to answer the field's text (unsent, or sent and not acknowledged). */
  function searchPending() { return !!search.timer || search.seq > search.ack; }

  function sendSearch() {
    clearTimeout(search.timer);
    search.timer = 0;
    // Nothing filtered by the host (no project yet): the field matches Help & Feedback here only.
    if (!anyFilterable()) { announceLocal(); return; }
    var text = ui.query;
    if (text === search.sent) return;
    search.sent = text;
    search.seq++;
    post({ type: 'search', text: text, seq: search.seq });
    paintSearch();
  }

  function announceLocal() {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(function () {
      if (!query()) return;
      var n = document.querySelectorAll('.gs-row[data-id] .gs-mark').length;
      announce(n ? n + (n === 1 ? ' match' : ' matches') : 'No matches');
    }, 400);
  }

  /** What the host found, said once the answer is in: "4 of 52 tables, 1 of 10 diagrams". */
  function announceFound() {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(function () {
      if (!query()) return;
      var parts = model.sections.filter(function (s) { return s.visible && s.found && s.found.shown > 0; })
        .map(function (s) { return s.found.shown + ' of ' + s.found.total + ' ' + s.found.noun; });
      announce(parts.length ? parts.join(', ') : 'No matches');
    }, 400);
  }

  /** The field's text changed (typing, a key picked from the list). */
  function onSearchInput() {
    ui.query = searchInput.value;
    ui.searchOpen = {};
    // Still typing: an Enter, Down or Escape before this no longer moves focus when its answer comes.
    search.focusFirst = false;
    search.returnTo = null;
    // One render per frame, however fast the typing (Help & Feedback's matches, the Clear button).
    if (!searchFrame) searchFrame = requestAnimationFrame(function () { searchFrame = 0; render(); });
    paintSearch();
    scheduleSend();
  }

  /** Put text in the field without sending it: what the host says it shows. */
  function adoptSearch(text) {
    search.sent = text;
    if (ui.query === text && searchInput.value === text) return;
    ui.query = text;
    ui.searchOpen = {};
    if (searchInput.value !== text) searchInput.value = text;
  }

  searchInput.addEventListener('input', onSearchInput);

  searchInput.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      // Clear, then go back to where focus was before the field took it.
      var had = !!searchInput.value;
      var back = searchReturn;
      if (had || back) ev.preventDefault();
      if (had) clearSearch(true);
      if (back) {
        // The rows the field's filter hid (and the filtered ids) come back with the host's
        // answer to the cleared field: go back once it is in, not to what shows before it.
        searchReturn = null;
        if (searchPending()) search.returnTo = back;
        else returnFromSearch(back);
      }
    } else if (ev.key === 'Enter' || ev.key === 'ArrowDown') {
      // Now, not after the pause; the first row of this text's answer, once it is in
      // (the rows shown meanwhile are the last answer's, about to be replaced).
      if (search.timer) sendSearch();
      if (search.seq > search.ack) { ev.preventDefault(); search.focusFirst = true; return; }
      if (focusFirstRow() || ev.key === 'Enter') ev.preventDefault();
    }
  });

  function focusFirstRow() {
    var first = document.querySelector('.gs-row[data-id]');
    if (first) focusRow(first);
    return !!first;
  }

  /** Focus back where it was before the field took it: the same row or button, else its section's header. */
  function returnFromSearch(k) {
    searchReturn = null;
    var target = focusTarget(k) || (k.section ? document.getElementById('gs-head-' + k.section) : null);
    if (!target) return;
    if (target.classList.contains('gs-row')) focusRow(target);
    else target.focus();
  }

  /**
   * Empty the field and the page's own matching. The rows that come back
   * were there before the search: the next draw plays no entrance for them.
   */
  function dropQuery() {
    searchInput.value = '';
    ui.query = '';
    ui.searchOpen = {};
    search.focusFirst = false;
    renderQuiet = true;
  }

  function clearSearch(keepFocus) {
    dropQuery();
    render();
    // A cleared field goes at once: no pause to wait out.
    sendSearch();
    if (keepFocus !== true) searchInput.focus();
    announce('Search cleared');
  }
  searchClear.addEventListener('click', function () { clearSearch(); });

  /** Cmd/Ctrl+F, "/" (or the host's focusSearch): the caret in the field, its text selected; Escape comes back. */
  function focusSearchField() {
    var k = captureFocus();
    if (!k && lastFocus) k = { el: null, section: lastFocus.section, id: lastFocus.id, onRow: true };
    if (k) searchReturn = k;
    closeMenu(false);
    searchInput.focus();
    searchInput.select();
  }

  // Focus leaving the list for the field (a click on it, Tab): Escape there comes back.
  sectionsEl.addEventListener('focusout', function (ev) {
    if (ev.relatedTarget === searchInput) searchReturn = focusKeyOf(ev.target);
  });

  // Picking a key from the list puts it in the field, where the caret is.
  function insertKey(text) {
    var v = searchInput.value;
    var start = typeof searchInput.selectionStart === 'number' ? searchInput.selectionStart : v.length;
    var end = typeof searchInput.selectionEnd === 'number' ? searchInput.selectionEnd : v.length;
    // The whole text selected ("/" and Cmd/Ctrl+F leave it so, for typing to replace it): a key
    // picked from the list adds to the query, at its end, and never wipes it.
    if (v && start === 0 && end === v.length) start = end = v.length;
    var before = v.slice(0, start), after = v.slice(end);
    var lead = before && !/\s$/.test(before) ? ' ' : '';
    // A key that takes a value (layer:) waits for it; a complete one (is:unused) is followed by a space.
    var trail = /:$/.test(text) || /^\s/.test(after) ? '' : ' ';
    var head = before + lead + text + trail;
    if (head.length + after.length > searchInput.maxLength && searchInput.maxLength > 0) return;
    searchInput.value = head + after;
    searchInput.focus();
    try { searchInput.setSelectionRange(head.length, head.length); } catch (e) { /* not a text field */ }
    onSearchInput();
  }

  function openKeysMenu() {
    var items = GUIDE.keys.map(function (k) {
      return { title: k.key, hint: k.meaning, tip: k.meaning + ' (filters ' + k.where + ')', code: true, run: function () { insertKey(k.key); } };
    });
    if (!items.length) return;
    openMenu([items], buttonAnchor(keysButton), { searchKeys: true, title: 'Filter by' }, { cls: 'gs-menu--keys', note: GUIDE.syntax });
  }

  keysButton.addEventListener('click', function () {
    if (swallowReopen(keysButton)) return;
    openKeysMenu();
  });

  noResultsEl.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-nr]');
    if (!b) return;
    if (b.dataset.nr === 'clear') clearSearch();
    else if (b.dataset.nr === 'keys') openKeysMenu();
  });

  document.addEventListener('keydown', function (ev) {
    var editing = ev.target === searchInput;
    var find = (ev.key === 'f' || ev.key === 'F') && modKey(ev) && !ev.shiftKey && !ev.altKey;
    // "/" types itself in a menu's type-ahead (which prevents it); everywhere else in the list it is the field's key.
    var slash = ev.key === '/' && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.defaultPrevented;
    if (!editing && (find || slash)) {
      ev.preventDefault();
      focusSearchField();
    } else if (ev.key === 'Escape' && !editing && !openMenuState && ui.query) {
      // Escape closes a menu first (its own handler); with none open, it clears the search.
      ev.preventDefault();
      var back = lastFocus;
      clearSearch(true);
      // The row now (it may be listed under the filter's id until the answer replaces it;
      // focus then follows it to its unfiltered row: restoreFocus), and again once the rows are back.
      var row = back && sameRowEl(back.section, back.id);
      if (row) focusRow(row);
      if (back && searchPending()) search.returnTo = { el: null, section: back.section, id: back.id, onRow: true };
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
      if (!pendingScroll) scheduleScrollSave();
    });
  }, { passive: true });

  // ------------------------------------------------------------------- menus

  /**
   * groups: [[{ title, icon, run }]]; anchor: { x, y, alignRight };
   * owner: { section, id?, slot?, title }: what to mark open and refocus, as
   * identifiers (a row by section + id, a button by its data-slot), looked up
   * again whenever needed, since a new state may replace the elements; or
   * { searchKeys: true } for the search field's keys button.
   * An entry may also carry hint (a second, quieter text), tip (its tooltip)
   * and code (its title is something to type). opts: { cls, note } (a
   * class for the menu, a closing line of plain text).
   */
  function openMenu(groups, anchor, owner, opts) {
    closeMenu(false);
    groups = groups.filter(function (g) { return g.length > 0; });
    if (!groups.length) return;
    opts = opts || {};
    var menu = el('div', 'gs-menu' + (opts.cls ? ' ' + opts.cls : ''));
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
        item.appendChild(el('span', 'gs-menu__item-label' + (a.code ? ' gs-menu__item-label--code' : ''), a.title));
        if (a.hint) item.appendChild(el('span', 'gs-menu__item-hint', a.hint));
        if (a.tip) item.title = a.tip;
        item.addEventListener('click', function () { closeMenu(true); a.run(); });
        menu.appendChild(item);
      });
    });
    if (opts.note) {
      var note = el('div', 'gs-menu__note', opts.note);
      note.setAttribute('role', 'note');
      menu.appendChild(note);
    }
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
    if (o && o.searchKeys) { out.button = keysButton; return out; }
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
    var menuEl = openMenuState.el;
    openMenuState = null;
    if (refocus) {
      var els = ownerEls(owner);
      // The keys list belongs to the field: closing it goes back to typing. Otherwise the
      // row, else the button that opened it, else (redrawn away) its section's header.
      var target = owner.searchKeys ? searchInput
        : els.row || els.button || (owner.section ? document.getElementById('gs-head-' + owner.section) : null);
      // Focused while the owner is still marked open: a header's buttons are drawn only while
      // it is hovered, holds focus or has its menu open, so a button focused after the mark
      // is gone is not drawn, and focus would drop to the page.
      if (target) target.focus({ preventScroll: true });
    }
    menuEl.remove();
    markOwner(owner, false);
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

  // --------------------------------------------------------- drag and drop
  //
  // A row with a drag kind (node.drag) can be dragged; a row whose node.drop
  // lists that kind takes it. The webview only says which rows: the host runs
  // the native views' own drag and drop handlers. A drag let go outside the
  // sidebar (over a diagram) is finished by the canvas, not here.

  var DRAG_MIME = 'application/vnd.erdstudio.glass-drag';
  // The native Table Library's drag type: a canvas that does get the drop reads it as a Table Library drag.
  var LIBRARY_MIME = 'application/vnd.code.tree.erdstudio.modellibrary';
  var SPRING_MS = 650;
  var drag = null;      // { kind, section, ids, over: { section, id, cls, mark } | null }; mark: the row that shows cls
  var spring = null;    // { key, timer }: the row or header the drag is waiting on to open

  function clearSpring() {
    if (!spring) return;
    clearTimeout(spring.timer);
    var waiting = sectionsEl.querySelector('.gs-section__header.is-drop-wait');
    if (waiting) waiting.classList.remove('is-drop-wait');
    spring = null;
  }

  function springAfter(key, run) {
    if (spring && spring.key === key) return;
    clearSpring();
    spring = { key: key, timer: setTimeout(function () { spring = null; run(); }, SPRING_MS) };
  }

  function setDragOver(over) {
    if (!drag) return;
    var was = drag.over;
    if ((!was && !over) || (was && over && was.section === over.section && was.id === over.id && was.cls === over.cls && was.mark === over.mark)) return;
    if (was) {
      var old = rowEl(was.section, was.mark);
      if (old) old.classList.remove(was.cls);
    }
    drag.over = over;
    if (over) {
      var now = rowEl(over.section, over.mark);
      if (now) now.classList.add(over.cls);
    }
  }

  /** Where a drag of drag.kind would land on this row: null when the row does not take it. */
  function dropOn(row) {
    var sectionKey = row.dataset.section, id = row.dataset.id;
    var info = index[sectionKey] && index[sectionKey][id];
    if (!info || !info.node.drop || info.node.drop.indexOf(drag.kind) === -1) return null;
    if (drag.section === sectionKey && drag.ids.indexOf(id) !== -1) return null;
    var cls = 'is-drop-target', mark = id;
    // A drag within one tree is a move: the row lands where this one is, so mark the edge it will sit at.
    if (drag.section === sectionKey) {
      var from = rowEl(drag.section, drag.ids[0]);
      cls = from && (from.compareDocumentPosition(row) & 4) ? 'is-drop-after' : 'is-drop-before';
      // After an open row means after its last row: the line goes under the whole group.
      if (cls === 'is-drop-after') {
        var level = Number(row.getAttribute('aria-level'));
        for (var next = row.nextElementSibling; next && Number(next.getAttribute('aria-level')) > level; next = next.nextElementSibling) {
          if (next.dataset.id) mark = next.dataset.id;
        }
      }
    }
    return { section: sectionKey, id: id, cls: cls, mark: mark };
  }

  // at: where a drag let go outside the sidebar ended, on screen (releasePoint), or nothing.
  function endDrag(at) {
    if (!drag) return;
    setDragOver(null);
    clearSpring();
    var rows = sectionsEl.querySelectorAll('.gs-row.is-dragging');
    for (var i = 0; i < rows.length; i++) rows[i].classList.remove('is-dragging');
    document.body.classList.remove('gs-dragging');
    drag = null;
    post(at ? { type: 'dragEnd', at: at } : { type: 'dragEnd' });
  }

  // The page's last pointer event (page point and screen point) and the
  // window's place then: the reference a canvas maps a release point by.
  // Pointer events stop once a drag leaves the sidebar, so the last one
  // before the drag is it.
  var pointerRef = null;  // { x, y, sx, sy, wx, wy }
  function notePointer(ev) {
    if (isFinite(ev.clientX) && isFinite(ev.clientY) && isFinite(ev.screenX) && isFinite(ev.screenY)) {
      pointerRef = { x: ev.clientX, y: ev.clientY, sx: ev.screenX, sy: ev.screenY, wx: window.screenX, wy: window.screenY };
    }
  }
  window.addEventListener('pointerdown', notePointer, true);
  window.addEventListener('pointermove', notePointer, true);

  // A drag let go outside the sidebar, where no frame took the drop: where,
  // so the canvas under it can add the drag at once (a canvas gets no pointer
  // event until the pointer moves again). The dragend's clientX / clientY
  // are the release point in this page's coordinates (outside its bounds);
  // its screenX / screenY are not to be trusted (Chromium leaves the frame's
  // place out), so the page's last pointer event goes with it instead: a
  // canvas that knows its own place and scale on screen maps the point
  // through it (screen and page pixels differ by VS Code's zoom). Null when
  // anything is unknown or the drag ended over the sidebar itself.
  function releasePoint(ev) {
    var ref = pointerRef;
    if (!ref || !ev || window.screenX !== ref.wx || window.screenY !== ref.wy) return null;
    var x = ev.clientX, y = ev.clientY;
    if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return null;
    if (x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight) return null;
    var effect = ev.dataTransfer && ev.dataTransfer.dropEffect;
    if (effect && effect !== 'none') return null;
    return { x: x, y: y, refX: ref.x, refY: ref.y, refScreenX: ref.sx, refScreenY: ref.sy, windowX: ref.wx, windowY: ref.wy };
  }

  /** What a drag of several rows is called, by its kind ('tables' counts the tables it carries). */
  var DRAG_NOUNS = { tables: ['table', 'tables'], layer: ['layer', 'layers'] };

  /**
   * The words on a drag of several rows: what it carries, counted as the
   * canvas's "Drop to add N tables" counts it. A 'tables' drag counts each
   * row's tables (the host's dragCount: a schema or layer row carries all
   * of its own), a row under another dragged row not again, at most the
   * most one drop adds (DRAG_TABLES_LIMIT, as the host caps it).
   */
  function dragText(key, ids, kind) {
    var nouns = DRAG_NOUNS[kind] || ['row', 'rows'];
    var n = ids.length;
    if (kind === 'tables') {
      var dragged = {};
      ids.forEach(function (id) { dragged[id] = true; });
      n = 0;
      ids.forEach(function (id) {
        var info = index[key] && index[key][id];
        if (!info) return;
        for (var p = info.parent; p; p = index[key][p.id] && index[key][p.id].parent) if (dragged[p.id]) return;
        n += typeof info.node.dragCount === 'number' ? info.node.dragCount : 1;
      });
      n = Math.min(n, DRAG_TABLES_LIMIT);
    }
    return n + ' ' + (n === 1 ? nouns[0] : nouns[1]);
  }

  /** The drag's picture: the row's icon and label, or for several rows what they carry, drawn as a small stack. */
  function dragPill(row, node, count, text) {
    var pill = el('div', 'gs-dragpill' + (count > 1 ? ' gs-dragpill--many' : ''));
    // Drawn afresh, not cloned: a cloned row icon carries a style attribute, which the CSP refuses.
    if (node.icon) pill.appendChild(rowIcon(node.icon, node));
    pill.appendChild(el('span', 'gs-dragpill__label', count > 1 ? text : node.label));
    document.body.appendChild(pill);
    setTimeout(function () { if (pill.parentNode) pill.parentNode.removeChild(pill); }, 0);
    return pill;
  }

  // The most rows one drag names (the host's MAX_ROWS_SENT: it refuses more). A drag of more
  // does not start: it never carries part of the selection.
  var MAX_ROWS_SENT = 20000;

  sectionsEl.addEventListener('dragstart', function (ev) {
    var row = ev.target.closest && ev.target.closest('.gs-row[data-id]');
    var info = row && index[row.dataset.section] && index[row.dataset.section][row.dataset.id];
    if (!info || !info.node.drag || !ev.dataTransfer) { ev.preventDefault(); return; }
    closeMenu(false);
    var key = row.dataset.section, id = row.dataset.id;
    // A selected row drags the selection (its rows of the same drag kind); any other row drags alone and becomes the selection.
    var ids = [id];
    if (isMultiSection(key) && isSelected(key, id)) {
      ids = orderedSelection(key).filter(function (s) {
        var x = index[key][s];
        return x && x.node.drag === info.node.drag;
      });
      if (ids.length > MAX_ROWS_SENT) {
        ev.preventDefault();
        announce('Too many rows selected to drag: at most ' + MAX_ROWS_SENT);
        return;
      }
      lastFocus = { section: key, id: id };
    } else {
      select(key, id);
    }
    drag = { kind: info.node.drag, section: key, ids: ids, over: null };
    try {
      ev.dataTransfer.effectAllowed = 'copyMove';
      ev.dataTransfer.setData(DRAG_MIME, drag.kind);
      if (drag.kind === 'tables') ev.dataTransfer.setData(LIBRARY_MIME, '[]');
      ev.dataTransfer.setDragImage(dragPill(row, info.node, ids.length, dragText(key, ids, drag.kind)), 14, 14);
    } catch (e) { /* the drag still works with the browser's own picture */ }
    ids.forEach(function (d) { var r = rowEl(key, d); if (r) r.classList.add('is-dragging'); });
    document.body.classList.add('gs-dragging');
    post({ type: 'dragStart', section: drag.section, ids: drag.ids });
  });

  function onDragOver(ev) {
    if (!drag) return;
    var row = ev.target.closest && ev.target.closest('.gs-row[data-id]');
    var over = row ? dropOn(row) : null;
    setDragOver(over);
    if (over) {
      ev.preventDefault();
      try { ev.dataTransfer.dropEffect = over.cls === 'is-drop-target' ? 'copy' : 'move'; } catch (e) { /* read-only in some engines */ }
    }
    // Waiting over something closed opens it, as a native tree does: a folded row, a folded or parked section.
    var head = !row && ev.target.closest && ev.target.closest('.gs-section__header');
    if (row && row.getAttribute('aria-expanded') === 'false') {
      var sectionKey = row.dataset.section, id = row.dataset.id;
      springAfter('r' + sectionKey + '\u0000' + id, function () { setExpanded(sectionKey, id, true); });
    } else if (head) {
      var card = head.closest('.gs-section');
      var folded = card.classList.contains('gs-section--collapsed');
      if (folded || head.classList.contains('is-parked')) {
        springAfter('h' + card.dataset.key, function () {
          head.classList.remove('is-drop-wait');
          if (folded) setSectionCollapsed(card, false); else bringSectionBack(card);
        });
        head.classList.add('is-drop-wait');
      } else {
        clearSpring();
      }
    } else {
      clearSpring();
    }
  }

  sectionsEl.addEventListener('dragenter', onDragOver);
  sectionsEl.addEventListener('dragover', onDragOver);

  sectionsEl.addEventListener('dragleave', function (ev) {
    if (!drag || (ev.relatedTarget && sectionsEl.contains(ev.relatedTarget))) return;
    // Chromium often names no relatedTarget: a leave is real only once the pointer is off the list.
    var at = document.elementFromPoint(ev.clientX, ev.clientY);
    if (at && sectionsEl.contains(at)) return;
    setDragOver(null);
    clearSpring();
  });

  sectionsEl.addEventListener('drop', function (ev) {
    if (!drag) return;
    var row = ev.target.closest && ev.target.closest('.gs-row[data-id]');
    var over = row ? dropOn(row) : null;
    if (!over) return;
    ev.preventDefault();
    post({ type: 'drop', section: over.section, id: over.id });
    endDrag();
  });

  document.addEventListener('dragend', function (ev) { endDrag(releasePoint(ev)); });
  // The dragged row can be redrawn away mid-drag, and its dragend then reaches nothing:
  // pointer events only come back once the drag is over, so the first one ends it.
  window.addEventListener('pointermove', function () { if (drag) endDrag(); }, true);
  window.addEventListener('pointerdown', function () { if (drag) endDrag(); }, true);

  // --------------------------------------------------------- host messages

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'state') {
      var sections = Array.isArray(msg.sections) ? msg.sections : [];
      pendingExpand = {};
      // The answer to the field's newest search, once it is in.
      var answered = typeof msg.searchSeq === 'number' && msg.searchSeq > search.ack;
      if (answered) search.ack = Math.min(msg.searchSeq, search.seq);
      // What the field shows, as the host says: a filter set from the Command
      // Palette shows up in it (or empties it, when the sections' filters
      // differ). Never while the user's own text is on its way: theirs wins.
      var said = typeof msg.search === 'string' ? msg.search : null;
      var hostChanged = said !== hostSearch;
      hostSearch = said;
      if (hostChanged && !searchPending()) adoptSearch(said === null ? '' : said);
      // The same state again (a refresh that changed nothing): nothing to draw.
      var json = JSON.stringify([sections, hostSearch]);
      if (rendered && json === lastStateJson) {
        paintSearch();
      } else {
        lastStateJson = json;
        model = { sections: sections };
        buildIndex();
        keepListedSelection();
        // A row the page asked for and the host has now listed may be asked for again later.
        Object.keys(expandAsked).forEach(function (k) {
          var at = k.indexOf('\u0000');
          var info = index[k.slice(0, at)] && index[k.slice(0, at)][k.slice(at + 1)];
          if (!info || info.node.childrenLoaded !== false) delete expandAsked[k];
        });
        // The rows a search swapped in do not "enter" one by one.
        if (answered || hostChanged) renderQuiet = true;
        render();
        restoreScroll();
      }
      if (answered && !searchPending()) {
        announceFound();
        if (search.focusFirst) { search.focusFirst = false; focusFirstRow(); }
        if (search.returnTo) {
          var ret = search.returnTo;
          search.returnTo = null;
          // Only while focus is where Escape left it (the field, the row it went back to, or
          // nowhere): a click or Tab meanwhile was the user's, and stays.
          var now = document.activeElement;
          var nowRow = now && now.closest ? now.closest('.gs-row[data-id]') : null;
          if (!now || now === document.body || now === searchInput || (nowRow && ret.id && plainId(nowRow.dataset.id) === plainId(ret.id))) returnFromSearch(ret);
        }
      }
    } else if (msg.type === 'itemMenu') {
      if (!pendingMenu || pendingMenu.section !== msg.section || pendingMenu.id !== msg.id) return;
      var p = pendingMenu;
      pendingMenu = null;
      var info = index[p.section] && index[p.section][p.id];
      var row = rowEl(p.section, p.id);
      // The rows the menu acts on are the ones selected as it opens.
      var selection = actionSelection(p.section, p.id);
      var groups = (msg.groups || []).map(function (g) {
        return g.map(function (a) {
          return { title: a.title, icon: a.icon, run: function () { postRowInvoke(p.section, p.id, a, selection); } };
        });
      });
      if (!row) return;
      openMenu(groups, p.anchor, { section: p.section, id: p.id, slot: p.slot, title: info ? info.node.label : '' });
    } else if (msg.type === 'reveal') {
      var key = msg.section;
      // The revealed row decides where the list is: a saved scroll place waiting to come back gives way.
      cancelScrollRestore();
      // Its ancestors, then (the native expand option) the row itself and below.
      (msg.expand || []).concat(Array.isArray(msg.open) ? msg.open : []).forEach(function (id) {
        if (typeof id === 'string') ui.expanded[key + '\u0000' + id] = true;
      });
      ui.collapsedSections[key] = false;
      if (msg.id) ui.sel = { section: key, ids: [msg.id], anchor: msg.id };
      // A row the field's own match hides (Help & Feedback) needs the field cleared;
      // a host-filtered section listed the row under its filter, so the field stays.
      var revealed = sectionByKey(key);
      if (ui.query && msg.id && !hostFiltered(revealed)) {
        dropQuery();
        if (anyFilterable()) sendSearch();
      }
      persist();
      render();
      var target = msg.id && rowEl(key, msg.id);
      if (target) {
        target.scrollIntoView({ block: 'center' });
        if (msg.focus) { lastFocus = { section: key, id: msg.id }; target.focus({ preventScroll: true }); }
      }
    } else if (msg.type === 'focusSearch') {
      // The page's own Cmd/Ctrl+F may have got there first (and the user may be typing): leave the field be.
      if (document.activeElement !== searchInput) focusSearchField();
    } else if (msg.type === 'showSection') {
      if (typeof msg.section === 'string') showSection(msg.section, msg.focus === true);
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
