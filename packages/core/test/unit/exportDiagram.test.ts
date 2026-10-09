/**
 * The diagram export API: the format list, the dispatcher, file names, and
 * the promise that exporting adds no runtime dependency to core.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import * as core from '../../src/index';
import {
  DIAGRAM_EXPORT_FILE_EXTENSIONS,
  DIAGRAM_EXPORT_FORMATS,
  diagramExportFileName,
  exportDiagram,
  toDbml,
  toMermaid,
  type DiagramExportFormat,
} from '../../src/exportDiagram';
import { RATIONALE_KEYS } from '../../src/logicalModel';
import { RATIONALE_LABELS } from '../../src/exportShared';
import type { DisplayDomain } from '../../src/types/display';
import { DBML_PARSERS, MERMAID_PARSERS, col, domain, model, rel } from '../exportParsers';

describe('diagram export API', () => {
  it('is exported from the package entry', () => {
    expect(core.toDbml).toBe(toDbml);
    expect(core.toMermaid).toBe(toMermaid);
    expect(core.exportDiagram).toBe(exportDiagram);
    expect(core.diagramExportFileName).toBe(diagramExportFileName);
    expect(core.DIAGRAM_EXPORT_FORMATS).toEqual(['mermaid', 'dbml']);
    expect(core.DIAGRAM_EXPORT_FILE_EXTENSIONS).toEqual({ mermaid: 'mmd', dbml: 'dbml' });
  });

  it('keeps its constants frozen', () => {
    expect(Object.isFrozen(DIAGRAM_EXPORT_FORMATS)).toBe(true);
    expect(Object.isFrozen(DIAGRAM_EXPORT_FILE_EXTENSIONS)).toBe(true);
  });

  it('dispatches to the format functions', () => {
    const d = domain([model('a', [col('id')]), model('b', [col('a_id')])], [rel('b.a_id', 'a.id')]);
    expect(exportDiagram(d, 'dbml')).toBe(toDbml(d));
    expect(exportDiagram(d, 'mermaid')).toBe(toMermaid(d));
    expect(() => exportDiagram(d, 'svg' as DiagramExportFormat)).toThrow('Unknown diagram export format: svg');
  });

  it('exports a DisplayDomain carrying only its required fields in every format', () => {
    const minimal: DisplayDomain = {
      schemaVersion: 5,
      domain: 'minimal',
      layer: 'silver',
      stage: 'logical',
      description: '',
      models: [{ name: 'a', schema: '', description: '', columns: [] }],
      relationships: [{ fromModel: 'a', fromColumn: 'x', toModel: 'b', toColumn: 'y', cardinality: 'many-to-one' }],
      viewConfig: {},
      readOnly: false,
      positionDraggable: true,
    };
    for (const format of DIAGRAM_EXPORT_FORMATS) {
      expect(() => exportDiagram(minimal, format)).not.toThrow();
    }
  });

  it('leaves positions out of every format', () => {
    const d = domain([model('a', [col('id')])], [], { viewConfig: { positions: { a: { x: 123456, y: 654321 } } } });
    for (const format of DIAGRAM_EXPORT_FORMATS) {
      const text = exportDiagram(d, format);
      expect(text).not.toContain('123456');
      expect(text).not.toContain('654321');
    }
  });

  it.each([
    ['showcase', 'dbml', 'showcase.dbml'],
    ['showcase', 'mermaid', 'showcase.mmd'],
    ['customer 360', 'dbml', 'customer 360.dbml'],
    ['a/b\\c:d*e?f"g<h>i|j', 'mermaid', 'a-b-c-d-e-f-g-h-i-j.mmd'],
    ['line\nbreak', 'dbml', 'line-break.dbml'],
    ['..hidden..', 'dbml', 'hidden.dbml'],
    ['', 'dbml', 'diagram.dbml'],
    ['...', 'mermaid', 'diagram.mmd'],
    ['CON', 'dbml', 'CON-diagram.dbml'],
    ['lpt1', 'mermaid', 'lpt1-diagram.mmd'],
    // Windows reserves the name whatever extension follows it.
    ['con.txt', 'dbml', 'con-diagram.txt.dbml'],
    ['NUL.tar.gz', 'mermaid', 'NUL-diagram.tar.gz.mmd'],
    ['console', 'dbml', 'console.dbml'],
    ['日本', 'dbml', '日本.dbml'],
  ] as const)('names the export of %j as %s → %s', (name, format, expected) => {
    expect(diagramExportFileName({ domain: name }, format)).toBe(expected);
  });

  it('caps the file name length and tolerates a missing name', () => {
    expect(diagramExportFileName({ domain: 'x'.repeat(300) }, 'dbml')).toBe(`${'x'.repeat(100)}.dbml`);
    expect(diagramExportFileName({} as Pick<DisplayDomain, 'domain'>, 'dbml')).toBe('diagram.dbml');
  });

  it('gives an unknown format, even an inherited property name, the txt extension', () => {
    for (const format of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'bogus']) {
      expect(diagramExportFileName({ domain: 'sales' }, format as DiagramExportFormat)).toBe('sales.txt');
    }
  });

  it('keeps the rationale labels in step with the rationale keys', () => {
    expect(RATIONALE_LABELS.map(([key]) => key)).toEqual([...RATIONALE_KEYS]);
  });

  it('adds no runtime dependency: core still depends on yaml alone', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['yaml']);
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
  });

  it('tests against exact parser versions, old and current, kept as devDependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')) as {
      devDependencies: Record<string, string>;
    };
    const parsers: Record<string, string> = {
      '@dbml/parse': '10.2.0',
      'dbml-core-v3': 'npm:@dbml/core@3.13.4',
      'dbml-core-v2': 'npm:@dbml/core@2.6.1',
      'dbml-core-v24': 'npm:@dbml/core@2.4.2',
      mermaid: '10.0.0',
      'mermaid-current': 'npm:mermaid@12.0.0',
      jsdom: '25.0.1',
    };
    for (const [name, version] of Object.entries(parsers)) expect(pkg.devDependencies[name], name).toBe(version);
    // The labels the harness reports name the same versions.
    const versionOf = (spec: string): string => spec.replace(/^npm:.+@/, '');
    expect(DBML_PARSERS).toEqual([
      `@dbml/parse ${parsers['@dbml/parse']}`,
      `@dbml/core ${versionOf(parsers['dbml-core-v3'])}`,
      `@dbml/core ${versionOf(parsers['dbml-core-v2'])}`,
      `@dbml/core ${versionOf(parsers['dbml-core-v24'])}`,
    ]);
    expect(MERMAID_PARSERS).toEqual([`mermaid ${parsers.mermaid}`, `mermaid ${versionOf(parsers['mermaid-current'])}`]);
  });

  it('imports nothing outside core in the export sources', () => {
    const src = path.resolve(__dirname, '../../src');
    for (const file of ['exportDiagram.ts', 'exportDbml.ts', 'exportMermaid.ts', 'exportShared.ts']) {
      const text = fs.readFileSync(path.join(src, file), 'utf-8');
      const specs = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(specs.filter((s) => !s.startsWith('./')), file).toEqual([]);
    }
  });
});
