/**
 * Layer cues: how the canvas names the layer a table lives in.
 *
 * A table's header badge has one meaning, its layer, and the layer is named
 * the same way wherever the canvas names one (the node badge, the toolbar
 * chip, the status-bar key): the layer's abbreviation, then its label.
 *
 * A project with a single layer has nothing to tell apart, so the per-table
 * badge, its colour strip, the status-bar key and the toolbar chip are left
 * off there ({@link isSingleLayerProject}).
 */

import type { DisplaySubjectArea, LayerConfig } from '@erd-studio/core';

/** Abbreviations for the default layers, for when a layer has no config. */
export const LAYER_BADGE_FALLBACK: Readonly<Record<string, string>> = {
  bronze: 'BRZ',
  silver: 'SLV',
  gold: 'GLD',
};

/**
 * A layer's badge text: its configured abbreviation, else the default
 * layers' abbreviation, else the first three letters of its id.
 */
export function layerAbbreviation(id: string, config?: Pick<LayerConfig, 'abbreviation'>): string {
  return config?.abbreviation ?? LAYER_BADGE_FALLBACK[id] ?? id.substring(0, 3).toUpperCase();
}

/**
 * Whether the project has one layer at most, with every table on the diagram
 * in the diagram's layer: the layer badge, strip, key and chip are then left
 * off. Needs `layerConfigs`: a domain from an older core (or a host that
 * sends no layer list) keeps every layer cue, as it did before.
 */
export function isSingleLayerProject(
  domain: Pick<DisplaySubjectArea, 'layer' | 'layerConfigs' | 'models'>,
): boolean {
  const configs = domain.layerConfigs;
  if (!Array.isArray(configs) || configs.length > 1) return false;
  return (domain.models ?? []).every((m) => m.layer === undefined || m.layer === domain.layer);
}
