/**
 * The standalone pages' glass style (src/types/glassPageStyle.ts) is a
 * hand copy of the editor's tokens in packages/renderer/src/styles/theme.css,
 * because those pages cannot link dist/webview.css. These tests keep the copy
 * honest: every token it defines exists in theme.css with the same value under
 * the same selector, it carries no colour literal theme.css does not, and it
 * imports nothing (some of the pages are bundled into the CLI).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  GLASS_PAGE_BASE,
  GLASS_PAGE_STYLE,
  GLASS_PAGE_TOKENS,
} from '../../src/types/glassPageStyle';

const ROOT = join(__dirname, '..', '..');
const THEME_CSS = readFileSync(join(ROOT, 'packages/renderer/src/styles/theme.css'), 'utf8');
const MODULE_SOURCE = readFileSync(join(ROOT, 'src/types/glassPageStyle.ts'), 'utf8');

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

interface Declaration {
  /** The enclosing at-rule (if any) and selector list, normalised. */
  context: string;
  name: string;
  value: string;
}

/** Every `--custom-property: value;` with the rule (and at-rule) it sits in. */
function customProperties(css: string): Declaration[] {
  const out: Declaration[] = [];
  const stack: string[] = [];
  let buffer = '';
  for (const ch of stripComments(css)) {
    if (ch === '{') {
      stack.push(squash(buffer).replace(/\s*,\s*/g, ','));
      buffer = '';
    } else if (ch === '}') {
      collect(buffer);
      stack.pop();
      buffer = '';
    } else if (ch === ';') {
      collect(buffer);
      buffer = '';
    } else {
      buffer += ch;
    }
  }
  function collect(text: string): void {
    const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]*)$/.exec(text);
    if (m) out.push({ context: stack.join(' > '), name: m[1], value: squash(m[2]) });
  }
  return out;
}

const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;

describe('glassPageStyle', () => {
  const tokens = customProperties(GLASS_PAGE_TOKENS);
  const theme = customProperties(THEME_CSS);

  it('defines tokens', () => {
    expect(tokens.length).toBeGreaterThan(100);
    for (const name of ['--glass-surface-2', '--glass-border', '--control-fill', '--text-primary', '--radius-md', '--space-4', '--duration-fast', '--canvas-wash']) {
      expect(tokens.some((t) => t.name === name)).toBe(true);
    }
  });

  it('defines only token names theme.css also defines', () => {
    const themeNames = new Set(theme.map((t) => t.name));
    const unknown = [...new Set(tokens.map((t) => t.name))].filter((n) => !themeNames.has(n));
    expect(unknown).toEqual([]);
  });

  it('gives every token the value theme.css gives it under the same selector', () => {
    const themeByKey = new Map(theme.map((t) => [`${t.context} | ${t.name}`, t.value]));
    const drift = tokens
      .filter((t) => themeByKey.get(`${t.context} | ${t.name}`) !== t.value)
      .map((t) => `${t.context} | ${t.name}: ${t.value}  (theme.css: ${themeByKey.get(`${t.context} | ${t.name}`) ?? 'not under this selector'})`);
    expect(drift).toEqual([]);
  });

  it('carries the theme and accessibility overrides', () => {
    const contexts = new Set(tokens.map((t) => t.context));
    expect(contexts).toContain('body');
    expect(contexts).toContain('body.vscode-light');
    expect(contexts).toContain('body.vscode-high-contrast,body.vscode-high-contrast-light');
    expect(contexts).toContain('@media (prefers-reduced-transparency: reduce) > body,body.vscode-light');
    expect(contexts).toContain('@media (prefers-reduced-motion: reduce) > :root');
  });

  it('has no colour literal outside a token theme.css defines the same way', () => {
    const themeDecls = new Set(theme.map((t) => `${t.name}: ${t.value}`));
    // In the tokens: a literal only inside a declaration copied from theme.css.
    const strayInTokens = tokens
      .filter((t) => COLOUR_LITERAL.test(t.value) && !themeDecls.has(`${t.name}: ${t.value}`))
      .map((t) => t.name);
    expect(strayInTokens).toEqual([]);
    // Outside the token declarations (and in the whole base): none at all.
    const tokensWithoutDecls = stripComments(GLASS_PAGE_TOKENS).replace(/--[\w-]+\s*:[^;]*;/g, '');
    expect(tokensWithoutDecls).not.toMatch(COLOUR_LITERAL);
    expect(stripComments(GLASS_PAGE_BASE)).not.toMatch(COLOUR_LITERAL);
  });

  it('declares only page-local --gp-* custom properties in the base', () => {
    const names = customProperties(GLASS_PAGE_BASE).map((t) => t.name);
    expect(names.filter((n) => !n.startsWith('--gp-'))).toEqual([]);
  });

  it('prefixes every kit class with gp-', () => {
    const classes = [...new Set(stripComments(GLASS_PAGE_BASE).match(/\.[a-z][\w-]*/gi) ?? [])]
      // `.` inside numbers (0.45, 0.92em) is not a class.
      .filter((c) => !/^\.\d/.test(c));
    const vscodeThemeClasses = ['.vscode-light', '.vscode-high-contrast', '.vscode-high-contrast-light'];
    expect(classes.filter((c) => !c.startsWith('.gp-') && !vscodeThemeClasses.includes(c))).toEqual([]);
  });

  it('loads nothing from outside the page (CSP stays nonce-only)', () => {
    expect(GLASS_PAGE_STYLE).not.toMatch(/@import|url\(|@font-face|https?:/i);
  });

  it('is tokens then base', () => {
    expect(GLASS_PAGE_STYLE).toBe(GLASS_PAGE_TOKENS + GLASS_PAGE_BASE);
  });

  it('imports nothing', () => {
    expect(MODULE_SOURCE).not.toMatch(/^\s*import\s/m);
    expect(MODULE_SOURCE).not.toMatch(/\brequire\s*\(/);
  });
});
