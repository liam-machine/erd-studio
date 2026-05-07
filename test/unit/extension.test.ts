import { describe, it, expect } from 'vitest';
import * as extension from '../../src/extension';

describe('extension', () => {
  it('exports activate and deactivate functions', () => {
    expect(typeof extension.activate).toBe('function');
    expect(typeof extension.deactivate).toBe('function');
  });
});
