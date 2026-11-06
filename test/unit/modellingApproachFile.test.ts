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
import { SubjectAreaService } from '../../src/services/domainService';
import { TableLibraryService } from '../../src/services/logicalModelService';

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

  it('the semantic-file watcher glob (**/*.{json,dbml}) and the custom editor selector cannot match it', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    const selectors = (pkg.contributes.customEditors[0].selector as Array<{ filenamePattern: string }>).map((s) => s.filenamePattern);
    for (const pattern of selectors) {
      expect(pattern.endsWith('/*/*.json') || pattern.endsWith('/*/diagrams/*.dbml'), pattern).toBe(true);
    }
    const watcher = fs.readFileSync(path.join(REPO_ROOT, 'src', 'watchers', 'FileWatcherService.ts'), 'utf-8');
    expect(watcher).toContain('`${this.semanticDir}/**/*.{json,dbml}`');
  });

  it('adds no layer, domain or model, with or without layers.json', () => {
    const layerService = new LayerService(root, '.erd-studio');
    const subjectAreaService = new SubjectAreaService(layerService);
    subjectAreaService.setTableLibraryService(new TableLibraryService(root, '.erd-studio'));
    const layersBefore = layerService.detectLayersFromFilesystem().map((l) => l.id);
    const domainsBefore = subjectAreaService.listSubjectAreas(root, '.erd-studio');
    expect(domainsBefore.length).toBeGreaterThan(0);

    fs.writeFileSync(path.join(semantic, 'modelling-approach.md'), APPROACH);

    const layers = new LayerService(root, '.erd-studio');
    const domains = new SubjectAreaService(layers);
    domains.setTableLibraryService(new TableLibraryService(root, '.erd-studio'));
    expect(layers.detectLayersFromFilesystem().map((l) => l.id)).toEqual(layersBefore);
    expect(domains.listSubjectAreas(root, '.erd-studio')).toEqual(domainsBefore);
    expect(layers.getLoadError()).toBeNull();

    // Without layers.json the filesystem scan decides the layers: still only directories.
    fs.rmSync(path.join(semantic, 'layers.json'), { force: true });
    const scanned = new LayerService(root, '.erd-studio');
    expect(scanned.detectLayersFromFilesystem().map((l) => l.id)).not.toContain('modelling-approach.md');
    expect(scanned.detectLayersFromFilesystem().map((l) => l.id)).not.toContain('modelling-approach');
  });

  it('is not listed as a logical model', () => {
    fs.writeFileSync(path.join(semantic, 'modelling-approach.md'), APPROACH);
    const models = new TableLibraryService(root, '.erd-studio');
    const names = models.listTableNames();
    expect(names).not.toContain('modelling-approach');
    expect(names.every((n) => /^[a-z][a-z0-9_]*$/.test(n))).toBe(true);
  });
});

/**
 * `.erd-studio/fields.yml` (v46) sits beside `modelling-approach.md` and is
 * the file the setup guide writes for the team's field list. ERD Studio reads
 * it as the field list only: it is never a layer, a diagram or a table.
 */
describe('.erd-studio/fields.yml is never a layer, diagram or table', () => {
  const FIELDS = 'version: 1\ntables:\n  - grain\n  - key: owner\n    label: Owner\n    type: value\ncolumns:\n  - natural_key\n';

  it('adds no layer, domain or model, with or without layers.json', () => {
    const layerService = new LayerService(root, '.erd-studio');
    const subjectAreaService = new SubjectAreaService(layerService);
    subjectAreaService.setTableLibraryService(new TableLibraryService(root, '.erd-studio'));
    const layersBefore = layerService.detectLayersFromFilesystem().map((l) => l.id);
    const domainsBefore = subjectAreaService.listSubjectAreas(root, '.erd-studio');

    fs.writeFileSync(path.join(semantic, 'fields.yml'), FIELDS);

    const layers = new LayerService(root, '.erd-studio');
    const domains = new SubjectAreaService(layers);
    domains.setTableLibraryService(new TableLibraryService(root, '.erd-studio'));
    expect(layers.detectLayersFromFilesystem().map((l) => l.id)).toEqual(layersBefore);
    expect(domains.listSubjectAreas(root, '.erd-studio')).toEqual(domainsBefore);
    expect(layers.getLoadError()).toBeNull();

    fs.rmSync(path.join(semantic, 'layers.json'), { force: true });
    const scanned = new LayerService(root, '.erd-studio').detectLayersFromFilesystem().map((l) => l.id);
    expect(scanned).not.toContain('fields.yml');
    expect(scanned).not.toContain('fields');
  });

  it('is not listed as a logical model', () => {
    fs.writeFileSync(path.join(semantic, 'fields.yml'), FIELDS);
    const names = new TableLibraryService(root, '.erd-studio').listTableNames();
    expect(names).not.toContain('fields');
  });

  it('is never classified as a diagram or the layer config by the watcher', () => {
    const kind = classifySemanticPath(semantic, path.join(semantic, 'fields.yml'));
    // The host may give the field list a kind of its own; it is never one of these.
    for (const other of ['domain', 'table', 'relationships', 'layer-config']) {
      expect(kind).not.toBe(other);
    }
  });
});
