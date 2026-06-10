/**
 * LayerService — manages layer configuration for the semantic domain system.
 *
 * Responsibilities:
 *   1. Load layer config from .erd-studio/layers.json
 *   2. Auto-detect existing layer directories on first run
 *   3. Validate layer configuration structure
 *   4. Provide layer lookup and metadata access
 *   5. Support layer CRUD operations (create, rename, delete, reorder)
 *
 * Similar to TemplateService pattern: loads from JSON with fallback to defaults.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { LayerConfig, LayersConfigFile } from '../types/layer';
import {
  AUTO_DETECT_COLORS,
  DEFAULT_LAYERS,
  KNOWN_LAYER_DEFAULTS,
  LAYERS_SCHEMA_VERSION,
} from '../types/layer';

const LAYERS_CONFIG_FILE = 'layers.json';

/** Reserved stage names that must never be detected as user-defined layers. */
const STAGE_DIR_NAMES = new Set(['logical', 'physical']);

export class LayerService {
  private config: LayersConfigFile | null = null;
  private readonly configPath: string;
  private readonly semanticPath: string;

  constructor(projectPath: string, semanticDir: string = '.erd-studio') {
    this.semanticPath = path.join(projectPath, semanticDir);
    this.configPath = path.join(this.semanticPath, LAYERS_CONFIG_FILE);
  }

  /**
   * Check if layers.json configuration file exists.
   */
  configFileExists(): boolean {
    return fs.existsSync(this.configPath);
  }

  /**
   * Get the path to the layers.json config file.
   */
  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * Load layer configurations.
   *
   * Returns layers from layers.json if it exists, otherwise returns
   * default layers (silver, gold).
   *
   * Results are cached in memory for performance.
   */
  loadConfig(): LayerConfig[] {
    if (this.config) {
      return this.config.layers;
    }

    if (fs.existsSync(this.configPath)) {
      this.config = this.loadFromFile();
    } else {
      // Use defaults
      this.config = {
        schemaVersion: LAYERS_SCHEMA_VERSION,
        layers: [...DEFAULT_LAYERS],
      };
    }

    return this.config.layers;
  }

  /**
   * Load and validate layers.json configuration file.
   */
  private loadFromFile(): LayersConfigFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.configPath, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[LayerService] Failed to read layers config: ${message}`);
      return { schemaVersion: LAYERS_SCHEMA_VERSION, layers: [...DEFAULT_LAYERS] };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[LayerService] Invalid JSON in layers config: ${message}`);
      return { schemaVersion: LAYERS_SCHEMA_VERSION, layers: [...DEFAULT_LAYERS] };
    }

    return this.validateConfig(parsed);
  }

  /**
   * Validate parsed layers.json structure.
   * Returns valid config or falls back to defaults on error.
   */
  private validateConfig(data: unknown): LayersConfigFile {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      console.error('[LayerService] Layers config must be a JSON object');
      return { schemaVersion: LAYERS_SCHEMA_VERSION, layers: [...DEFAULT_LAYERS] };
    }

    const obj = data as Record<string, unknown>;

    // Schema version check
    if (typeof obj.schemaVersion !== 'number') {
      console.error('[LayerService] Layers config missing schemaVersion field');
      return { schemaVersion: LAYERS_SCHEMA_VERSION, layers: [...DEFAULT_LAYERS] };
    }

    if (obj.schemaVersion > LAYERS_SCHEMA_VERSION) {
      console.error(
        `[LayerService] Layers config has schemaVersion ${obj.schemaVersion} ` +
        `but this extension only supports up to version ${LAYERS_SCHEMA_VERSION}`,
      );
      return { schemaVersion: LAYERS_SCHEMA_VERSION, layers: [...DEFAULT_LAYERS] };
    }

    // Validate layers array
    if (!Array.isArray(obj.layers)) {
      console.error('[LayerService] Layers config must have a "layers" array');
      return { schemaVersion: LAYERS_SCHEMA_VERSION, layers: [...DEFAULT_LAYERS] };
    }

    const layers: LayerConfig[] = [];
    const seenIds = new Set<string>();

    for (const [index, item] of obj.layers.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        console.warn(`[LayerService] Layer at index ${index} must be an object, skipping`);
        continue;
      }

      const layer = item as Record<string, unknown>;

      // Validate required fields
      if (typeof layer.id !== 'string' || !layer.id.trim()) {
        console.warn(`[LayerService] Layer at index ${index} missing valid id, skipping`);
        continue;
      }

      const id = layer.id.trim();

      // Check for duplicate IDs
      if (seenIds.has(id)) {
        console.warn(`[LayerService] Duplicate layer ID "${id}" at index ${index}, skipping`);
        continue;
      }
      seenIds.add(id);

      // Validate ID format (lowercase alphanumeric + hyphens/underscores)
      if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
        console.warn(`[LayerService] Layer ID "${id}" has invalid format, skipping`);
        continue;
      }

      if (typeof layer.label !== 'string' || !layer.label.trim()) {
        console.warn(`[LayerService] Layer "${id}" missing valid label, using id as label`);
      }

      // Validate color (basic hex format check)
      let color = '#808080'; // default grey
      if (typeof layer.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(layer.color)) {
        color = layer.color;
      } else {
        console.warn(`[LayerService] Layer "${id}" has invalid color, using default`);
      }

      layers.push({
        id,
        label: typeof layer.label === 'string' ? layer.label.trim() : this.capitalize(id),
        abbreviation: typeof layer.abbreviation === 'string'
          ? layer.abbreviation.trim()
          : id.substring(0, 3).toUpperCase(),
        color,
        creatable: layer.creatable === true,
        order: typeof layer.order === 'number' ? layer.order : index,
      });
    }

    // Ensure at least one layer exists
    if (layers.length === 0) {
      console.error('[LayerService] No valid layers found, using defaults');
      return { schemaVersion: LAYERS_SCHEMA_VERSION, layers: [...DEFAULT_LAYERS] };
    }

    // Sort by order
    layers.sort((a, b) => a.order - b.order);

    return { schemaVersion: obj.schemaVersion, layers };
  }

  /**
   * Auto-detect layer directories in the semantic directory.
   * Returns layer configs based on found subdirectories.
   */
  detectLayersFromFilesystem(): LayerConfig[] {
    if (!fs.existsSync(this.semanticPath)) {
      return [];
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.semanticPath, { withFileTypes: true });
    } catch (err) {
      console.warn(
        `[LayerService] Unable to read directory ${this.semanticPath}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }

    // Filter for directories only, exclude hidden and special directories
    const layerDirs = entries
      .filter(entry =>
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        entry.name !== 'templates' &&
        !STAGE_DIR_NAMES.has(entry.name),
      )
      .map(entry => entry.name)
      .filter(name => /^[a-z][a-z0-9_-]*$/.test(name)); // Valid layer ID format

    if (layerDirs.length === 0) {
      return [];
    }

    const layers: LayerConfig[] = [];
    let customColorIndex = 0;

    for (const [index, dirName] of layerDirs.entries()) {
      const known = KNOWN_LAYER_DEFAULTS[dirName];

      if (known) {
        // Use known defaults for recognized layers
        layers.push({
          id: dirName,
          label: known.label,
          abbreviation: known.abbreviation,
          color: known.color,
          creatable: known.creatable,
          order: index,
        });
      } else {
        // Create config for unknown layer
        layers.push({
          id: dirName,
          label: this.capitalize(dirName),
          abbreviation: dirName.substring(0, 3).toUpperCase(),
          color: AUTO_DETECT_COLORS[customColorIndex % AUTO_DETECT_COLORS.length],
          creatable: true,
          order: index,
        });
        customColorIndex++;
      }
    }

    return layers;
  }

  /**
   * Capitalize first letter of a string.
   */
  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Get all layers sorted by order.
   */
  getAllLayers(): LayerConfig[] {
    return this.loadConfig();
  }

  /**
   * Get a specific layer by ID.
   */
  getLayer(id: string): LayerConfig | undefined {
    const layers = this.loadConfig();
    return layers.find(l => l.id === id);
  }

  /**
   * Check if a layer ID exists.
   */
  hasLayer(id: string): boolean {
    return this.getLayer(id) !== undefined;
  }

  /**
   * Get all valid layer IDs (for validation).
   */
  getValidLayerIds(): string[] {
    return this.loadConfig().map(l => l.id);
  }

  /**
   * Get layers where creatable is true.
   */
  getCreatableLayers(): LayerConfig[] {
    return this.loadConfig().filter(l => l.creatable);
  }

  /**
   * Get layer label (display name).
   */
  getLabel(id: string): string {
    const layer = this.getLayer(id);
    return layer?.label ?? this.capitalize(id);
  }

  /**
   * Get layer abbreviation.
   */
  getAbbreviation(id: string): string {
    const layer = this.getLayer(id);
    return layer?.abbreviation ?? id.substring(0, 3).toUpperCase();
  }

  /**
   * Get layer color.
   */
  getColor(id: string): string {
    const layer = this.getLayer(id);
    return layer?.color ?? '#808080';
  }

  /**
   * Check if layer is creatable.
   */
  isCreatable(id: string): boolean {
    const layer = this.getLayer(id);
    return layer?.creatable ?? false;
  }

  /**
   * Save layer configurations to layers.json.
   */
  async saveConfig(layers: LayerConfig[]): Promise<void> {
    // Ensure semantic directory exists
    if (!fs.existsSync(this.semanticPath)) {
      fs.mkdirSync(this.semanticPath, { recursive: true });
    }

    const config: LayersConfigFile = {
      schemaVersion: LAYERS_SCHEMA_VERSION,
      layers: layers.map((l, index) => ({
        id: l.id,
        label: l.label,
        abbreviation: l.abbreviation,
        color: l.color,
        creatable: l.creatable,
        order: l.order ?? index,
      })),
    };

    fs.writeFileSync(
      this.configPath,
      JSON.stringify(config, null, 2) + '\n',
      'utf-8',
    );

    // Update cache
    this.config = config;
  }

  /**
   * Add a new layer.
   */
  async addLayer(layer: Omit<LayerConfig, 'order'>): Promise<void> {
    const layers = this.loadConfig();

    // Check for duplicate ID
    if (layers.some(l => l.id === layer.id)) {
      throw new Error(`Layer with ID "${layer.id}" already exists`);
    }

    // Assign order as last
    const maxOrder = layers.reduce((max, l) => Math.max(max, l.order), 0);
    layers.push({ ...layer, order: maxOrder + 1 });

    await this.saveConfig(layers);
  }

  /**
   * Remove a layer by ID.
   * Does not check for existing domains - caller should validate first.
   */
  async removeLayer(layerId: string): Promise<void> {
    const layers = this.loadConfig();
    const index = layers.findIndex(l => l.id === layerId);

    if (index === -1) {
      throw new Error(`Layer "${layerId}" not found`);
    }

    layers.splice(index, 1);
    await this.saveConfig(layers);
  }

  /**
   * Rename a layer (update ID and optionally label).
   */
  async renameLayer(oldId: string, newId: string, newLabel?: string): Promise<void> {
    const layers = this.loadConfig();
    const layer = layers.find(l => l.id === oldId);

    if (!layer) {
      throw new Error(`Layer "${oldId}" not found`);
    }

    // Check new ID doesn't conflict
    if (oldId !== newId && layers.some(l => l.id === newId)) {
      throw new Error(`Layer with ID "${newId}" already exists`);
    }

    // Validate new ID format
    if (!/^[a-z][a-z0-9_-]*$/.test(newId)) {
      throw new Error(
        'Layer ID must start with lowercase letter and contain only ' +
        'lowercase letters, numbers, hyphens, and underscores',
      );
    }

    layer.id = newId;
    if (newLabel) {
      layer.label = newLabel;
    }

    await this.saveConfig(layers);
  }

  /**
   * Update layer color.
   */
  async updateLayerColor(layerId: string, color: string): Promise<void> {
    // Validate color format
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      throw new Error('Color must be a valid hex color (e.g., "#cd7f32")');
    }

    const layers = this.loadConfig();
    const layer = layers.find(l => l.id === layerId);

    if (!layer) {
      throw new Error(`Layer "${layerId}" not found`);
    }

    layer.color = color;
    await this.saveConfig(layers);
  }

  /**
   * Update layer properties (label, abbreviation, creatable).
   */
  async updateLayer(layerId: string, updates: Partial<Omit<LayerConfig, 'id' | 'order'>>): Promise<void> {
    const layers = this.loadConfig();
    const layer = layers.find(l => l.id === layerId);

    if (!layer) {
      throw new Error(`Layer "${layerId}" not found`);
    }

    if (updates.label !== undefined) {
      const trimmed = updates.label.trim();
      if (!trimmed) {
        throw new Error('Layer label cannot be empty');
      }
      layer.label = trimmed;
    }
    if (updates.abbreviation !== undefined) {
      const trimmed = updates.abbreviation.trim();
      if (!trimmed) {
        throw new Error('Layer abbreviation cannot be empty');
      }
      layer.abbreviation = trimmed;
    }
    if (updates.color !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(updates.color)) {
        throw new Error('Color must be a valid hex color (e.g., "#cd7f32")');
      }
      layer.color = updates.color;
    }
    if (updates.creatable !== undefined) {
      layer.creatable = updates.creatable;
    }

    await this.saveConfig(layers);
  }

  /**
   * Reorder layers by providing new order of IDs.
   * All existing layer IDs must be included to prevent accidental deletion.
   */
  async reorderLayers(layerIds: string[]): Promise<void> {
    const layers = this.loadConfig();
    const existingIds = new Set(layers.map(l => l.id));
    const providedIds = new Set(layerIds);

    // Validate all provided IDs exist
    for (const id of layerIds) {
      if (!existingIds.has(id)) {
        throw new Error(`Layer "${id}" not found`);
      }
    }

    // Validate all existing layers are included (prevent accidental deletion)
    for (const id of existingIds) {
      if (!providedIds.has(id)) {
        throw new Error(
          `Layer "${id}" is missing from reorder list. ` +
          `All existing layers must be included to prevent accidental deletion.`,
        );
      }
    }

    // Validate no duplicates
    if (layerIds.length !== providedIds.size) {
      throw new Error('Duplicate layer IDs in reorder list');
    }

    // Reorder
    const reordered: LayerConfig[] = [];
    for (const [index, id] of layerIds.entries()) {
      const layer = layers.find(l => l.id === id)!;
      reordered.push({ ...layer, order: index });
    }

    await this.saveConfig(reordered);
  }

  /**
   * Invalidate cached config (call after external changes).
   */
  invalidateCache(): void {
    this.config = null;
  }
}
