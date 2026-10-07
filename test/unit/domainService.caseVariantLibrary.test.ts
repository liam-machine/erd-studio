/**
 * A library relationship naming a model this diagram does not hold is never
 * drawn against another model whose name differs only in case (#133 review):
 * the canvas (DomainService) resolves the end against the whole library
 * first, the way `checkRelationships` does, so the two always agree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { checkRelationships, loadDisplayDomain } from '@erd-studio/core';
import { DomainService } from '../../src/services/domainService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import type { LayerService } from '../../src/services/layerService';

describe('DomainService — case-variant model names in the library', () => {
  let root: string;
  let lms: LogicalModelService;
  let domains: DomainService;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-casevariant-'));
    lms = new LogicalModelService(root, '.erd-studio');
    const models = lms.getModelsDir();
    fs.mkdirSync(path.join(models, 'silver'), { recursive: true });
    fs.mkdirSync(path.join(models, 'gold'), { recursive: true });
    fs.writeFileSync(path.join(models, 'silver', 'Dd.yml'), 'name: Dd\ncolumns:\n  - { name: id, dataType: INT, isPrimaryKey: true }\n');
    fs.writeFileSync(path.join(models, 'gold', 'DD.yml'), 'name: DD\ncolumns:\n  - { name: id, dataType: INT, isPrimaryKey: true }\n');
    fs.writeFileSync(path.join(models, 'gold', 'g.yml'), [
      'name: g',
      'columns:',
      '  - { name: d, dataType: INT }',
      'relationships:',
      '  - { fromColumn: d, toModel: Dd, toColumn: id, cardinality: many-to-one }',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(root, '.erd-studio', 'gold'), { recursive: true });
    fs.writeFileSync(path.join(root, '.erd-studio', 'gold', 'x.json'), JSON.stringify({
      schemaVersion: 5, domain: 'x', layer: 'gold', logical: { models: ['DD', 'g'], relationships: [] }, viewConfig: {},
    }));
    const layers = { hasLayer: () => true, getValidLayerIds: () => ['gold', 'silver'] } as unknown as LayerService;
    domains = new DomainService(layers);
    domains.setLogicalModelService(lms);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('does not draw g → Dd against DD, and check agrees there is nothing wrong', () => {
    const unified = domains.getDomain(path.join(root, '.erd-studio', 'gold', 'x.json'));
    expect(unified.logical.relationships).toEqual([]);
    const { libraryModels } = lms.relationshipCheckModels();
    const findings = checkRelationships({
      libraryModels,
      domains: [{ label: 'gold/x', filePath: 'gold/x.json', models: ['DD', 'g'], relationships: [], mode: 'library' }],
    });
    expect(findings).toEqual([]);
  });

  it('the read-only viewer draws exactly what the canvas draws from the same files', async () => {
    const semantic = path.join(root, '.erd-studio');
    const readFile = async (p: string): Promise<string | null> => {
      try {
        return fs.readFileSync(path.join(semantic, p), 'utf-8');
      } catch {
        return null;
      }
    };
    const viewer = await loadDisplayDomain({ domainPath: 'gold/x.json', readFile, readOnly: true, warn: () => {} });
    const unified = domains.getDomain(path.join(semantic, 'gold', 'x.json'));
    expect(viewer.relationships).toEqual([]);
    expect(viewer.relationships.length).toBe(unified.logical.relationships.length);
  });

  it('both still draw a respelled target when no model of that exact name exists', async () => {
    fs.rmSync(path.join(lms.getModelsDir(), 'silver', 'Dd.yml'));
    const semantic = path.join(root, '.erd-studio');
    const readFile = async (p: string): Promise<string | null> => {
      try {
        return fs.readFileSync(path.join(semantic, p), 'utf-8');
      } catch {
        return null;
      }
    };
    const viewer = await loadDisplayDomain({ domainPath: 'gold/x.json', readFile, readOnly: true, warn: () => {} });
    const unified = domains.getDomain(path.join(semantic, 'gold', 'x.json'));
    expect(unified.logical.relationships.map((r) => `${r.fromModel}.${r.fromColumn}->${r.toModel}.${r.toColumn}`)).toEqual(['g.d->DD.id']);
    expect(viewer.relationships.map((r) => `${r.fromModel}.${r.fromColumn}->${r.toModel}.${r.toColumn}`)).toEqual(['g.d->DD.id']);
  });
});
