/**
 * `layers.json` validation, without touching a file system.
 *
 * The extension host's LayerService reads and caches the file and keeps the
 * CRUD operations; the rules for what a valid layer list is live here so
 * every host resolves the same layers from the same file.
 */

import type { LayerConfig, LayersConfigFile } from './types/layer.js';
import { DEFAULT_LAYERS, LAYERS_SCHEMA_VERSION } from './types/layer.js';

/** Name of the layer configuration file under the semantic dir. */
export const LAYERS_CONFIG_FILE = 'layers.json';

/**
 * Result of validating a parsed `layers.json`: the usable config, or the
 * reason the whole file has to be replaced by the default layers.
 */
export type LayersConfigValidation =
  | { ok: true; config: LayersConfigFile }
  | { ok: false; reason: string };

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Validate parsed layers.json structure.
 *
 * Individual layers that are malformed are skipped or repaired with a warning
 * (passed to `warn`, which defaults to console.warn); a file that cannot be
 * used at all yields `{ ok: false, reason }`. Valid layers come back sorted by
 * `order`.
 */
export function validateLayersConfig(
  data: unknown,
  warn: (message: string) => void = (message) => console.warn(message),
): LayersConfigValidation {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'Layers config must be a JSON object' };
  }

  const obj = data as Record<string, unknown>;

  // Schema version check
  if (typeof obj.schemaVersion !== 'number') {
    return { ok: false, reason: 'Layers config missing schemaVersion field' };
  }

  if (obj.schemaVersion > LAYERS_SCHEMA_VERSION) {
    return {
      ok: false,
      reason:
        `Layers config has schemaVersion ${obj.schemaVersion} ` +
        `but this extension only supports up to version ${LAYERS_SCHEMA_VERSION}`,
    };
  }

  // Validate layers array
  if (!Array.isArray(obj.layers)) {
    return { ok: false, reason: 'Layers config must have a "layers" array' };
  }

  const layers: LayerConfig[] = [];
  const seenIds = new Set<string>();

  for (const [index, item] of obj.layers.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      warn(`Layer at index ${index} must be an object, skipping`);
      continue;
    }

    const layer = item as Record<string, unknown>;

    // Validate required fields
    if (typeof layer.id !== 'string' || !layer.id.trim()) {
      warn(`Layer at index ${index} missing valid id, skipping`);
      continue;
    }

    const id = layer.id.trim();

    // Check for duplicate IDs
    if (seenIds.has(id)) {
      warn(`Duplicate layer ID "${id}" at index ${index}, skipping`);
      continue;
    }
    seenIds.add(id);

    // Validate ID format (lowercase alphanumeric + hyphens/underscores)
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
      warn(`Layer ID "${id}" has invalid format, skipping`);
      continue;
    }

    if (typeof layer.label !== 'string' || !layer.label.trim()) {
      warn(`Layer "${id}" missing valid label, using id as label`);
    }

    // Validate color (basic hex format check)
    let color = '#808080'; // default grey
    if (typeof layer.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(layer.color)) {
      color = layer.color;
    } else {
      warn(`Layer "${id}" has invalid color, using default`);
    }

    layers.push({
      id,
      label: typeof layer.label === 'string' ? layer.label.trim() : capitalize(id),
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
    return { ok: false, reason: 'No valid layers found, using defaults' };
  }

  // Sort by order
  layers.sort((a, b) => a.order - b.order);

  return { ok: true, config: { schemaVersion: obj.schemaVersion, layers } };
}

/**
 * The layers configured by the text of a `layers.json`, or a copy of the
 * default layers when there is no file (`null`/`undefined`) or it cannot be
 * used. The reason a present file was not used goes to `warn`.
 */
export function parseLayersText(
  text: string | null | undefined,
  warn: (message: string) => void = (message) => console.warn(message),
): LayerConfig[] {
  const defaults = (): LayerConfig[] => DEFAULT_LAYERS.map((l) => ({ ...l }));
  if (text === null || text === undefined) {
    return defaults();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`Invalid JSON in layers config: ${message}`);
    return defaults();
  }

  const result = validateLayersConfig(parsed, warn);
  if (!result.ok) {
    warn(result.reason);
    return defaults();
  }
  return result.config.layers;
}
