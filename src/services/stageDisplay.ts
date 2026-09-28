/**
 * Logical stage → DisplayDomain, the pure core.
 *
 * A thin wrapper over `@erd-studio/core`'s `toDisplayDomain` — the one
 * implementation the canvas (`SemanticEditorProvider.buildDisplayDomain`) also
 * uses — without the canvas-only extras (templates, add-model pickers, layer
 * config). The discrepancy comparison only reads the core, so
 * `computeDomainDiff` (`stageDiff.ts`), shared by the canvas and the
 * `erd-studio` CLI, builds the logical side here and both see exactly the same
 * domain.
 *
 * No `vscode` import — this module is bundled into `dist/cli.js`.
 */

import { toDisplayDomain } from '@erd-studio/core';

import type { DisplayDomain } from '../types/display';
import type { SemanticDomain, ViewConfig } from '../types/semantic';

/**
 * Convert a logical `SemanticDomain` to a `DisplayDomain`.
 *
 * Key flags are coerced to booleans (`isPrimaryKey === true`), and a column is
 * a foreign key when it says so OR when it is the `fromColumn` of one of the
 * domain's relationships. `viewConfig` is passed separately because it lives
 * at the root of the unified domain file, not in the stage section.
 */
export function buildLogicalDisplayDomain(
  domain: SemanticDomain,
  viewConfig: ViewConfig,
  stubColumns?: string[],
): DisplayDomain {
  return toDisplayDomain(domain, {
    viewConfig,
    stubColumns,
    layerConfig: undefined,
    readOnly: domain.stage === 'physical',
  });
}
