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
 *
 * Why the timeout: `html-to-image` resolves its rasterised image inside a
 * `requestAnimationFrame` callback, and the browser stops firing those while
 * the document is hidden. If the user switches VS Code tabs (or the window is
 * minimised) between pressing the button and the capture finishing, the
 * promise never settles. `withTimeout` turns that into a normal "no
 * screenshot" result so the bug report still gets filed.
 */

import { toBlob } from 'html-to-image';

/** Refuse to ship absurdly large PNGs through postMessage. */
const MAX_PNG_BYTES = 12 * 1024 * 1024;

/** How long to wait for the rasteriser before giving up on the screenshot. */
export const CAPTURE_TIMEOUT_MS = 15_000;

/** Sentinel resolved by `withTimeout` when `promise` takes too long. */
const TIMED_OUT = Symbol('capture-timeout');

/**
 * Resolve `promise`, or the `TIMED_OUT` sentinel once `ms` have elapsed.
 * The timer is always cleared so a slow-but-successful capture does not keep
 * the webview awake.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
    const raster = toBlob(root, {
      filter: (node) =>
        !(excludeSelector && node instanceof Element && node.matches(excludeSelector)),
      backgroundColor: background,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      skipFonts: true,
      cacheBust: false,
    });
    const settled = await withTimeout(raster, CAPTURE_TIMEOUT_MS);
    if (settled === TIMED_OUT) {
      return {
        dataUrl: null,
        onClipboard: false,
        error:
          'Screenshot timed out. This usually means the editor tab was hidden mid-capture — ' +
          'keep the canvas visible and try again, or attach an image on GitHub.',
      };
    }
    blob = settled;
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
