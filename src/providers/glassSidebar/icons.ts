/**
 * Line icons for the glass sidebar: the codicon ids the sidebar trees and
 * their menus actually use (`ThemeIcon` ids in the providers, `$(id)` in
 * package.json command icons), redrawn in the same 16-unit stroke language
 * as the editor's toolbar (`webview/components/Toolbar/toolbarIcons.tsx`).
 * @vscode/codicons is not a dependency and the webview loads no fonts, so an
 * id missing here falls back to a neutral dot.
 *
 * Each value is the inner markup of a `<svg viewBox="0 0 16 16">` drawn with
 * `stroke="currentColor"`; `F` marks a filled shape. Constant, never built
 * from data, so it is safe to inline.
 */

const F = 'fill="currentColor" stroke="none"';

const folder = '<path d="M2.25 4.75a1.5 1.5 0 0 1 1.5-1.5h2.4l1.5 1.5h4.6a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-8.5a1.5 1.5 0 0 1-1.5-1.5z"/>';
const circle = '<circle cx="8" cy="8" r="5.6"/>';

export const GLASS_ICONS: Readonly<Record<string, string>> = {
  // UI chrome
  'chevron-right': '<path d="M6.25 4.25 10 8l-3.75 3.75"/>',
  'chevron-down': '<path d="M4.25 6.25 8 10l3.75-3.75"/>',
  ellipsis: `<circle cx="3.6" cy="8" r="1.15" ${F}/><circle cx="8" cy="8" r="1.15" ${F}/><circle cx="12.4" cy="8" r="1.15" ${F}/>`,
  close: '<path d="M4.75 4.75l6.5 6.5M11.25 4.75l-6.5 6.5"/>',
  search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2l3.05 3.05"/>',
  // Rows
  add: '<path d="M8 3.5v9M3.5 8h9"/>',
  'diff-added': '<rect x="2.5" y="2.5" width="11" height="11" rx="2.75"/><path d="M8 5.5v5M5.5 8h5"/>',
  'arrow-swap': '<path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13"/>',
  'arrow-right': '<path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5"/>',
  'arrow-left': '<path d="M13 8H3M6.5 4.5 3 8l3.5 3.5"/>',
  'arrow-both': '<path d="M2.75 8h10.5M5.5 5.25 2.75 8l2.75 2.75M10.5 5.25 13.25 8l-2.75 2.75"/>',
  'clear-all': '<path d="M3 4.5h10M3 8h5.5M3 11.5h4M10.25 9.25l3 3M13.25 9.25l-3 3"/>',
  error: `${circle}<path d="M6.1 6.1l3.8 3.8M9.9 6.1 6.1 9.9"/>`,
  warning: '<path d="M7.13 3.03a1 1 0 0 1 1.74 0l5.02 8.98a1 1 0 0 1-.87 1.49H2.98a1 1 0 0 1-.87-1.49z"/><path d="M8 6.5v2.75"/><circle cx="8" cy="11.25" r=".7" fill="currentColor" stroke="none"/>',
  question: `${circle}<path d="M6.4 6.5a1.65 1.65 0 1 1 2.35 1.5c-.5.24-.75.6-.75 1.1v.25"/><circle cx="8" cy="11.1" r=".7" ${F}/>`,
  issues: `${circle}<circle cx="8" cy="8" r="1.6" ${F}/>`,
  'pass-filled': `${circle}<path d="M5.6 8.2l1.7 1.7 3.2-3.4"/>`,
  'circle-slash': `${circle}<path d="M4.1 11.9l7.8-7.8"/>`,
  folder,
  'folder-opened': '<path d="M2.25 11.25V4.75a1.5 1.5 0 0 1 1.5-1.5h2.4l1.5 1.5h4.1a1.5 1.5 0 0 1 1.5 1.5v.75"/><path d="M2.25 11.25 4 7.4a1.5 1.5 0 0 1 1.36-.9h7.9a.9.9 0 0 1 .82 1.27l-1.6 3.6a1.5 1.5 0 0 1-1.37.88H3.75a1.5 1.5 0 0 1-1.5-1.5z"/>',
  'folder-library': `${folder}<path d="M5.75 8.25h4.5M5.75 10.25h3"/>`,
  'new-folder': `${folder}<path d="M10 7.5v3.25M8.4 9.1h3.2"/>`,
  layers: '<path d="M8 2.5 13.5 5.5 8 8.5 2.5 5.5z"/><path d="M2.5 8.25 8 11.25l5.5-3"/><path d="M2.5 10.75 8 13.75l5.5-3"/>',
  json: '<path d="M5.5 2.75c-1.2 0-1.75.6-1.75 1.75v1.6c0 .95-.45 1.6-1.25 1.9.8.3 1.25.95 1.25 1.9v1.6c0 1.15.55 1.75 1.75 1.75M10.5 2.75c1.2 0 1.75.6 1.75 1.75v1.6c0 .95.45 1.6 1.25 1.9-.8.3-1.25.95-1.25 1.9v1.6c0 1.15-.55 1.75-1.75 1.75"/>',
  'symbol-class': '<rect x="2.5" y="3" width="11" height="10" rx="1.9"/><path d="M2.5 6.5h11M6.5 6.5V13"/>',
  'symbol-namespace': '<path d="M5.5 3H4.4a1.15 1.15 0 0 0-1.15 1.15v7.7A1.15 1.15 0 0 0 4.4 13h1.1M10.5 3h1.1a1.15 1.15 0 0 1 1.15 1.15v7.7A1.15 1.15 0 0 1 11.6 13h-1.1M6.6 8h2.8"/>',
  references: '<circle cx="4.25" cy="4.5" r="1.75"/><circle cx="11.75" cy="11.5" r="1.75"/><path d="M6 4.5h1.6A1.4 1.4 0 0 1 9 5.9v4.2a1.4 1.4 0 0 0 1.4 1.4h-.4"/>',
  sparkle: '<path d="M7.5 2.5c.4 2.55 1.75 3.9 4.25 4.25-2.5.35-3.85 1.7-4.25 4.25-.4-2.55-1.75-3.9-4.25-4.25 2.5-.35 3.85-1.7 4.25-4.25z"/><path d="M12.25 10.75v2.5M11 12h2.5"/>',
  'cloud-download': '<path d="M4.75 11.25a2.75 2.75 0 0 1-.4-5.47 3.75 3.75 0 0 1 7.3.22 2.5 2.5 0 0 1-.15 5.25"/><path d="M8 7.75v5.5M6.1 11.4 8 13.3l1.9-1.9"/>',
  'play-circle': `${circle}<path d="M6.9 5.75v4.5L10.5 8z" fill="currentColor" stroke-width="1"/>`,
  compass: `${circle}<path d="M10.2 5.8 9 9 5.8 10.2 7 7z"/>`,
  'comment-discussion': '<path d="M2.5 3.75A1.25 1.25 0 0 1 3.75 2.5h6.5a1.25 1.25 0 0 1 1.25 1.25v4A1.25 1.25 0 0 1 10.25 9H6.5L4.25 10.75V9h-.5A1.25 1.25 0 0 1 2.5 7.75z"/><path d="M13.5 6.25v4.5A1.25 1.25 0 0 1 12.25 12H12v1.5L10 12H7.75"/>',
  output: '<rect x="2.5" y="3" width="11" height="10" rx="1.9"/><path d="M5.1 6.6 6.75 8 5.1 9.4M8.5 10h2.4"/>',
  wand: '<path d="M3 13 9.75 6.25M8.75 5.25l2 2"/><path d="M12 2.25v2.5M10.75 3.5h2.5M13.25 7.25v1.5M12.5 8h1.5"/>',
  export: '<path d="M8 9.75v-7M5.25 5.5 8 2.75l2.75 2.75M3.25 9.5v2.75a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V9.5"/>',
  'list-tree': '<path d="M2.75 3.5H6M4.4 3.5v8M4.4 7.75H7M4.4 11.5H7M9.5 7.75h3.75M9.5 11.5h3.75M8.5 3.5h4.75"/>',
  'open-preview': '<rect x="2.5" y="2.5" width="11" height="11" rx="2.25"/><path d="M2.5 6h11M6.25 6v7.5"/>',
  'go-to-file': '<path d="M4 2.5h4.75L12 5.75v7.75H4z"/><path d="M8.75 2.5v3.25H12M6 10h4M8.6 8.6 10 10l-1.4 1.4"/>',
  files: '<path d="M5.5 4.5V2.75h4.75L13 5.5v6.75h-1.5"/><path d="M3 4.5h5.25L10.5 6.75v6.75H3z"/>',
  filter: '<path d="M2.75 3.75h10.5L9.25 8.5v3.6l-2.5 1.15V8.5z"/>',
  'filter-filled': '<path d="M2.75 3.75h10.5L9.25 8.5v3.6l-2.5 1.15V8.5z" fill="currentColor"/>',
  refresh: '<path d="M12.75 8a4.75 4.75 0 1 1-1.4-3.36"/><path d="M12.5 2.75v2.5H10"/>',
  // Command icons that can reach a menu (package.json `$(id)`).
  beaker: '<path d="M6 2.5h4M6.75 2.5v3.9L3.1 12.1a1 1 0 0 0 .85 1.4h8.1a1 1 0 0 0 .85-1.4L9.25 6.4V2.5"/><path d="M4.6 9.75h6.8"/>',
  book: '<path d="M8 4.25C6.9 3.3 5.4 2.9 3 2.9v9c2.4 0 3.9.4 5 1.35 1.1-.95 2.6-1.35 5-1.35v-9c-2.4 0-3.9.4-5 1.35z"/><path d="M8 4.25v9"/>',
  hubot: '<rect x="2.75" y="4.25" width="10.5" height="8.5" rx="2.5"/><path d="M8 2.25v2"/><circle cx="6" cy="8.25" r=".9" fill="currentColor" stroke="none"/><circle cx="10" cy="8.25" r=".9" fill="currentColor" stroke="none"/><path d="M6.4 10.75h3.2"/>',
};

/** The fallback for an icon id not in {@link GLASS_ICONS}: a neutral dot. */
export const GLASS_ICON_FALLBACK = '<circle cx="8" cy="8" r="2.25" fill="currentColor" stroke="none" opacity=".55"/>';
