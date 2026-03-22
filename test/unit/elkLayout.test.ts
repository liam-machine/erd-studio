import { describe, it, expect } from 'vitest';
import { roleToPartition } from '../../webview/lib/elkLayout';
import type { ModelRole } from '../../src/types/semantic';

describe('roleToPartition', () => {
  it('maps dimension roles to partition 0', () => {
    expect(roleToPartition('conformed-dim')).toBe(0);
    expect(roleToPartition('domain-dim')).toBe(0);
  });

  it('maps reference role to partition 1', () => {
    expect(roleToPartition('reference')).toBe(1);
  });

  it('maps fact roles to partition 2', () => {
    expect(roleToPartition('transaction-fact')).toBe(2);
    expect(roleToPartition('periodic-snapshot')).toBe(2);
    expect(roleToPartition('accumulating-snapshot')).toBe(2);
  });

  it('maps factless-fact (bridge) to partition 3', () => {
    expect(roleToPartition('factless-fact')).toBe(3);
  });

  it('maps gold roles to partition 4', () => {
    expect(roleToPartition('gold-dim')).toBe(4);
    expect(roleToPartition('gold-fact')).toBe(4);
  });

  it('defaults undefined role to partition 2', () => {
    expect(roleToPartition(undefined)).toBe(2);
  });

  it('covers all ModelRole values', () => {
    const allRoles: ModelRole[] = [
      'conformed-dim',
      'domain-dim',
      'transaction-fact',
      'periodic-snapshot',
      'accumulating-snapshot',
      'factless-fact',
      'reference',
      'gold-fact',
      'gold-dim',
    ];
    for (const role of allRoles) {
      expect(typeof roleToPartition(role)).toBe('number');
    }
  });
});
