/**
 * The hover preview fades the canvas in CSS alone, so the cascade is the
 * contract: its rules must come after the click/search `--dimmed` rules they
 * override, use theme tokens only, stop moving under reduce-motion and leave
 * the flow glyphs out of print.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GRAPH = join(__dirname, '../../src/components/Graph');
const NODE_CSS = readFileSync(join(GRAPH, 'ModelNode.css'), 'utf8');
const EDGE_CSS = readFileSync(join(GRAPH, 'FkEdge.css'), 'utf8');
const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i;

/** Every rule (selector + body) whose selector mentions `needle`. */
function rulesMentioning(css: string, needle: string): string[] {
  const rules: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    if (m[1].includes(needle)) rules.push(`${m[1].trim()} { ${m[2].trim()} }`);
  }
  return rules;
}

function lastIndexOfRule(css: string, selectorPart: RegExp): number {
  let last = -1;
  const re = /([^{}]+)\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    if (selectorPart.test(m[1])) last = m.index;
  }
  return last;
}

describe('hover preview CSS', () => {
  for (const [name, css, dimmed] of [
    ['ModelNode.css', NODE_CSS, /\.model-node--dimmed/],
    ['FkEdge.css', EDGE_CSS, /\.fk-edge(?:__label)?--dimmed/],
  ] as const) {
    it(`${name}: the erd-flow--hover-focus rules come after every --dimmed rule`, () => {
      const firstHover = css.indexOf('.erd-flow--hover-focus');
      expect(firstHover).toBeGreaterThan(0);
      expect(firstHover).toBeGreaterThan(lastIndexOfRule(css, dimmed));
    });

    it(`${name}: the new rules use theme tokens, never colour literals`, () => {
      const rules = [
        ...rulesMentioning(css, 'erd-flow--hover-focus'),
        ...rulesMentioning(css, '--focus-origin'),
        ...rulesMentioning(css, 'fk-edge__flow'),
        ...rulesMentioning(css, 'fk-edge--flowing'),
      ];
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) expect(rule).not.toMatch(COLOUR_LITERAL);
    });

    it(`${name}: reduce-motion turns the fades off`, () => {
      const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
      expect(block.length).toBeGreaterThan(0);
      expect(block).toMatch(/transition:\s*none/);
    });
  }

  it('the flow glyphs take their colours from stage and discrepancy tokens', () => {
    for (const rule of rulesMentioning(EDGE_CSS, '.fk-edge__flow--')) {
      expect(rule).toMatch(/color:\s*var\(--(?:stage|discrepancy)-/);
    }
    expect(rulesMentioning(EDGE_CSS, '.fk-edge__flow-chevron').join(' ')).toMatch(/stroke:\s*var\(--edge-flow-halo\)/);
  });

  it('the hovered table\'s ring never replaces the amber discrepancy-extra glow or the selection ring', () => {
    const rings = rulesMentioning(NODE_CSS, '--focus-origin').filter((r) => /box-shadow/.test(r));
    expect(rings.length).toBeGreaterThan(0);
    for (const rule of rings) {
      expect(rule).toContain(':not(.model-node--disc-extra)');
      expect(rule).toContain(':not(.model-node--selected)');
    }
  });

  it('every faded table has the same tint, and the clicked one does not compete with the hover', () => {
    const base = rulesMentioning(NODE_CSS, '.erd-flow--hover-focus .model-node')
      .filter((r) => /(?:^|\s)\.erd-flow--hover-focus \.model-node \{/.test(r));
    expect(base).toHaveLength(1);
    expect(base.join(' ')).toMatch(/filter:\s*none/);
    const selected = rulesMentioning(NODE_CSS, '.erd-flow--hover-focus .model-node--selected').join(' ');
    expect(selected).toMatch(/opacity:\s*0\.4\b/);
  });

  it('print leaves the flow glyphs out', () => {
    const print = EDGE_CSS.slice(EDGE_CSS.indexOf('@media print'));
    expect(print).toMatch(/\.fk-edge__flow\s*\{\s*display:\s*none;/);
  });
});
