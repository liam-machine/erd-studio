import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';

import { layerSwatchIcon } from '../../src/providers/layerSwatch';

describe('layerSwatchIcon', () => {
  it("draws the layer icon in the layer's own colour, and nothing else", () => {
    const svg = Buffer.from(layerSwatchIcon('#D4A800').toString().split(',')[1], 'base64').toString();
    expect(new Set(svg.match(/#[0-9a-f]{3,6}\b/gi))).toEqual(new Set(['#d4a800']));
  });

  it('caches by colour, ignoring case', () => {
    expect(layerSwatchIcon('#8b5cf6')).toBe(layerSwatchIcon('#8B5CF6'));
  });

  it('falls back to the layers codicon without a hex colour', () => {
    expect((layerSwatchIcon(undefined) as vscode.ThemeIcon).id).toBe('layers');
    expect((layerSwatchIcon('gold') as vscode.ThemeIcon).id).toBe('layers');
  });
});
