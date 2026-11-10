/**
 * Path geometry for the still flow glyphs: length, straight runs, the pose at
 * a fraction, and placements that stay off the bends.
 */
import { describe, it, expect } from 'vitest';
import { getSmoothStepPath, Position } from '@xyflow/react';
import { measurePath, poseAt, stillPositions } from '../../src/lib/pathGeometry';

describe('measurePath', () => {
  it('measures straight runs, H and V included', () => {
    const g = measurePath('M2,6 H46');
    expect(g.length).toBe(44);
    expect(g.straights).toEqual([{ start: 0, end: 1 }]);
    const l = measurePath('M0 0L30 0 V40');
    expect(l.length).toBe(70);
    expect(l.straights).toHaveLength(2);
  });

  it('reads a smooth-step path: three runs joined by rounded bends', () => {
    const [d] = getSmoothStepPath({
      sourceX: 0, sourceY: 0, targetX: 300, targetY: 100,
      sourcePosition: Position.Right, targetPosition: Position.Left, borderRadius: 8,
    });
    const g = measurePath(d);
    // A little under |dx| + |dy| because the bends cut the corners.
    expect(g.length).toBeGreaterThan(390);
    expect(g.length).toBeLessThanOrEqual(400);
    expect(g.straights).toHaveLength(3);
  });

  it('flattens a self-loop cubic', () => {
    const g = measurePath('M 100,0 C 155,-55 175,-25 120,30');
    expect(g.length).toBeGreaterThan(100);
    expect(g.straights).toEqual([]);
  });

  it('has length 0 for an unreadable path', () => {
    expect(measurePath('').length).toBe(0);
    expect(poseAt(measurePath(''), 0.5)).toEqual({ x: 0, y: 0, angle: 0 });
  });
});

describe('poseAt', () => {
  it('gives the point and heading along the path', () => {
    const g = measurePath('M0 0L100 0 V100');
    expect(poseAt(g, 0.25)).toEqual({ x: 50, y: 0, angle: 0 });
    const down = poseAt(g, 0.75);
    expect(down.x).toBe(100);
    expect(down.y).toBe(50);
    expect(down.angle).toBe(90);
  });
});

describe('stillPositions', () => {
  it('uses the middle of the first and last straight runs, never the bends', () => {
    const [d] = getSmoothStepPath({
      sourceX: 0, sourceY: 0, targetX: 300, targetY: 100,
      sourcePosition: Position.Right, targetPosition: Position.Left, borderRadius: 8,
    });
    const g = measurePath(d);
    const [a, b] = stillPositions(g)!;
    const first = g.straights[0];
    const last = g.straights[g.straights.length - 1];
    expect(a).toBeCloseTo((first.start + first.end) / 2, 2);
    expect(b).toBeCloseTo((last.start + last.end) / 2, 2);
    // Both headings are horizontal: the glyphs sit on straight, level runs.
    expect(Math.abs(poseAt(g, a).angle)).toBeLessThan(1);
    expect(Math.abs(poseAt(g, b).angle)).toBeLessThan(1);
  });

  it('splits a single straight line in thirds', () => {
    expect(stillPositions(measurePath('M0 0L300 0'))).toEqual([0.333, 0.667]);
  });

  it('is null for a curve (the planner defaults apply)', () => {
    expect(stillPositions(measurePath('M 100,0 C 155,-55 175,-25 120,30'))).toBeNull();
  });
});
