import { describe, it, expect } from 'vitest';
import { extractManifestData } from '../../src/workers/manifestExtractor';
import { parseRefModelName, resolveModelNameFromNodeId, normaliseName, namesEqual } from '../../src/services/nameUtils';

/** Build a minimal manifest model node. */
function modelNode(
  uniqueId: string,
  name: string,
  columns: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    unique_id: uniqueId,
    name,
    schema: 'analytics',
    description: `${name} description`,
    columns: Object.fromEntries(
      columns.map((c) => [c, { name: c, data_type: 'string', description: '' }]),
    ),
    ...extra,
  };
}

/** Build a minimal manifest test node with test_metadata. */
function testNode(
  testName: string,
  kwargs: Record<string, unknown>,
  attachedNode: string | null,
  dependsOn: string[],
): Record<string, unknown> {
  return {
    test_metadata: { name: testName, kwargs },
    attached_node: attachedNode,
    depends_on: { nodes: dependsOn },
  };
}

/**
 * Manifest with a dbt versioned model (dim_customer v1 + v2, v2 latest),
 * an un-versioned fact, and tests attached to the versioned nodes.
 */
function versionedManifest(): Record<string, unknown> {
  return {
    nodes: {
      // v2 listed first so "last wins" would pick v1 — the extractor must prefer latest_version
      'model.proj.dim_customer.v2': modelNode(
        'model.proj.dim_customer.v2', 'dim_customer', ['customer_id', 'customer_name', 'segment'],
        { version: 2, latest_version: 2 },
      ),
      'model.proj.dim_customer.v1': modelNode(
        'model.proj.dim_customer.v1', 'dim_customer', ['customer_id', 'customer_name'],
        { version: 1, latest_version: 2 },
      ),
      'model.proj.fct_orders': modelNode(
        'model.proj.fct_orders', 'fct_orders', ['order_id', 'customer_id'],
      ),
      'test.proj.unique_dim_customer_v2_customer_id': testNode(
        'unique', { column_name: 'customer_id' },
        'model.proj.dim_customer.v2', ['model.proj.dim_customer.v2'],
      ),
      'test.proj.unique_combination_dim_customer_v2': testNode(
        'unique_combination_of_columns', { combination_of_columns: ['customer_id', 'segment'] },
        'model.proj.dim_customer.v2', ['model.proj.dim_customer.v2'],
      ),
      'test.proj.relationships_fct_orders_customer_id__ref_dim_customer_v2': testNode(
        'relationships', { column_name: 'customer_id', field: 'customer_id', to: "ref('dim_customer', v=2)" },
        'model.proj.fct_orders', ['model.proj.fct_orders', 'model.proj.dim_customer.v2'],
      ),
      // Test with no attached_node — must resolve fromModel from depends_on of a versioned id
      'test.proj.relationships_dim_customer_v1_no_attached': testNode(
        'relationships', { column_name: 'customer_id', field: 'order_id', to: "ref('proj', 'fct_orders')" },
        null, ['model.proj.dim_customer.v1', 'model.proj.fct_orders'],
      ),
    },
  };
}

describe('manifestExtractor — dbt versioned models (H10)', () => {
  it('keys versioned models by their un-versioned name, preferring latest_version', () => {
    const result = extractManifestData(versionedManifest());

    expect(Object.keys(result.models).sort()).toEqual(['dim_customer', 'fct_orders']);
    expect(result.models.dim_customer.uniqueId).toBe('model.proj.dim_customer.v2');
    expect(result.models.dim_customer.version).toBe(2);
    expect(result.models.dim_customer.latestVersion).toBe(2);
    expect(result.models.dim_customer.columns.map((c) => c.name)).toContain('segment');
  });

  it('prefers latest_version regardless of node iteration order', () => {
    const manifest = versionedManifest();
    const nodes = manifest.nodes as Record<string, unknown>;
    // Re-order so v1 is iterated after v2 (already the case) AND the reverse
    const reversed = { nodes: Object.fromEntries(Object.entries(nodes).reverse()) };

    expect(extractManifestData(manifest).models.dim_customer.uniqueId).toBe('model.proj.dim_customer.v2');
    expect(extractManifestData(reversed).models.dim_customer.uniqueId).toBe('model.proj.dim_customer.v2');
  });

  it('falls back to the highest numeric version when no node is marked latest', () => {
    const manifest = {
      nodes: {
        'model.proj.dim_x.v1': modelNode('model.proj.dim_x.v1', 'dim_x', ['a'], { version: 1 }),
        'model.proj.dim_x.v3': modelNode('model.proj.dim_x.v3', 'dim_x', ['a', 'b', 'c'], { version: 3 }),
        'model.proj.dim_x.v2': modelNode('model.proj.dim_x.v2', 'dim_x', ['a', 'b'], { version: 2 }),
      },
    };

    const result = extractManifestData(manifest);
    expect(result.models.dim_x.uniqueId).toBe('model.proj.dim_x.v3');
  });

  it('resolves unique tests attached to versioned nodes to the model name, not "v2"', () => {
    const result = extractManifestData(versionedManifest());

    expect(result.uniqueColumns.v2).toBeUndefined();
    expect(result.uniqueColumns.dim_customer).toEqual(['customer_id']);
  });

  it('resolves composite unique tests attached to versioned nodes to the model name', () => {
    const result = extractManifestData(versionedManifest());

    expect(result.compositeUniqueGroups.v2).toBeUndefined();
    expect(result.compositeUniqueGroups.dim_customer).toEqual([['customer_id', 'segment']]);
  });

  it("keeps relationship tests whose `to` uses ref('model', v=N)", () => {
    const result = extractManifestData(versionedManifest());

    const rel = result.relationshipTests.find(
      (r) => r.fromModel === 'fct_orders' && r.fromColumn === 'customer_id',
    );
    expect(rel).toBeDefined();
    expect(rel!.toModel).toBe('dim_customer');
    expect(rel!.toColumn).toBe('customer_id');
  });

  it('resolves fromModel from depends_on when attached_node is absent and the id is versioned', () => {
    const result = extractManifestData(versionedManifest());

    const rel = result.relationshipTests.find((r) => r.toModel === 'fct_orders');
    expect(rel).toBeDefined();
    expect(rel!.fromModel).toBe('dim_customer');
  });

  it('resolves node ids by stripping .vN when the node is not present in the manifest', () => {
    const manifest = {
      nodes: {
        'test.proj.unique_orphan': testNode(
          'unique', { column_name: 'id' },
          'model.other_pkg.dim_external.v4', ['model.other_pkg.dim_external.v4'],
        ),
      },
    };

    const result = extractManifestData(manifest);
    expect(result.uniqueColumns.dim_external).toEqual(['id']);
  });
});

describe('nameUtils', () => {
  describe('parseRefModelName', () => {
    it.each([
      ["ref('dim_customer')", 'dim_customer'],
      ['ref("dim_customer")', 'dim_customer'],
      ["ref( 'dim_customer' )", 'dim_customer'],
      ["ref('proj', 'dim_customer')", 'dim_customer'],
      ["ref('dim_customer', v=2)", 'dim_customer'],
      ["ref('dim_customer', v = 2)", 'dim_customer'],
      ["ref('dim_customer', version=2)", 'dim_customer'],
      ["ref('dim_customer', version='2')", 'dim_customer'],
      ["ref('proj', 'dim_customer', v=2)", 'dim_customer'],
      ["{{ ref('dim_customer') }}", 'dim_customer'],
    ])('extracts the model from %s', (input, expected) => {
      expect(parseRefModelName(input)).toBe(expected);
    });

    it('returns undefined when no ref() is present', () => {
      expect(parseRefModelName('dim_customer')).toBeUndefined();
      expect(parseRefModelName("source('raw', 'customers')")).toBeUndefined();
    });
  });

  describe('resolveModelNameFromNodeId', () => {
    it('prefers the node name when the node exists', () => {
      const nodes = { 'model.proj.dim_customer.v2': { name: 'dim_customer' } };
      expect(resolveModelNameFromNodeId('model.proj.dim_customer.v2', nodes)).toBe('dim_customer');
    });

    it('strips a trailing .vN segment when the node is missing', () => {
      expect(resolveModelNameFromNodeId('model.proj.dim_customer.v12')).toBe('dim_customer');
    });

    it('returns the last segment for un-versioned ids', () => {
      expect(resolveModelNameFromNodeId('model.proj.fct_orders')).toBe('fct_orders');
    });

    it('does not strip a model name that merely ends in v-digits without a dot', () => {
      expect(resolveModelNameFromNodeId('model.proj.dim_v2')).toBe('dim_v2');
    });
  });

  describe('normaliseName / namesEqual', () => {
    it('lowercases and trims', () => {
      expect(normaliseName('  CUSTOMER_ID ')).toBe('customer_id');
    });

    it('compares case-insensitively', () => {
      expect(namesEqual('Customer_Id', 'CUSTOMER_ID')).toBe(true);
      expect(namesEqual('customer_id', 'customer_key')).toBe(false);
    });
  });
});
