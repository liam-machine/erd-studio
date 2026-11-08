/**
 * The line routing stylesheet (`src/canvas/EdgeRouting.css`): theme tokens
 * only, and "colour on hover" on a logical-only canvas. Lines and their
 * labels stay the neutral grey at rest; only the lit / flowing lines of the
 * hovered or selected table, their adornments, their moving arrows and their
 * lit x-ray take the diagram's layer colour, falling back to the grey. Every
 * such rule is scoped to `.editor-canvas--neutral`, so a stage-coloured (dbt)
 * canvas is unchanged, and none touches a table card.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(__dirname, '../../src/canvas/EdgeRouting.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i;

/** Every rule as [selectors, body]. */
function rules(css: string): [string[], string][] {
  const out: [string[], string][] = [];
  const re = /([^{}@]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) out.push([m[1].split(',').map((s) => s.trim()), m[2].trim()]);
  return out;
}

const layerRules = rules(CSS).filter(([, body]) => body.includes('--diagram-layer-color'));
const layerSelectors = layerRules.flatMap(([selectors]) => selectors);

describe('EdgeRouting.css', () => {
  it('uses theme tokens only, no colour literals', () => {
    expect(CSS).not.toMatch(COLOUR_LITERAL);
  });

  it('lights exactly the focused lines, their labels, arrows and x-ray in the layer colour', () => {
    expect(layerSelectors.sort()).toEqual(
      [
        '.editor-canvas--neutral .edge-overlay__tunnel--logical.edge-overlay__tunnel--lit',
        '.editor-canvas--neutral .fk-edge--logical.fk-edge--flowing',
        '.editor-canvas--neutral .fk-edge--logical.fk-edge--lit',
        '.editor-canvas--neutral .fk-edge__adornment--lit',
        '.editor-canvas--neutral .fk-edge__flow--logical',
      ].sort(),
    );
  });

  it('falls back to the neutral line colour when the diagram has no layer colour', () => {
    for (const [, body] of layerRules) expect(body).toContain('var(--diagram-layer-color, var(--canvas-neutral-line))');
  });

  it('never colours a table card, and has no line-colour mode switch', () => {
    expect(CSS).not.toMatch(/model-node/);
    expect(CSS).not.toMatch(/data-line-colour/);
  });
});
