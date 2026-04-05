/**
 * Data-type colour mapping for column type text.
 *
 * Hand-picked colours for the 8 preset SQL types; deterministic
 * hash-derived colours for any custom / unknown type.
 *
 * Colours are HSL strings with moderate saturation and lightness tuned
 * for readability on both dark and light VS Code themes.
 */

// ---------------------------------------------------------------------------
// Preset palette — curated for the 8 standard types
// ---------------------------------------------------------------------------

const PRESET_COLORS: Record<string, string> = {
  STRING:    'hsl(200, 60%, 65%)',   // soft blue
  INT:       'hsl(160, 55%, 55%)',   // teal-green
  BIGINT:    'hsl(145, 50%, 58%)',   // muted emerald
  FLOAT:     'hsl(35, 65%, 62%)',    // warm amber
  BOOLEAN:   'hsl(280, 50%, 68%)',   // soft purple
  DATE:      'hsl(340, 55%, 65%)',   // muted rose
  TIMESTAMP: 'hsl(15, 60%, 62%)',    // coral-orange
  JSON:      'hsl(60, 45%, 58%)',    // muted gold
};

// ---------------------------------------------------------------------------
// Hash-based fallback for unknown types
// ---------------------------------------------------------------------------

/** Simple DJB2-style hash → 0–360 hue. */
function stringToHue(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return ((hash % 360) + 360) % 360;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns an HSL colour string for a given SQL data type.
 * Preset types get a hand-picked colour; everything else gets a
 * deterministic hash-derived colour.
 */
export function getDataTypeColor(dataType: string): string {
  if (!dataType) return 'var(--vscode-descriptionForeground, #888)';
  const key = dataType.toUpperCase().trim();
  if (key in PRESET_COLORS) return PRESET_COLORS[key];
  const hue = stringToHue(key);
  return `hsl(${hue}, 50%, 65%)`;
}
