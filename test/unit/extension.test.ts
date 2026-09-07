import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as extension from '../../src/extension';

describe('extension', () => {
  it('exports activate and deactivate functions', () => {
    expect(typeof extension.activate).toBe('function');
    expect(typeof extension.deactivate).toBe('function');
  });

  it('registers the domain editor with retainContextWhenHidden (H20)', () => {
    // activate() needs a full workspace; assert on the registration call shape instead.
    const source = readFileSync(resolve(__dirname, '../../src/extension.ts'), 'utf8');
    const match = source.match(/registerCustomEditorProvider\(DOMAIN_EDITOR_VIEW_TYPE,\s*editorProvider,\s*\{[\s\S]*?\}\)/);
    expect(match, 'registerCustomEditorProvider call with options').not.toBeNull();
    expect(match![0]).toMatch(/retainContextWhenHidden:\s*true/);
  });
});
