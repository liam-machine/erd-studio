// @vitest-environment jsdom
/**
 * The webview's CanvasHost forwards every canvas edit, unchanged, to the
 * VS Code API acquired once at load — the channel the canvas components
 * posted on directly before they moved into @erd-studio/renderer.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

const postMessage = vi.fn();
const acquireVsCodeApi = vi.fn(() => ({ postMessage, getState: vi.fn(), setState: vi.fn() }));

beforeAll(() => {
  (window as unknown as { acquireVsCodeApi: typeof acquireVsCodeApi }).acquireVsCodeApi = acquireVsCodeApi;
});

describe('vscodeCanvasHost', () => {
  it('posts canvas edits through acquireVsCodeApi().postMessage', async () => {
    const { vscodeCanvasHost } = await import('../../webview/host/vscodeCanvasHost');
    const message = { type: 'removeAnnotation', payload: { id: 'note-1' } } as const;
    vscodeCanvasHost.postMessage(message);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(message);
    expect(postMessage.mock.calls[0][0]).toBe(message);
  });

  it('shares the one VS Code API instance with useVsCodeApi', async () => {
    const { useVsCodeApi, getVsCodeApi } = await import('../../webview/hooks/useVsCodeApi');
    expect(getVsCodeApi()).toBe(useVsCodeApi());
    expect(acquireVsCodeApi).toHaveBeenCalledTimes(1);
  });
});
