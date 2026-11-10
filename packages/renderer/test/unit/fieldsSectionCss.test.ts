/**
 * The Fields section is styled with theme tokens only: no colour literal in
 * its stylesheet, and the hard-coded purple the old rationale editor used is
 * gone from the Detail panel's (its add button reads `--ai-fg` / `--ai-bg`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '../../src/components/DetailPanel');
const FIELDS_CSS = readFileSync(join(DIR, 'FieldsSection.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const PANEL_CSS = readFileSync(join(DIR, 'DetailPanel.css'), 'utf8');
const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i;

describe('FieldsSection.css', () => {
  it('uses theme tokens only', () => {
    expect(FIELDS_CSS).not.toMatch(COLOUR_LITERAL);
    expect(FIELDS_CSS).toMatch(/\.fields-section\b/);
  });
});

describe('DetailPanel.css', () => {
  it('no longer hard-codes the rationale purple', () => {
    expect(PANEL_CSS).not.toMatch(/#8b5cf6|139,\s*92,\s*246/i);
    expect(PANEL_CSS).toMatch(/\.detail-panel__rationale-add-btn:hover\s*\{[^}]*var\(--ai-fg\)/);
  });
});
