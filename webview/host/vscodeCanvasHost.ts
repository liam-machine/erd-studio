/**
 * The canvas host for the VS Code webview: edits made on the shared canvas
 * components (`@erd-studio/renderer`) are posted straight to the extension
 * host, exactly as the components did before they moved into the package.
 */

import type { CanvasHost } from '@erd-studio/renderer/editor';
import { getVsCodeApi } from '../hooks/useVsCodeApi';

export const vscodeCanvasHost: CanvasHost = {
  postMessage: (m) => getVsCodeApi().postMessage(m),
};
