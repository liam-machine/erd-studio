/**
 * A `vscode.TreeItem` as plain JSON for the glass sidebar's webview: label
 * (with its highlights), description, tooltip text, contextValue, collapsible
 * state, whether it has a click command, its icon, and a stable id.
 *
 * Duck-typed rather than `instanceof` (works with the test mock and with any
 * `Uri` / `ThemeIcon` shape), and free of side effects: the command itself
 * never leaves the host (the webview only learns that a row has one).
 */
import type * as vscode from 'vscode';

import type { SerialisedIcon, SerialisedNode } from './protocol';

export type { SerialisedIcon, SerialisedNode } from './protocol';

const HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Plain text of a tooltip or MarkdownString: no markup, no `$(icon)` syntax. */
export function plainText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  const md = (value as { value?: unknown }).value;
  if (typeof md !== 'string') return undefined;
  // Hold backslash escapes aside first, so `\*` is never read as emphasis (or `\[` as a link).
  return md
    .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, (_m, ch: string) => `\uE000${ch.charCodeAt(0)}\uE001`)
    .replace(/\$\([\w~-]+\)\s?/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*---+\s*$/gm, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\uE000(\d+)\uE001/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .trim();
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

function uriLike(value: unknown): value is vscode.Uri {
  return typeof value === 'object' && value !== null && typeof (value as { toString?: unknown }).toString === 'function'
    && ('scheme' in value || 'fsPath' in value || 'path' in value);
}

/** The colour of a `layerSwatchIcon` data URI, or undefined for any other URI. */
export function swatchColour(uri: vscode.Uri): string | undefined {
  // A real `vscode.Uri` percent-encodes `+`, `;` and `,` in toString(); its
  // scheme and decoded path are the data URI as it was parsed.
  const text = uri.scheme === 'data' && typeof uri.path === 'string' ? `data:${uri.path}` : decodeURIComponentSafe(uri.toString());
  const m = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)$/.exec(text);
  if (!m) return undefined;
  let svg: string;
  try {
    svg = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return undefined;
  }
  const fill = /fill="(#[0-9a-fA-F]{3,6})"/.exec(svg)?.[1];
  return fill && HEX_COLOUR.test(fill) ? fill.toLowerCase() : undefined;
}

/**
 * The icon for the webview. `toWebviewUri` converts a file URI (and returns
 * undefined for one outside the webview's resource roots).
 */
export function serialiseIcon(icon: unknown, toWebviewUri: (uri: vscode.Uri) => string | undefined): SerialisedIcon | undefined {
  if (!icon) return undefined;
  if (typeof icon === 'object' && icon !== null && typeof (icon as { id?: unknown }).id === 'string' && !uriLike(icon)) {
    const id = (icon as { id: string }).id;
    const color = (icon as { color?: { id?: unknown } }).color?.id;
    return { kind: 'theme', id, ...(typeof color === 'string' ? { color } : {}) };
  }
  if (uriLike(icon)) {
    const swatch = swatchColour(icon);
    if (swatch) return { kind: 'swatch', color: swatch };
    const url = toWebviewUri(icon);
    return url ? { kind: 'uri', light: url, dark: url } : undefined;
  }
  if (typeof icon === 'object' && icon !== null && 'light' in icon && 'dark' in icon) {
    const { light, dark } = icon as { light: unknown; dark: unknown };
    const l = uriLike(light) ? toWebviewUri(light) : undefined;
    const d = uriLike(dark) ? toWebviewUri(dark) : undefined;
    if (l || d) return { kind: 'uri', light: (l ?? d) as string, dark: (d ?? l) as string };
  }
  return undefined;
}

/** The text of a label (string or TreeItemLabel), with its highlights. */
function labelOf(item: vscode.TreeItem): { label: string; highlights?: Array<[number, number]> } {
  const raw = item.label as unknown;
  if (typeof raw === 'string') return { label: raw };
  if (raw && typeof raw === 'object' && typeof (raw as { label?: unknown }).label === 'string') {
    const label = (raw as { label: string }).label;
    const rawHighlights = (raw as { highlights?: unknown }).highlights;
    // Clamp first, then drop empty ranges (a range past the label's end clamps to nothing).
    const highlights = (Array.isArray(rawHighlights) ? rawHighlights as unknown[] : undefined)
      ?.filter((h): h is [number, number] => Array.isArray(h) && h.length === 2 && Number.isInteger(h[0]) && Number.isInteger(h[1]))
      .map((h) => [Math.max(0, h[0]), Math.min(label.length, h[1])] as [number, number])
      .filter((h) => h[0] < h[1]);
    return { label, ...(highlights && highlights.length > 0 ? { highlights } : {}) };
  }
  const resource = (item as { resourceUri?: vscode.Uri }).resourceUri;
  if (resource) return { label: basename(resource.path ?? resource.fsPath ?? String(resource)) };
  return { label: '' };
}

/**
 * Serialise one TreeItem. `id` is decided by the caller ({@link nodeId});
 * children are attached by the walk.
 */
export function serialiseTreeItem(
  item: vscode.TreeItem,
  id: string,
  toWebviewUri: (uri: vscode.Uri) => string | undefined,
): SerialisedNode {
  const { label, highlights } = labelOf(item);
  const resource = (item as { resourceUri?: vscode.Uri }).resourceUri;
  let description: string | undefined;
  if (typeof item.description === 'string') description = item.description;
  else if (item.description === true && resource) description = resource.fsPath ?? resource.path;
  const state = item.collapsibleState ?? 0;
  const node: SerialisedNode = {
    id,
    label,
    collapsible: state === 1 || state === 2 ? state : 0,
    hasCommand: Boolean(item.command && (item.command as { command?: unknown }).command),
  };
  if (highlights) node.highlights = highlights;
  if (description) node.description = description;
  const tooltip = plainText(item.tooltip);
  if (tooltip) node.tooltip = tooltip;
  if (typeof item.contextValue === 'string' && item.contextValue) node.contextValue = item.contextValue;
  const icon = serialiseIcon(item.iconPath, toWebviewUri);
  if (icon) node.icon = icon;
  if (resource) node.resource = basename(resource.path ?? resource.fsPath ?? String(resource));
  return node;
}

/**
 * A row's id: the TreeItem's own id when it has one (prefixed by the
 * section), else its parent's id and its label, with `#n` for a repeated
 * label under one parent. `seen` counts labels per parent within one walk.
 */
export function nodeId(section: string, parentId: string | undefined, item: vscode.TreeItem, seen: Map<string, number>): string {
  const own = (item as { id?: unknown }).id;
  let base: string;
  if (typeof own === 'string' && own !== '') {
    base = `${section}:${own}`;
  } else {
    const { label } = labelOf(item);
    base = `${parentId ?? section}/${label}`;
  }
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}#${n}`;
}
