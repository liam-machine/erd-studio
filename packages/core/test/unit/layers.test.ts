import { describe, it, expect, vi } from 'vitest';

import { LAYERS_CONFIG_FILE, parseLayersText, validateLayersConfig } from '../../src/layers';
import { DEFAULT_LAYERS } from '../../src/types/layer';

describe('LAYERS_CONFIG_FILE', () => {
  it('is layers.json', () => {
    expect(LAYERS_CONFIG_FILE).toBe('layers.json');
  });
});

describe('validateLayersConfig', () => {
  const reasonFor = (data: unknown) => {
    const r = validateLayersConfig(data, () => {});
    expect(r.ok).toBe(false);
    return r.ok ? '' : r.reason;
  };

  it('gives a reason for a file it cannot use at all', () => {
    expect(reasonFor(null)).toBe('Layers config must be a JSON object');
    expect(reasonFor([])).toBe('Layers config must be a JSON object');
    expect(reasonFor({ layers: [] })).toBe('Layers config missing schemaVersion field');
    expect(reasonFor({ schemaVersion: 2, layers: [] }))
      .toBe('Layers config has schemaVersion 2 but this extension only supports up to version 1');
    expect(reasonFor({ schemaVersion: 1, layers: {} })).toBe('Layers config must have a "layers" array');
    expect(reasonFor({ schemaVersion: 1, layers: [null, { id: 'Bad Id' }] })).toBe('No valid layers found, using defaults');
  });

  it('skips or repairs malformed layers, warning for each, and sorts by order', () => {
    const warn = vi.fn();
    const r = validateLayersConfig(
      {
        schemaVersion: 1,
        layers: [
          { id: 'gold', label: ' Gold ', abbreviation: ' GLD ', color: '#d4a800', creatable: true, order: 5 },
          'not an object',
          { label: 'no id' },
          { id: 'gold' },
          { id: 'Bad' },
          { id: ' bronze ', color: 'brown' },
        ],
      },
      warn,
    );
    expect(r).toEqual({
      ok: true,
      config: {
        schemaVersion: 1,
        layers: [
          { id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 5 },
          { id: 'bronze', label: 'Bronze', abbreviation: 'BRO', color: '#808080', creatable: false, order: 5 },
        ],
      },
    });
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      'Layer at index 1 must be an object, skipping',
      'Layer at index 2 missing valid id, skipping',
      'Duplicate layer ID "gold" at index 3, skipping',
      'Layer ID "Bad" has invalid format, skipping',
      'Layer "bronze" missing valid label, using id as label',
      'Layer "bronze" has invalid color, using default',
    ]);
  });

  it('sorts layers by order, using the index when there is none', () => {
    const r = validateLayersConfig(
      {
        schemaVersion: 1,
        layers: [
          { id: 'gold', label: 'Gold', color: '#000000', order: 9 },
          { id: 'silver', label: 'Silver', color: '#000000' },
        ],
      },
      () => {},
    );
    expect(r.ok && r.config.layers.map((l) => [l.id, l.order])).toEqual([['silver', 1], ['gold', 9]]);
  });
});

describe('parseLayersText', () => {
  it('returns a copy of the default layers when there is no file', () => {
    for (const text of [null, undefined]) {
      const layers = parseLayersText(text, () => {});
      expect(layers).toEqual(DEFAULT_LAYERS);
      layers[0].label = 'changed';
      expect(DEFAULT_LAYERS[0].label).toBe('Silver');
    }
  });

  it('falls back to the defaults, with the reason, for text that is not JSON or not usable', () => {
    const warn = vi.fn();
    expect(parseLayersText('{', warn)).toEqual(DEFAULT_LAYERS);
    expect(warn.mock.calls[0][0]).toMatch(/^Invalid JSON in layers config: /);
    warn.mockClear();
    expect(parseLayersText('{"layers": []}', warn)).toEqual(DEFAULT_LAYERS);
    expect(warn).toHaveBeenCalledWith('Layers config missing schemaVersion field');
  });

  it('returns the configured layers', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      layers: [{ id: 'bronze', label: 'Bronze', abbreviation: 'BRZ', color: '#cd7f32', creatable: false, order: 0 }],
    });
    expect(parseLayersText(text, () => {})).toEqual([
      { id: 'bronze', label: 'Bronze', abbreviation: 'BRZ', color: '#cd7f32', creatable: false, order: 0 },
    ]);
  });
});
