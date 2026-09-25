/**
 * `.erd-studio/modelling-approach.md` is free-form team notes written by the
 * `/erd-studio-setup` guide (or by hand) and read by AI assistants. The
 * extension must never treat it as a domain, a layer or a layer config:
 * these tests pin every place that walks the semantic directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { classifySemanticPath } from '../../src/watchers/FileWatcherService';
import { LayerService } from '../../src/services/layerService';
import { DomainService } from '../../src/services/domainService';
import { LogicalModelService } from '../../src/services/logicalModelService';

const REPO_ROOT = path.resolve(__dirname, '../..');
const APPROACH = '# How we model\n\nKimball dimensional modelling.\n\n- Facts at the lowest grain\n';

let tmp: string;
let root: string;
let semantic: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-approach-'));
  root = path.join(tmp, 'project');
  fs.cpSync(path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project'), root, { recursive: true });
  semantic = path.join(root, '.erd-studio');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('.erd-studio/modelling-approach.md is ignored by the extension', () => {
  it('the watcher classifies it as neither a domain nor the layer config', () => {
    expect(classifySemanticPath(semantic, path.join(semantic, 'modelling-approach.md'))).toBe('other');
  });

  it('the semantic-file watcher glob (**/*.json) and the custom editor selector cannot match it', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    const selectors = (pkg.contributes.customEditors[0].selector as Array<{ filenamePattern: string }>).map((s) => s.filenamePattern);
    for (const pattern of selectors) {
      expect(pattern.endsWith('/*/*.json'), pattern).toBe(true);
    }
    const watcher = fs.readFileSync(path.join(REPO_ROOT, 'src', 'watchers', 'FileWatcherService.ts'), 'utf-8');
    expect(watcher).toContain('`${this.semanticDir}/**/*.json`');
  });

  it('adds no layer, domain or model, with or without layers.json', () => {
    const layerService = new LayerService(root, '.erd-studio');
    const domainService = new DomainService(layerService);
    domainService.setLogicalModelService(new LogicalModelService(root, '.erd-studio'));
    const layersBefore = layerService.detectLayersFromFilesystem().map((l) => l.id);
    const domainsBefore = domainService.listDomains(root, '.erd-studio');
    expect(domainsBefore.length).toBeGreaterThan(0);

    fs.writeFileSync(path.join(semantic, 'modelling-approach.md'), APPROACH);

    const layers = new LayerService(root, '.erd-studio');
    const domains = new DomainService(layers);
    domains.setLogicalModelService(new LogicalModelService(root, '.erd-studio'));
    expect(layers.detectLayersFromFilesystem().map((l) => l.id)).toEqual(layersBefore);
    expect(domains.listDomains(root, '.erd-studio')).toEqual(domainsBefore);
    expect(layers.getLoadError()).toBeNull();

    // Without layers.json the filesystem scan decides the layers: still only directories.
    fs.rmSync(path.join(semantic, 'layers.json'), { force: true });
    const scanned = new LayerService(root, '.erd-studio');
    expect(scanned.detectLayersFromFilesystem().map((l) => l.id)).not.toContain('modelling-approach.md');
    expect(scanned.detectLayersFromFilesystem().map((l) => l.id)).not.toContain('modelling-approach');
  });

  it('is not listed as a logical model', () => {
    fs.writeFileSync(path.join(semantic, 'modelling-approach.md'), APPROACH);
    const models = new LogicalModelService(root, '.erd-studio');
    const names = models.listModelNames();
    expect(names).not.toContain('modelling-approach');
    expect(names.every((n) => /^[a-z][a-z0-9_]*$/.test(n))).toBe(true);
  });
});
