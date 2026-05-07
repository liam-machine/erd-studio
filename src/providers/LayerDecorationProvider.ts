import * as vscode from 'vscode';

import type { LayerService } from '../services/layerService';

/**
 * URI scheme for layer tree items.
 * Used to identify layer nodes in the FileDecorationProvider.
 */
export const LAYER_URI_SCHEME = 'dbt-semantic-layer';

/**
 * Provides file decorations (color) for layer folders in the sidebar tree.
 * Uses the actual layer color from the user's layers.json configuration.
 */
export class LayerDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  constructor(private readonly layerService: LayerService) {}

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    // Only handle our custom layer URI scheme
    if (uri.scheme !== LAYER_URI_SCHEME) {
      return undefined;
    }

    // Extract layer ID from URI path (e.g., "/silver" -> "silver")
    const layerId = uri.path.replace(/^\//, '');
    const layerConfig = this.layerService.getLayer(layerId);

    if (!layerConfig) {
      return undefined;
    }

    // Return decoration with the layer's configured color
    return {
      color: this.hexToThemeColor(layerConfig.color),
      tooltip: `${layerConfig.label} layer`,
    };
  }

  /**
   * Convert a hex color to a VS Code ThemeColor.
   * Uses workbench colors that can be overridden, with fallback to chart colors.
   */
  private hexToThemeColor(hex: string): vscode.ThemeColor {
    // Map common layer colors to appropriate theme colors
    // VS Code doesn't allow arbitrary hex colors in ThemeColor,
    // so we map to the closest chart color based on hue
    const color = hex.toLowerCase();

    // Grey/silver tones (low saturation) - check FIRST before hue ranges
    // Grey colors have undefined hue, so hue-based checks give wrong results
    if (this.isLowSaturation(color)) {
      return new vscode.ThemeColor('descriptionForeground');
    }

    // Bronze/copper tones
    if (color === '#cd7f32' || this.isInHueRange(color, 20, 40)) {
      return new vscode.ThemeColor('charts.orange');
    }

    // Gold/yellow tones
    if (color === '#d4a800' || this.isInHueRange(color, 40, 65)) {
      return new vscode.ThemeColor('charts.yellow');
    }

    // Green tones
    if (this.isInHueRange(color, 80, 160)) {
      return new vscode.ThemeColor('charts.green');
    }

    // Blue tones
    if (this.isInHueRange(color, 180, 260)) {
      return new vscode.ThemeColor('charts.blue');
    }

    // Purple tones
    if (this.isInHueRange(color, 260, 320)) {
      return new vscode.ThemeColor('charts.purple');
    }

    // Pink tones (high hue, near red but distinct)
    if (this.isInHueRange(color, 320, 360)) {
      return new vscode.ThemeColor('charts.purple');
    }

    // Red tones
    if (this.isInHueRange(color, 0, 20)) {
      return new vscode.ThemeColor('charts.red');
    }

    // Default fallback
    return new vscode.ThemeColor('charts.foreground');
  }

  /**
   * Check if a hex color's hue falls within a range.
   */
  private isInHueRange(hex: string, minHue: number, maxHue: number): boolean {
    const hue = this.getHue(hex);
    return hue >= minHue && hue < maxHue;
  }

  /**
   * Check if a hex color has low saturation (grey-ish).
   */
  private isLowSaturation(hex: string): boolean {
    const rgb = this.hexToRgb(hex);
    if (!rgb) return false;

    const max = Math.max(rgb.r, rgb.g, rgb.b);
    const min = Math.min(rgb.r, rgb.g, rgb.b);
    const delta = max - min;

    // Low saturation if difference between max and min is small
    return delta < 30;
  }

  /**
   * Get the hue (0-360) from a hex color.
   */
  private getHue(hex: string): number {
    const rgb = this.hexToRgb(hex);
    if (!rgb) return 0;

    const r = rgb.r / 255;
    const g = rgb.g / 255;
    const b = rgb.b / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    if (delta === 0) return 0;

    let hue: number;
    if (max === r) {
      hue = ((g - b) / delta) % 6;
    } else if (max === g) {
      hue = (b - r) / delta + 2;
    } else {
      hue = (r - g) / delta + 4;
    }

    hue = Math.round(hue * 60);
    if (hue < 0) hue += 360;

    return hue;
  }

  /**
   * Convert hex color to RGB.
   */
  private hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16),
        }
      : null;
  }

  /**
   * Fire event to refresh layer decorations.
   * Call this after layer colors change.
   */
  refresh(): void {
    this._onDidChangeFileDecorations.fire(undefined);
  }

  dispose(): void {
    this._onDidChangeFileDecorations.dispose();
  }
}
