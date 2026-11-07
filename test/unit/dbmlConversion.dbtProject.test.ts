/**
 * Convert Project to DBML end to end on a copy of the dbt-project fixture
 * (minus `gold/finance.json`), through the host's own services (native DBML
 * storage §9.6): planned, written, and every diagram drawn by
 * `SubjectAreaService` before and after compares equal through the one
 * storage-equivalence comparator; every DBML file compiles in 9.1.1, 10.3.1
 * and 11.0.0.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as v9 from 'dbml-parse-v9';
import * as v10 from 'dbml-parse-v10';

import { dbmlTreePathOf, normaliseForStorageEquivalence } from '@erd-studio/core';
import { compileDbmlProject } from '@erd-studio/core/dbml';
import type { DbmlParserModule } from '@erd-studio/core/dbml';

import { planDbmlConversion } from '../../src/services/dbmlConversion';
import type { DbmlConversionPlan } from '../../src/services/dbmlConversion';
import { readDbmlConversionInput } from '../../src/services/dbmlConversionFiles';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { buildLogicalDisplaySubjectArea } from '../../src/services/stageDisplay';

const FIXTURE = path.resolve(__dirname, '../fixtures/dbt-project/.erd-studio');

let root: string;
let erd: string;
let plan: DbmlConversionPlan;
const before = new Map<string, unknown>();
const after = new Map<string, unknown>();

/** Every diagram's display as the canvas draws it, keyed by its path relative to the semantic dir without the extension. */
function displays(): Map<string, unknown> {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const out = new Map<string, unknown>();
  for (const s of subjectAreaService.listSubjectAreas(root, '.erd-studio')) {
    const unified = subjectAreaService.getSubjectArea(s.filePath);
    const display = buildLogicalDisplaySubjectArea(SubjectAreaService.toLogicalStage(unified), unified.viewConfig, unified.stubColumns);
    const key = path.relative(erd, s.filePath).split(path.sep).join('/').replace(/\.(json|dbml)$/, '');
    out.set(key, JSON.parse(JSON.stringify(display)));
  }
  return out;
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-convert-dbt-'));
  erd = path.join(root, '.erd-studio');
  fs.cpSync(FIXTURE, erd, { recursive: true });
  fs.rmSync(path.join(erd, 'gold', 'finance.json'));
  for (const [k, v] of displays()) before.set(k, v);
  plan = await planDbmlConversion(readDbmlConversionInput(root, '.erd-studio'));
  for (const c of plan.creates) {
    fs.mkdirSync(path.dirname(path.join(erd, c.path)), { recursive: true });
    fs.writeFileSync(path.join(erd, c.path), c.text);
  }
  for (const r of plan.replaces) fs.writeFileSync(path.join(erd, r.path), r.text);
  for (const d of plan.deletes) fs.rmSync(path.join(erd, d));
  fs.rmSync(path.join(erd, 'logical-models'), { recursive: true, force: true });
  for (const [k, v] of displays()) after.set(k, v);
}, 60_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Convert Project to DBML on the dbt-project fixture', () => {
  it('plans without a refusal, converting every table and diagram', () => {
    expect(plan.refusals).toEqual([]);
    expect(plan.summary.tables).toBe(9);
    expect(plan.summary.diagrams).toBe(6);
    expect(plan.deletes.filter((d) => d.endsWith('.yml'))).toHaveLength(9);
    expect(plan.deletes.filter((d) => d.endsWith('.json')).sort()).toEqual([
      'silver/bob.json', 'silver/ncr.json', 'silver/scroll-test.json', 'silver/sdd.json', 'silver/showcase.json', 'silver/ttt.json',
    ]);
    // showcase.json's relationships move to the library; no other diagram holds both ends of one.
    expect(plan.movedRelationships.length).toBeGreaterThan(0);
    expect(plan.movedRelationships.every((m) => m.diagrams.length === 0)).toBe(true);
  });

  it('leaves only DBML storage behind (templates/ and layers.json untouched)', () => {
    const left: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else left.push(path.relative(erd, p).split(path.sep).join('/'));
      }
    };
    walk(erd);
    expect(left.filter((p) => p.endsWith('.yml'))).toEqual([]);
    // Every DBML file is in the layer-first tree, and the folder has its README.
    expect(left.filter((p) => p.endsWith('.dbml')).every((p) => /^[a-z]+\/(tables\/[^/]+|relationships|diagrams)\/[^/]+\.dbml$/.test(p))).toBe(true);
    expect(left).toContain('README.md');
    expect(left.filter((p) => p.endsWith('.json')).sort()).toEqual([
      '.sync-plan.json', 'layers.json', 'templates/blank.json', 'templates/bridge.json', 'templates/dimension.json', 'templates/fact.json', 'templates/scd2.json',
    ]);
    expect(fs.readFileSync(path.join(erd, 'layers.json'), 'utf-8')).toBe(fs.readFileSync(path.join(FIXTURE, 'layers.json'), 'utf-8'));
  });

  it('draws every diagram as before, through the storage-equivalence comparator', () => {
    // Each diagram is now <layer>/diagrams/<name>.dbml (plan.targets), and each table has the schema of its folder.
    const stem = (p: string): string => p.replace(/\.(json|dbml|yml)$/, '');
    const moved = new Map(plan.targets.filter((t) => t.source.endsWith('.json')).map((t) => [stem(t.source), stem(t.target)]));
    expect([...after.keys()].sort()).toEqual([...before.keys()].map((k) => moved.get(k) ?? k).sort());
    expect([...after.keys()].every((k) => /^[a-z]+\/diagrams\//.test(k))).toBe(true);
    const schemaOf = new Map(plan.targets.filter((t) => t.source.endsWith('.yml')).map((t) => [path.posix.basename(stem(t.target)).toLowerCase(), dbmlTreePathOf(t.target)!.schema]));
    const schemaFallback = (name: string): string | undefined => schemaOf.get(name.toLowerCase());
    for (const [key, was] of before) {
      const now = after.get(moved.get(key) ?? key);
      expect(normaliseForStorageEquivalence(now, { convert: true, schemaFallback }), key).toEqual(normaliseForStorageEquivalence(was, { convert: true, schemaFallback }));
    }
  });

  it.each([
    ['9.1.1', v9 as unknown as DbmlParserModule],
    ['10.3.1', v10 as unknown as DbmlParserModule],
    ['11.0.0', undefined],
  ])('every DBML file compiles with no errors in %s', (_label, parser) => {
    const files: Record<string, string> = {};
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.dbml')) files[path.relative(erd, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf-8');
      }
    };
    walk(erd);
    expect(Object.keys(files).length).toBeGreaterThan(10);
    const result = compileDbmlProject(files, Object.keys(files), parser);
    expect(Object.entries(result).flatMap(([file, list]) => list.map((d) => `${file}:${d.line} ${d.message}`))).toEqual([]);
  });

  it('a second plan has nothing to do', async () => {
    const again = await planDbmlConversion(readDbmlConversionInput(root, '.erd-studio'));
    expect(again.refusals).toEqual([]);
    expect([...again.creates, ...again.replaces, ...again.deletes]).toEqual([]);
  });
});
