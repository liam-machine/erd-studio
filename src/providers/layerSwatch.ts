/**
 * A layer's icon in the sidebar trees: a stack of sheets drawn in the layer's
 * own colour from layers.json, the same in Diagrams, the Table Library and
 * Relationships. Colour means one thing in the sidebar: the layer.
 *
 * Tree labels can only be coloured with theme colour ids, which forced every
 * layers.json colour onto the nearest chart colour (purple came out blue, and
 * bronze a dark red that was hard to read). An SVG icon carries the exact
 * colour in every theme, and the label keeps the theme's text colour.
 */
import * as vscode from 'vscode';

const HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const swatches = new Map<string, vscode.Uri>();

/** The layer icon in `color`, or the `layers` codicon when the colour is not a `#rgb` / `#rrggbb` hex. */
export function layerSwatchIcon(color: string | undefined): vscode.Uri | vscode.ThemeIcon {
  if (!color || !HEX_COLOUR.test(color)) return new vscode.ThemeIcon('layers');
  const key = color.toLowerCase();
  let uri = swatches.get(key);
  if (!uri) {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
      `<path d="M8 1.5 14.5 5 8 8.5 1.5 5Z" fill="${key}"/>` +
      `<path d="M3.4 7.6 1.5 8.6 8 12.1 14.5 8.6 12.6 7.6 8 10.1Z" fill="${key}" fill-opacity=".55"/>` +
      `<path d="M3.4 11 1.5 12 8 15.5 14.5 12 12.6 11 8 13.5Z" fill="${key}" fill-opacity=".3"/>` +
      '</svg>';
    uri = vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
    swatches.set(key, uri);
  }
  return uri;
}
