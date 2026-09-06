/**
 * Canvas screenshot capture for bug reports.
 *
 * Uses `html-to-image` to rasterise the webview DOM (React Flow canvas,
 * toolbar, panels) into a PNG, then tries to put it on the system clipboard
 * so the user can paste it straight into the GitHub issue. The PNG is also
 * returned as a data URL so the extension host can save a fallback copy.
 *
 * Why not fetch fonts/stylesheets: the webview CSP blocks most network
 * access, and VS Code uses system fonts, so `skipFonts` keeps capture
 * reliable without embedding @font-face rules.
 */

import { toBlob } from 'html-to-image';

/** Refuse to ship absurdly large PNGs through postMessage. */
const MAX_PNG_BYTES = 12 * 1024 * 1024;

export interface ScreenshotResult {
  /** `data:image/png;base64,...` or null when capture failed. */
  dataUrl: string | null;
  /** True when the PNG was written to the system clipboard. */
  onClipboard: boolean;
  /** Human-readable failure reason, if any step failed. */
  error?: string;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

/** Attempt to copy a PNG blob to the clipboard. Never throws. */
export async function copyPngToClipboard(blob: Blob): Promise<boolean> {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture `root` as a PNG.
 *
 * @param root — element to rasterise (normally the `#root` app container).
 * @param excludeSelector — CSS selector for nodes to leave out (e.g. the
 *   bug-report dialog itself, so the screenshot shows the canvas beneath it).
 */
export async function captureScreenshot(
  root: HTMLElement,
  excludeSelector?: string,
): Promise<ScreenshotResult> {
  let blob: Blob | null;
  try {
    const background =
      getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim() ||
      getComputedStyle(document.body).backgroundColor ||
      '#1e1e1e';
    blob = await toBlob(root, {
      filter: (node) =>
        !(excludeSelector && node instanceof Element && node.matches(excludeSelector)),
      backgroundColor: background,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      skipFonts: true,
      cacheBust: false,
    });
  } catch (err) {
    return { dataUrl: null, onClipboard: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!blob) {
    return { dataUrl: null, onClipboard: false, error: 'Renderer returned no image' };
  }
  if (blob.size > MAX_PNG_BYTES) {
    return { dataUrl: null, onClipboard: false, error: `Screenshot too large (${Math.round(blob.size / 1024 / 1024)} MB)` };
  }

  const onClipboard = await copyPngToClipboard(blob);
  try {
    const dataUrl = await blobToDataUrl(blob);
    return { dataUrl, onClipboard };
  } catch (err) {
    return { dataUrl: null, onClipboard, error: err instanceof Error ? err.message : String(err) };
  }
}
