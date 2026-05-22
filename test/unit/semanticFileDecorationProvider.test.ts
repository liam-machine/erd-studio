import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { SemanticFileDecorationProvider } from '../../src/providers/SemanticFileDecorationProvider';
import type { LayerService } from '../../src/services/layerService';

// Minimal stand-in — the provider only calls getLayer().
const fakeLayerService = {
  getLayer: (id: string) =>
    id === 'silver'
      ? { id: 'silver', label: 'Silver', abbreviation: 'SIL', color: '#ccc', creatable: true }
      : undefined,
} as unknown as LayerService;

describe('SemanticFileDecorationProvider', () => {
  it('decorates domain files inside a dot-prefixed data directory', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService, '.erd-studio');
    const uri = vscode.Uri.file('/ws/.erd-studio/silver/orders.json');
    expect(provider.provideFileDecoration(uri)?.tooltip).toBe(
      'Silver domain (opens in visual editor)',
    );
  });

  it('still decorates domain files inside the legacy erd-studio directory', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService, 'erd-studio');
    const uri = vscode.Uri.file('/ws/erd-studio/silver/orders.json');
    expect(provider.provideFileDecoration(uri)?.tooltip).toBe(
      'Silver domain (opens in visual editor)',
    );
  });
});
