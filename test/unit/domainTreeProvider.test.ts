import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { TreeItemCollapsibleState } from 'vscode';
import { DomainService } from '../../src/services/domainService';
import { DomainTreeProvider, type TreeElement } from '../../src/providers/DomainTreeProvider';

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const FIXTURE_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project');

describe('DomainTreeProvider', () => {
  let service: DomainService;
  let provider: DomainTreeProvider;

  beforeEach(() => {
    service = new DomainService();
    provider = new DomainTreeProvider(service, FIXTURE_PROJECT_PATH);
  });

  describe('getChildren (root)', () => {
    it('returns three layer nodes at root', () => {
      const children = provider.getChildren(undefined);

      expect(children).toHaveLength(3);
      expect(children).toEqual([
        { type: 'layer', layer: 'bronze' },
        { type: 'layer', layer: 'silver' },
        { type: 'layer', layer: 'gold' },
      ]);
    });
  });

  describe('getChildren (layer)', () => {
    it('returns domain nodes for silver layer', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'silver' })!;

      // work-lots domain + "New Domain..." item
      expect(children).toHaveLength(2);
      expect(children[0].type).toBe('domain');
      expect(children[1].type).toBe('newDomain');
    });

    it('returns domain nodes for gold layer', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'gold' })!;

      // finance domain + "New Domain..." item
      expect(children).toHaveLength(2);
      expect(children[0].type).toBe('domain');
      expect(children[1].type).toBe('newDomain');
    });

    it('returns empty array for bronze (no domains, no New Domain item)', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'bronze' })!;

      expect(children).toHaveLength(0);
    });

    it('returns correct model counts for work-lots domain', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'silver' })!;
      const domain = children[0];

      expect(domain.type).toBe('domain');
      if (domain.type === 'domain') {
        expect(domain.modelCount).toBe(4);
        expect(domain.designCount).toBe(2);
      }
    });

    it('returns correct model counts for finance domain (no design models)', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'gold' })!;
      const domain = children[0];

      expect(domain.type).toBe('domain');
      if (domain.type === 'domain') {
        expect(domain.modelCount).toBe(1);
        expect(domain.designCount).toBe(0);
      }
    });

    it('passes layer to NewDomain node', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'silver' })!;
      const newDomain = children[children.length - 1];

      expect(newDomain).toEqual({ type: 'newDomain', layer: 'silver' });
    });
  });

  describe('getChildren (leaf)', () => {
    it('returns undefined for domain nodes', () => {
      const children = provider.getChildren({
        type: 'domain',
        summary: { domain: 'test', layer: 'silver', filePath: '/test.json' },
        modelCount: 0,
        designCount: 0,
      });
      expect(children).toBeUndefined();
    });

    it('returns undefined for newDomain nodes', () => {
      const children = provider.getChildren({ type: 'newDomain', layer: 'silver' });
      expect(children).toBeUndefined();
    });
  });

  describe('getTreeItem', () => {
    it('creates layer item with folder icon and expanded state', () => {
      const item = provider.getTreeItem({ type: 'layer', layer: 'silver' });

      expect(item.label).toBe('Silver');
      expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
      expect(item.contextValue).toBe('layer');
    });

    it('creates domain item with badge showing design count', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'work-lots', layer: 'silver', filePath: '/test.json' },
        modelCount: 12,
        designCount: 3,
      };
      const item = provider.getTreeItem(element);

      expect(item.label).toBe('work-lots');
      expect(item.description).toBe('12 models, 3 designs');
      expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
      expect(item.contextValue).toBe('domain');
    });

    it('creates domain item with badge omitting design when zero', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'finance', layer: 'gold', filePath: '/test.json' },
        modelCount: 5,
        designCount: 0,
      };
      const item = provider.getTreeItem(element);

      expect(item.description).toBe('5 models');
    });

    it('uses singular "model" when count is 1', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'test', layer: 'gold', filePath: '/test.json' },
        modelCount: 1,
        designCount: 0,
      };
      const item = provider.getTreeItem(element);

      expect(item.description).toBe('1 model');
    });

    it('sets openDomain command on domain items', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'test', layer: 'silver', filePath: '/path/to/test.json' },
        modelCount: 0,
        designCount: 0,
      };
      const item = provider.getTreeItem(element);

      expect(item.command).toEqual({
        command: 'dbtSemantic.openDomain',
        title: 'Open Domain',
        arguments: ['/path/to/test.json'],
      });
    });

    it('creates New Domain item with add icon and createDomain command', () => {
      const item = provider.getTreeItem({ type: 'newDomain', layer: 'gold' });

      expect(item.label).toBe('New Domain...');
      expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
      expect(item.contextValue).toBe('newDomain');
      expect(item.command).toEqual({
        command: 'dbtSemantic.createDomain',
        title: 'Create Domain',
        arguments: ['gold'],
      });
    });

    it('sets tooltip on domain items', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'work-lots', layer: 'silver', filePath: '/test.json' },
        modelCount: 2,
        designCount: 1,
      };
      const item = provider.getTreeItem(element);

      expect(item.tooltip).toBe('Silver / work-lots');
    });
  });

  describe('refresh', () => {
    it('fires onDidChangeTreeData event', () => {
      let fired = false;
      provider.onDidChangeTreeData(() => {
        fired = true;
      });

      provider.refresh();
      expect(fired).toBe(true);
    });
  });
});
