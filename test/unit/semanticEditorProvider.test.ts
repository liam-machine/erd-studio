import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { CancellationTokenSource, createMockWebviewPanel, createMockTextDocument } from 'vscode';

import { DomainService } from '../../src/services/domainService';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const FIXTURE_DOMAIN_PATH = path.resolve(
  FIXTURES_DIR,
  'dbt-project/models/semantic/silver/work-lots.json',
);

/** Minimal mock of ExtensionContext — only the fields used by the provider. */
function createMockContext(): any {
  return {
    extensionUri: { path: '/mock-extension', fsPath: '/mock-extension', scheme: 'file' },
    subscriptions: [],
  };
}

describe('SemanticEditorProvider', () => {
  let domainService: DomainService;
  let provider: SemanticEditorProvider;
  let context: any;

  beforeEach(() => {
    context = createMockContext();
    domainService = new DomainService();
    provider = new SemanticEditorProvider(context, domainService);
  });

  describe('resolveCustomTextEditor', () => {
    it('sets webview HTML with CSP and script tag', async () => {
      const panel = createMockWebviewPanel();
      const document = createMockTextDocument(FIXTURE_DOMAIN_PATH);
      const tokenSource = new CancellationTokenSource();

      await provider.resolveCustomTextEditor(document as any, panel as any, tokenSource.token as any);

      expect(panel.webview.html).toContain('Content-Security-Policy');
      expect(panel.webview.html).toContain('nonce-');
      expect(panel.webview.html).toContain('webview.js');
      expect(panel.webview.html).toContain('<div id="root"></div>');
    });

    it('enables scripts in webview options', async () => {
      const panel = createMockWebviewPanel();
      const document = createMockTextDocument(FIXTURE_DOMAIN_PATH);
      const tokenSource = new CancellationTokenSource();

      await provider.resolveCustomTextEditor(document as any, panel as any, tokenSource.token as any);

      expect(panel.webview.options).toEqual(
        expect.objectContaining({ enableScripts: true }),
      );
    });

    it('sends domainLoaded on ready message', async () => {
      const panel = createMockWebviewPanel();
      const document = createMockTextDocument(FIXTURE_DOMAIN_PATH);
      const tokenSource = new CancellationTokenSource();

      await provider.resolveCustomTextEditor(document as any, panel as any, tokenSource.token as any);

      // Simulate webview sending "ready"
      panel._simulateMessage({ type: 'ready' });

      const loadedMessage = panel._postedMessages.find(
        (m: any) => m.type === 'domainLoaded',
      ) as any;

      expect(loadedMessage).toBeDefined();
      expect(loadedMessage.payload.domain).toBe('work-lots');
      expect(loadedMessage.payload.layer).toBe('silver');
      expect(loadedMessage.payload.models).toHaveLength(2);
    });

    it('sends error when domain file is invalid', async () => {
      const panel = createMockWebviewPanel();
      const document = createMockTextDocument('/nonexistent/path.json');
      const tokenSource = new CancellationTokenSource();

      await provider.resolveCustomTextEditor(document as any, panel as any, tokenSource.token as any);

      panel._simulateMessage({ type: 'ready' });

      const errorMessage = panel._postedMessages.find(
        (m: any) => m.type === 'error',
      ) as any;

      expect(errorMessage).toBeDefined();
      expect(errorMessage.payload.message).toBeTruthy();
    });

    it('responds to a second ready message (simulating webview re-mount)', async () => {
      const panel = createMockWebviewPanel();
      const document = createMockTextDocument(FIXTURE_DOMAIN_PATH);
      const tokenSource = new CancellationTokenSource();

      await provider.resolveCustomTextEditor(document as any, panel as any, tokenSource.token as any);

      // First ready → first domainLoaded
      panel._simulateMessage({ type: 'ready' });
      expect(panel._postedMessages).toHaveLength(1);

      // Second ready (simulating webview re-mount after tab switch)
      panel._simulateMessage({ type: 'ready' });
      expect(panel._postedMessages).toHaveLength(2);

      const messages = panel._postedMessages.filter(
        (m: any) => m.type === 'domainLoaded',
      );
      expect(messages).toHaveLength(2);
    });

    it('ignores non-ready messages', async () => {
      const panel = createMockWebviewPanel();
      const document = createMockTextDocument(FIXTURE_DOMAIN_PATH);
      const tokenSource = new CancellationTokenSource();

      await provider.resolveCustomTextEditor(document as any, panel as any, tokenSource.token as any);

      // Simulate an unknown message type
      panel._simulateMessage({ type: 'someOtherMessage' });

      // No domainLoaded should be sent
      expect(panel._postedMessages).toHaveLength(0);
    });
  });
});
