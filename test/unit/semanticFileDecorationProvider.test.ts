import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';

import { SemanticFileDecorationProvider } from '../../src/providers/SemanticFileDecorationProvider';
import type { LayerService } from '../../src/services/layerService';

function fakeLayerService(): LayerService {
  return {
    getLayer: (id: string) =>
      id === 'silver' ? { id: 'silver', label: 'Silver', color: '#ccc' } : undefined,
  } as unknown as LayerService;
}

const uri = (p: string) => vscode.Uri.file(p) as unknown as vscode.Uri;

describe('SemanticFileDecorationProvider (H30 semanticDir)', () => {
  it('decorates domain files under the default .erd-studio directory', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService());
    const deco = provider.provideFileDecoration(uri('/proj/.erd-studio/silver/customer.json'));
    expect(deco?.tooltip).toBe('Silver domain (opens in visual editor)');
  });

  it('decorates domain files under a custom semanticDir', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService(), '.erd');
    const deco = provider.provideFileDecoration(uri('/proj/.erd/silver/customer.json'));
    expect(deco?.tooltip).toBe('Silver domain (opens in visual editor)');

    const folder = provider.provideFileDecoration(uri('/proj/.erd/silver'));
    expect(folder?.tooltip).toBe('Silver layer');
  });

  it('supports a nested semanticDir and tolerates ./ and trailing slashes', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService(), './docs/erd/');
    const deco = provider.provideFileDecoration(uri('/proj/docs/erd/silver/customer.json'));
    expect(deco?.tooltip).toBe('Silver domain (opens in visual editor)');
  });

  it('does not decorate the default directory when a custom semanticDir is configured', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService(), '.erd');
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/silver/customer.json'))).toBeUndefined();
  });

  it('ignores files outside the semantic dir and unknown layers', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService());
    expect(provider.provideFileDecoration(uri('/proj/models/silver/customer.json'))).toBeUndefined();
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/unknown/customer.json'))).toBeUndefined();
    expect(provider.provideFileDecoration(uri('/proj/.erd-studio/silver/customer.yml'))).toBeUndefined();
  });
});
