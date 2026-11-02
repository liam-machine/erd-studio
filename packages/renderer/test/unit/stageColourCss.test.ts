/**
 * Stage colours in CSS: the selection ring takes the colour of the stage
 * being viewed (a ghost on the Physical tab included), and a logical-only
 * canvas (`editor-canvas--neutral`, no dbt project) paints no stage colour on
 * tables, lines or the selection ring — only theme tokens, so the layer badge
 * carries the colour.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '../../src');
const NODE_CSS = readFileSync(join(SRC, 'components/Graph/ModelNode.css'), 'utf8');
const THEME_CSS = readFileSync(join(SRC, 'styles/theme.css'), 'utf8');
const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i;

/** Every rule (selector + body) whose selector matches `test`. */
function rules(css: string, test: (selector: string) => boolean): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (test(selector)) out.push({ selector, body: m[2].trim() });
  }
  return out;
}

describe('selection ring', () => {
  // The hover ring's `:not(.model-node--selected)` is not a selection rule.
  const selected = rules(NODE_CSS, (s) => /model-node--selected|\.selected \.model-node/.test(s.replace(/:not\([^)]*\)/g, '')) && !s.includes('erd-flow--hover-focus'));

  it('React Flow\'s .selected and the node\'s own --selected draw the same stage-coloured ring', () => {
    const ring = selected.find((r) => r.selector.includes('.react-flow__node.selected .model-node') && !r.selector.includes('disc-extra'))!;
    expect(ring.selector).toContain('.model-node--selected');
    expect(ring.body).toMatch(/box-shadow:[^;]*var\(--model-node-ring\)[^;]*var\(--model-node-ring-glow\)/);
    expect(ring.body).not.toMatch(COLOUR_LITERAL);
  });

  it('is never hard-coded to the logical blue', () => {
    for (const rule of selected) expect(rule.body).not.toMatch(/stage-logical|96, 165, 250|--vscode-focusBorder/);
  });

  it('follows the stage being viewed, not the node\'s ghost state', () => {
    const base = rules(NODE_CSS, (s) => s === '.model-node').map((r) => r.body).join(' ');
    expect(base).toMatch(/--model-node-ring:\s*var\(--stage-logical\)/);
    const physical = rules(NODE_CSS, (s) => s === '.model-node--stage-physical')[0];
    expect(physical.body).toMatch(/--model-node-ring:\s*var\(--stage-physical\)/);
  });

  it('keeps the amber discrepancy-extra glow over the selection, however the selection is marked', () => {
    const amber = rules(NODE_CSS, (s) => s.includes('disc-extra') && /selected/.test(s));
    expect(amber.map((r) => r.selector).join(' ')).toContain('.react-flow__node.selected .model-node--disc-extra');
    const ringAt = NODE_CSS.indexOf('.react-flow__node.selected .model-node {');
    expect(ringAt).toBeGreaterThan(0);
    expect(NODE_CSS.indexOf('.react-flow__node.selected .model-node--disc-extra')).toBeGreaterThan(ringAt);
  });
});

describe('logical-only canvas (editor-canvas--neutral)', () => {
  it('maps its tokens to the theme\'s own colours', () => {
    for (const token of ['--canvas-neutral-line', '--canvas-selection']) {
      expect(THEME_CSS).toMatch(new RegExp(`${token}:\\s*var\\(--vscode-`));
    }
    // Derived from those, so the README's --vscode-* list needs no new entry.
    expect(THEME_CSS).toMatch(/--canvas-neutral-border:\s*color-mix\(in srgb, var\(--canvas-neutral-line\)/);
    expect(THEME_CSS).toMatch(/--canvas-selection:\s*var\(--vscode-focusBorder/);
  });

  it('turns the lines, their labels and the hover ring neutral, inside the diagram and the legend only', () => {
    const scoped = rules(THEME_CSS, (s) => s.includes('.editor-canvas--neutral'));
    expect(scoped).toHaveLength(1);
    expect(scoped[0].selector).toContain('.editor-canvas--neutral .react-flow__viewport');
    expect(scoped[0].selector).toContain('.editor-canvas--neutral .legend');
    expect(scoped[0].body).toMatch(/--stage-logical:\s*var\(--canvas-neutral-line\)/);
    expect(scoped[0].body).toMatch(/--stage-logical-ring:\s*var\(--canvas-neutral-ring\)/);
  });

  it('gives tables a neutral border and the selection ring the theme focus colour', () => {
    const border = rules(NODE_CSS, (s) => s === '.editor-canvas--neutral .model-node--logical')[0];
    expect(border.body).toMatch(/border-color:\s*var\(--canvas-neutral-border\)/);
    const ring = rules(NODE_CSS, (s) => s === '.editor-canvas--neutral .model-node')[0];
    expect(ring.body).toMatch(/--model-node-ring:\s*var\(--canvas-selection\)/);
    for (const rule of rules(NODE_CSS, (s) => s.includes('editor-canvas--neutral'))) {
      expect(rule.body).not.toMatch(COLOUR_LITERAL);
    }
  });
});
