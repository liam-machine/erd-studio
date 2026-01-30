/**
 * Layer configuration types for dynamic layer management.
 *
 * Layers define the medallion architecture levels for semantic domains.
 * Configuration is stored in models/semantic/layers.json and controls:
 *   - Layer metadata (label, abbreviation, description)
 *   - UI appearance (color)
 *   - Behavior flags (creatable, order)
 *
 * The LayerService handles loading, validation, and CRUD operations.
 */

/**
 * Configuration for a single data warehouse layer.
 *
 * Each layer represents a stage in the medallion architecture (bronze/raw,
 * silver/conformed, gold/curated) and controls how domains in that layer
 * are displayed and managed in the extension.
 */
export interface LayerConfig {
  /** Unique layer identifier (e.g., 'bronze', 'silver', 'gold'). */
  id: string;

  /** Display label shown in tree view (e.g., 'Bronze', 'Silver', 'Gold'). */
  label: string;

  /** Short abbreviation for compact displays (e.g., 'BRZ', 'SLV', 'GLD'). */
  abbreviation: string;

  /** Hex color code for layer badge and UI elements (e.g., '#cd7f32'). */
  color: string;

  /**
   * Whether users can create new domains in this layer.
   * Typically false for bronze (raw/staging), true for silver/gold.
   */
  creatable: boolean;

  /**
   * Display order in tree view (lower numbers appear first).
   * Allows custom ordering beyond alphabetical.
   */
  order: number;
}

/**
 * Full layer configuration file schema.
 * Stored at models/semantic/layers.json.
 */
export interface LayersConfigFile {
  /** Schema version for future compatibility. */
  schemaVersion: number;

  /** Array of layer configurations. */
  layers: LayerConfig[];
}

/** Current schema version for layers.json files. */
export const LAYERS_SCHEMA_VERSION = 1;

/** Default layer configurations (medallion architecture). */
export const DEFAULT_LAYERS: LayerConfig[] = [
  {
    id: 'silver',
    label: 'Silver',
    abbreviation: 'SLV',
    color: '#a0a0a0',
    creatable: true,
    order: 1,
  },
  {
    id: 'gold',
    label: 'Gold',
    abbreviation: 'GLD',
    color: '#d4a800',
    creatable: true,
    order: 2,
  },
];

/**
 * Known layer defaults for auto-detection.
 * When we detect a directory matching a known layer ID, we use these defaults.
 */
export const KNOWN_LAYER_DEFAULTS: Record<string, Omit<LayerConfig, 'id' | 'order'>> = {
  bronze: {
    label: 'Bronze',
    abbreviation: 'BRZ',
    color: '#cd7f32',
    creatable: false,
  },
  silver: {
    label: 'Silver',
    abbreviation: 'SLV',
    color: '#a0a0a0',
    creatable: true,
  },
  gold: {
    label: 'Gold',
    abbreviation: 'GLD',
    color: '#d4a800',
    creatable: true,
  },
};

/**
 * Color palette for auto-detected custom layers.
 * Used when a layer directory is found that doesn't match known defaults.
 */
export const AUTO_DETECT_COLORS: string[] = [
  '#6366f1', // indigo
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#f59e0b', // amber
  '#10b981', // emerald
  '#06b6d4', // cyan
];
