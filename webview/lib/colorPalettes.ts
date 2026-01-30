/**
 * Colour palette definitions for the semantic designer.
 *
 * Three palettes are available, each with different design rationales:
 * - coolWarm: Blue for built, orange for design (best accessibility)
 * - cicd: Emerald green for built, amber for design (CI/CD inspired)
 * - minimalist: Cyan for built, slate for design (subtle/professional)
 *
 * Palette colours are applied via CSS custom properties at runtime.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PaletteId = 'coolWarm' | 'cicd' | 'minimalist';

export interface ColorPalette {
  id: PaletteId;
  name: string;
  description: string;
  colors: {
    modelBuilt: string;
    modelBuiltBg: string;
    modelBuiltText: string;      // Text colour for built model headers
    modelDesign: string;
    modelDesignBg: string;
    modelDesignText: string;     // Text colour for design model headers
    modelMissing: string;
    modelMissingBg: string;
    edgeBuilt: string;
    edgeDesign: string;
  };
}

// ---------------------------------------------------------------------------
// Palette definitions
// ---------------------------------------------------------------------------

export const PALETTES: Record<PaletteId, ColorPalette> = {
  coolWarm: {
    id: 'coolWarm',
    name: 'Cool/Warm',
    description: 'Blue for built, orange for design — best accessibility',
    colors: {
      modelBuilt: '#60a5fa',      // Blue-400
      modelBuiltBg: 'rgba(96, 165, 250, 0.08)',
      modelBuiltText: '#ffffff',  // White on blue
      modelDesign: '#ea580c',     // Orange-600 (darker for contrast)
      modelDesignBg: 'rgba(234, 88, 12, 0.08)',
      modelDesignText: '#ffffff', // White on dark orange
      modelMissing: '#9ca3af',    // Gray-400
      modelMissingBg: 'rgba(156, 163, 175, 0.08)',
      edgeBuilt: '#60a5fa',       // Matches model-built
      edgeDesign: '#ea580c',      // Matches model-design
    },
  },
  cicd: {
    id: 'cicd',
    name: 'CI/CD Status',
    description: 'Emerald for built, amber for design — DevOps familiar',
    colors: {
      modelBuilt: '#059669',      // Emerald-600 (darker for contrast)
      modelBuiltBg: 'rgba(5, 150, 105, 0.08)',
      modelBuiltText: '#ffffff',  // White on dark emerald
      modelDesign: '#d97706',     // Amber-600 (much darker for white text)
      modelDesignBg: 'rgba(217, 119, 6, 0.08)',
      modelDesignText: '#ffffff', // White on dark amber
      modelMissing: '#6b7280',    // Gray-500
      modelMissingBg: 'rgba(107, 114, 128, 0.08)',
      edgeBuilt: '#10b981',       // Emerald-500 (edges can be brighter)
      edgeDesign: '#f59e0b',      // Amber-500 (edges can be brighter)
    },
  },
  minimalist: {
    id: 'minimalist',
    name: 'Minimalist',
    description: 'Cyan for built, violet for design — subtle/professional',
    colors: {
      modelBuilt: '#0891b2',      // Cyan-600 (darker for contrast)
      modelBuiltBg: 'rgba(8, 145, 178, 0.08)',
      modelBuiltText: '#ffffff',  // White on dark cyan
      modelDesign: '#7c3aed',     // Violet-600 (darker for white text)
      modelDesignBg: 'rgba(124, 58, 237, 0.08)',
      modelDesignText: '#ffffff', // White on dark violet
      modelMissing: '#64748b',    // Slate-500
      modelMissingBg: 'rgba(100, 116, 139, 0.08)',
      edgeBuilt: '#06b6d4',       // Cyan-500 (edges can be brighter)
      edgeDesign: '#8b5cf6',      // Violet-500 (edges can be brighter)
    },
  },
};

export const DEFAULT_PALETTE: PaletteId = 'coolWarm';

// ---------------------------------------------------------------------------
// CSS custom property application
// ---------------------------------------------------------------------------

/**
 * Apply a colour palette by setting CSS custom properties on :root.
 */
export function applyPalette(paletteId: PaletteId): void {
  const palette = PALETTES[paletteId];
  if (!palette) return;

  const root = document.documentElement;
  const { colors } = palette;

  root.style.setProperty('--model-built', colors.modelBuilt);
  root.style.setProperty('--model-built-bg', colors.modelBuiltBg);
  root.style.setProperty('--model-built-text', colors.modelBuiltText);
  root.style.setProperty('--model-design', colors.modelDesign);
  root.style.setProperty('--model-design-bg', colors.modelDesignBg);
  root.style.setProperty('--model-design-text', colors.modelDesignText);
  root.style.setProperty('--model-missing', colors.modelMissing);
  root.style.setProperty('--model-missing-bg', colors.modelMissingBg);
  root.style.setProperty('--edge-built', colors.edgeBuilt);
  root.style.setProperty('--edge-design', colors.edgeDesign);
}

/**
 * Get the raw colour values for a palette (used by MiniMap which needs hex).
 */
export function getPaletteColors(paletteId: PaletteId): ColorPalette['colors'] {
  return PALETTES[paletteId].colors;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'dbt-semantic-designer:palette';

/**
 * Load the persisted palette ID from localStorage, or return default.
 */
export function loadPersistedPalette(): PaletteId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored in PALETTES) {
      return stored as PaletteId;
    }
  } catch {
    // localStorage not available (e.g., in tests)
  }
  return DEFAULT_PALETTE;
}

/**
 * Persist the selected palette ID to localStorage.
 */
export function persistPalette(paletteId: PaletteId): void {
  try {
    localStorage.setItem(STORAGE_KEY, paletteId);
  } catch {
    // localStorage not available
  }
}
