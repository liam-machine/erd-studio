/**
 * Colour palette definitions for the semantic designer.
 *
 * Three palettes are available, each with different design rationales:
 * - coolWarm: Blue for built, teal for approved, orange for design (best accessibility)
 * - cicd: Blue for built, green for approved, amber for design (CI/CD inspired)
 * - trafficLight: Green for built, yellow for approved, red for design (traffic light)
 *
 * Palette colours are applied via CSS custom properties at runtime.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PaletteId = 'coolWarm' | 'cicd' | 'trafficLight';

export interface ColorPalette {
  id: PaletteId;
  name: string;
  description: string;
  colors: {
    modelBuilt: string;
    modelBuiltBg: string;
    modelBuiltText: string;      // Text colour for built model headers
    modelApproved: string;       // Approved model border colour
    modelApprovedBg: string;     // Approved model/column background
    modelApprovedText: string;   // Text colour for approved model headers
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
    description: 'Blue for built, teal for approved, orange for design — best accessibility',
    colors: {
      modelBuilt: '#60a5fa',      // Blue-400
      modelBuiltBg: 'rgba(96, 165, 250, 0.08)',
      modelBuiltText: '#ffffff',  // White on blue
      modelApproved: '#14b8a6',   // Teal-500
      modelApprovedBg: 'rgba(20, 184, 166, 0.08)',
      modelApprovedText: '#ffffff', // White on teal
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
    description: 'Blue for built, green for approved, amber for design — DevOps familiar',
    colors: {
      modelBuilt: '#3b82f6',      // Blue-500 (stable/deployed)
      modelBuiltBg: 'rgba(59, 130, 246, 0.08)',
      modelBuiltText: '#ffffff',  // White on blue
      modelApproved: '#10b981',   // Emerald-500 (green = approved/passing)
      modelApprovedBg: 'rgba(16, 185, 129, 0.08)',
      modelApprovedText: '#ffffff', // White on emerald
      modelDesign: '#d97706',     // Amber-600 (caution/in progress)
      modelDesignBg: 'rgba(217, 119, 6, 0.08)',
      modelDesignText: '#ffffff', // White on dark amber
      modelMissing: '#6b7280',    // Gray-500
      modelMissingBg: 'rgba(107, 114, 128, 0.08)',
      edgeBuilt: '#60a5fa',       // Blue-400 (edges can be brighter)
      edgeDesign: '#f59e0b',      // Amber-500 (edges can be brighter)
    },
  },
  trafficLight: {
    id: 'trafficLight',
    name: 'Traffic Light',
    description: 'Green for built, yellow for approved, red for design — universal recognition',
    colors: {
      modelBuilt: '#22c55e',      // Green-500 (success/done)
      modelBuiltBg: 'rgba(34, 197, 94, 0.08)',
      modelBuiltText: '#ffffff',  // White on green
      modelApproved: '#eab308',   // Yellow-500 (caution/pending)
      modelApprovedBg: 'rgba(234, 179, 8, 0.08)',
      modelApprovedText: '#ffffff', // White on yellow
      modelDesign: '#ef4444',     // Red-500 (stop/needs work)
      modelDesignBg: 'rgba(239, 68, 68, 0.08)',
      modelDesignText: '#ffffff', // White on red
      modelMissing: '#737373',    // Neutral-500
      modelMissingBg: 'rgba(115, 115, 115, 0.08)',
      edgeBuilt: '#4ade80',       // Green-400 (edges can be brighter)
      edgeDesign: '#f87171',      // Red-400 (edges can be brighter)
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
  root.style.setProperty('--model-approved', colors.modelApproved);
  root.style.setProperty('--model-approved-bg', colors.modelApprovedBg);
  root.style.setProperty('--model-approved-text', colors.modelApprovedText);
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
