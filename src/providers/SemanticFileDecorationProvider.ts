import * as vscode from 'vscode';

import type { LayerService } from '../services/layerService';

/**
 * Provides file decorations (color) for semantic domain JSON files
 * in the Explorer tree view. Uses the layer color from layers.json
 * so each layer's files are visually distinct.
 */
export class SemanticFileDecorationProvider implements vscode.FileDecorationProvider {
  private static readonly SEMANTIC_PATH_PATTERN = /[/\\]erd-studio[/\\]/;

  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  constructor(
    private readonly layerService: LayerService,
    private readonly semanticDir: string = 'erd-studio',
  ) {}

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const fsPath = uri.fsPath;

    // --- Layer folder decoration ---
    // Pattern: .../<semanticDir>/<layerId>
    const layerFromFolder = this.extractDirectLayerId(fsPath);
    if (layerFromFolder) {
      const config = this.layerService.getLayer(layerFromFolder);
      if (config) {
        return {
          tooltip: `${config.label} layer`,
          color: this.hexToThemeColor(config.color),
        };
      }
    }

    // --- Domain file decoration ---
    // Only decorate .json files inside a known layer directory
    if (!fsPath.endsWith('.json')) {
      return undefined;
    }

    if (!SemanticFileDecorationProvider.SEMANTIC_PATH_PATTERN.test(fsPath)) {
      return undefined;
    }

    const layerId = this.extractLayerId(fsPath);
    const layerConfig = layerId ? this.layerService.getLayer(layerId) : undefined;

    if (!layerConfig) {
      return undefined;
    }

    return {
      tooltip: `${layerConfig.label} domain (opens in visual editor)`,
      color: this.hexToThemeColor(layerConfig.color),
    };
  }

  /**
   * Check if this path is a direct child folder of the semantic directory.
   * Returns the folder name if it matches .../<semanticDir>/<folderName>, else null.
   */
  private extractDirectLayerId(fsPath: string): string | null {
    const normalised = fsPath.replace(/\\/g, '/');
    const marker = `/${this.semanticDir}/`;
    const idx = normalised.lastIndexOf(marker);
    if (idx === -1) return null;

    // Everything after the semantic dir should be just the folder name (no further slashes)
    const rest = normalised.substring(idx + marker.length);
    if (rest.includes('/') || rest.includes('.')) return null;
    if (!rest) return null;

    return rest;
  }

  /**
   * Extract the layer ID from a domain file path.
   * Expects: .../<semanticDir>/<layerId>/<domain>.json
   */
  private extractLayerId(fsPath: string): string | null {
    // Normalise separators to forward slash for matching
    const normalised = fsPath.replace(/\\/g, '/');
    const marker = `/${this.semanticDir}/`;
    const idx = normalised.lastIndexOf(marker);
    if (idx === -1) return null;

    // Everything after the semantic dir
    const rest = normalised.substring(idx + marker.length);
    const parts = rest.split('/');

    // We expect ["<layer>", "<domain>.json"]
    if (parts.length < 2) return null;
    return parts[0];
  }

  /**
   * Map a hex color to the closest VS Code ThemeColor.
   * VS Code doesn't support arbitrary hex in FileDecoration,
   * so we map to chart colors by hue.
   */
  private hexToThemeColor(hex: string): vscode.ThemeColor {
    const color = hex.toLowerCase();

    // Grey/silver tones (low saturation) — check first since hue is undefined
    if (this.isLowSaturation(color)) {
      return new vscode.ThemeColor('descriptionForeground');
    }

    const hue = this.getHue(color);

    if (hue >= 0 && hue < 20) return new vscode.ThemeColor('charts.red');
    if (hue >= 20 && hue < 40) return new vscode.ThemeColor('charts.orange');
    if (hue >= 40 && hue < 80) return new vscode.ThemeColor('charts.yellow');
    if (hue >= 80 && hue < 180) return new vscode.ThemeColor('charts.green');
    if (hue >= 180 && hue < 260) return new vscode.ThemeColor('charts.blue');
    if (hue >= 260 && hue < 360) return new vscode.ThemeColor('charts.purple');

    return new vscode.ThemeColor('charts.foreground');
  }

  private isLowSaturation(hex: string): boolean {
    const rgb = this.hexToRgb(hex);
    if (!rgb) return false;
    return Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b) < 30;
  }

  private getHue(hex: string): number {
    const rgb = this.hexToRgb(hex);
    if (!rgb) return 0;

    const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    if (delta === 0) return 0;

    let hue: number;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;

    hue = Math.round(hue * 60);
    if (hue < 0) hue += 360;
    return hue;
  }

  private hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
      : null;
  }

  /** Fire event to refresh decorations (e.g. after layer color changes). */
  refresh(): void {
    this._onDidChangeFileDecorations.fire(undefined);
  }

  dispose(): void {
    this._onDidChangeFileDecorations.dispose();
  }
}
