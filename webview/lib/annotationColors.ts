/**
 * Shared annotation colour constants.
 *
 * Used by AnnotationNode (inline toolbar) and ContextMenu (right-click menu)
 * to render identical colour swatch rows from a single source of truth.
 */

import type { AnnotationColor } from '../../src/types/semantic';

export interface AnnotationColorOption {
  value: AnnotationColor;
  label: string;
  swatch: string;
}

export const ANNOTATION_COLORS: AnnotationColorOption[] = [
  { value: 'yellow', label: 'Yellow', swatch: '#f59e0b' },
  { value: 'blue', label: 'Blue', swatch: '#3b82f6' },
  { value: 'green', label: 'Green', swatch: '#22c55e' },
  { value: 'pink', label: 'Pink', swatch: '#ec4899' },
  { value: 'orange', label: 'Orange', swatch: '#f97316' },
];
