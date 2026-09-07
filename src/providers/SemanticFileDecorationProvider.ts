import * as vscode from 'vscode';

import type { LayerService } from '../services/layerService';

/**
 * Provides file decorations (tooltips only) for semantic domain JSON files
 * in the Explorer tree view. Colours are intentionally omitted so the
 * Explorer keeps its default appearance — layer colours are only applied
 * inside the ERD Studio sidebar tree via LayerDecorationProvider.
 */
export class SemanticFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  /** Configured semantic dir, normalised to forward slashes with no leading `./` or trailing `/`. */
  private readonly semanticDir: string;

  constructor(
    private readonly layerService: LayerService,
    semanticDir: string = '.erd-studio',
  ) {
    this.semanticDir = semanticDir
      .replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/\/+$/, '') || '.erd-studio';
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const fsPath = uri.fsPath;

    // --- Layer folder decoration ---
    // Pattern: .../<semanticDir>/<layerId>
    const layerFromFolder = this.extractDirectLayerId(fsPath);
    if (layerFromFolder) {
      const config = this.layerService.getLayer(layerFromFolder);
      if (config) {
        return { tooltip: `${config.label} layer` };
      }
    }

    // --- Domain file decoration ---
    // Only decorate .json files inside a known layer directory of the
    // configured semantic dir (extractLayerId returns null otherwise).
    if (!fsPath.endsWith('.json')) {
      return undefined;
    }

    const layerId = this.extractLayerId(fsPath);
    const layerConfig = layerId ? this.layerService.getLayer(layerId) : undefined;

    if (!layerConfig) {
      return undefined;
    }

    return { tooltip: `${layerConfig.label} domain (opens in visual editor)` };
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

  /** Fire event to refresh decorations (e.g. after layer label changes update tooltips). */
  refresh(): void {
    this._onDidChangeFileDecorations.fire(undefined);
  }

  dispose(): void {
    this._onDidChangeFileDecorations.dispose();
  }
}
