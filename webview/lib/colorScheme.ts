/**
 * Colour scheme for model status and relationship status.
 *
 * Centralises the mapping from reconciled status to visual properties
 * (colour, CSS class suffix). Used by the graph transformer (F108) and
 * by the minimap node colour callback (F403).
 */

import type { SemanticModel, Relationship } from '../../src/types/semantic';
import type { ModelStatus, RelationshipStatus } from '../types/graph';

// ---------------------------------------------------------------------------
// Model status
// ---------------------------------------------------------------------------

/**
 * Derive display status from a SemanticModel.
 *
 * Until the ReconciliationService (F111) is implemented, status is inferred
 * directly from the model source:
 *   - `repo`   → `'built'`  (green)
 *   - `design` → `'design'` (orange)
 *
 * F111 will later add `'missing'` for repo models absent from the manifest.
 */
export function getModelStatus(model: SemanticModel): ModelStatus {
  return model.source === 'design' ? 'design' : 'built';
}

// ---------------------------------------------------------------------------
// Relationship status
// ---------------------------------------------------------------------------

/**
 * Derive display status from a Relationship.
 *
 * Relationships with `source: 'design'` are shown as design (orange);
 * all others are shown as built (blue).
 */
export function getRelationshipStatus(rel: Relationship): RelationshipStatus {
  return rel.source === 'design' ? 'design' : 'built';
}
