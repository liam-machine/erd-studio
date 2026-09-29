/**
 * Plain-text rendering of a `meta` map for the canvas hover tips. The value
 * formatter itself is core's, shared with the Detail panel and the CLI.
 */

import { formatMetaValue, type Meta } from '@erd-studio/core';

export { formatMetaValue };

/** `[key, text]` pairs in file order; empty for a missing or empty map. */
export function metaRows(meta: Meta | undefined): [string, string][] {
  return Object.entries(meta ?? {}).map(([key, value]) => [key, formatMetaValue(value)]);
}
