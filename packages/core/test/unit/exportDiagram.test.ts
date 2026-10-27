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
  toDbmlRich,
  toMermaid,
  type DiagramExportFormat,
} from '../../src/exportDiagram';
import { dbdiagramLayoutFileName, readDbdiagramLayout, serializeDbdiagramLayout, toDbdiagramLayout } from '../../src/dbdiagramLayout';
import { RATIONALE_KEYS } from '../../src/logicalModel';
import { RATIONALE_LABELS } from '../../src/exportShared';
import type { DisplaySubjectArea } from '../../src/types/display';
import { DBML_PARSERS, MERMAID_PARSERS, RICH_DBML_PARSERS, col, subjectArea, tableDef, rel } from '../exportParsers';

describe('diagram export API', () => {
  it('is exported from the package entry', () => {
    expect(core.toDbml).toBe(toDbml);
    expect(core.toMermaid).toBe(toMermaid);
    expect(core.toDbmlRich).toBe(toDbmlRich);
    expect(core.exportDiagram).toBe(exportDiagram);
    expect(core.diagramExportFileName).toBe(diagramExportFileName);
    expect(core.toDbdiagramLayout).toBe(toDbdiagramLayout);
    expect(core.serializeDbdiagramLayout).toBe(serializeDbdiagramLayout);
    expect(core.dbdiagramLayoutFileName).toBe(dbdiagramLayoutFileName);
    expect(core.readDbdiagramLayout).toBe(readDbdiagramLayout);
    expect(core.DBML_RICH_EXPORT_HEADER).toMatch(/^\/\/ erd-studio dbml-export v2/);
    expect(core.DIAGRAM_EXPORT_FORMATS).toEqual(['mermaid', 'dbml', 'dbml-rich']);
    expect(core.DIAGRAM_EXPORT_FILE_EXTENSIONS).toEqual({ mermaid: 'mmd', dbml: 'dbml', 'dbml-rich': 'dbml' });
  });

  it('keeps its constants frozen', () => {
    expect(Object.isFrozen(DIAGRAM_EXPORT_FORMATS)).toBe(true);
    expect(Object.isFrozen(DIAGRAM_EXPORT_FILE_EXTENSIONS)).toBe(true);
  });

  it('dispatches to the format functions', () => {
    const d = subjectArea([tableDef('a', [col('id')]), tableDef('b', [col('a_id')])], [rel('b.a_id', 'a.id')]);
    expect(exportDiagram(d, 'dbml')).toBe(toDbml(d));
    expect(exportDiagram(d, 'mermaid')).toBe(toMermaid(d));
    expect(exportDiagram(d, 'dbml-rich')).toBe(toDbmlRich(d));
    expect(exportDiagram(d, 'dbml-rich')).toBe(toDbmlRich(d, { layoutFileName: dbdiagramLayoutFileName(d) }));
    expect(() => exportDiagram(d, 'svg' as DiagramExportFormat)).toThrow('Unknown diagram export format: svg');
  });

  it('exports a DisplaySubjectArea carrying only its required fields in every format', () => {
    const minimal: DisplaySubjectArea = {
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
    const d = subjectArea([tableDef('a', [col('id')])], [], { viewConfig: { positions: { a: { x: 123456, y: 654321 } } } });
    for (const format of DIAGRAM_EXPORT_FORMATS) {
      const text = exportDiagram(d, format);
      expect(text).not.toContain('123456');
      expect(text).not.toContain('654321');
    }
  });

  it.each([
    ['showcase', 'dbml', 'showcase.dbml'],
    ['showcase', 'mermaid', 'showcase.mmd'],
    ['showcase', 'dbml-rich', 'showcase.dbml'],
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

  it.each(['showcase', 'customer 360', 'a/b\\c:d', '..hidden..', '', 'CON', 'con.txt', 'x'.repeat(300), '日本'])(
    'names the layout file of %j with the base of its rich DBML export',
    (name) => {
      const dbml = diagramExportFileName({ domain: name }, 'dbml-rich');
      expect(dbml.endsWith('.dbml')).toBe(true);
      expect(dbdiagramLayoutFileName({ domain: name })).toBe(`${dbml.slice(0, -'.dbml'.length)}.dbdiagram`);
    },
  );

  it('caps the file name length and tolerates a missing name', () => {
    expect(diagramExportFileName({ domain: 'x'.repeat(300) }, 'dbml')).toBe(`${'x'.repeat(100)}.dbml`);
    expect(diagramExportFileName({} as Pick<DisplaySubjectArea, 'domain'>, 'dbml')).toBe('diagram.dbml');
  });

  it('gives an unknown format, even an inherited property name, the txt extension', () => {
    for (const format of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'bogus']) {
      expect(diagramExportFileName({ domain: 'sales' }, format as DiagramExportFormat)).toBe('sales.txt');
    }
  });

  it('keeps the rationale labels in step with the rationale keys', () => {
    expect(RATIONALE_LABELS.map(([key]) => key)).toEqual([...RATIONALE_KEYS]);
  });

  it('depends at runtime on yaml and the pinned DBML parser alone (the parser only behind @erd-studio/core/dbml)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({ '@dbml/parse': '11.0.0', yaml: '^2.9.0' });
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
  });

  it('tests against exact parser versions, old and current, kept as devDependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')) as {
      devDependencies: Record<string, string>;
    };
    const pkgAll = pkg as { devDependencies: Record<string, string>; dependencies: Record<string, string> };
    // The pin itself is a runtime dependency (D13); 9.1.1 and 10.3.1 are test aliases.
    expect(pkgAll.dependencies['@dbml/parse']).toBe('11.0.0');
    expect(pkg.devDependencies['@dbml/parse']).toBeUndefined();
    expect(pkg.devDependencies['dbml-parse-v11']).toBeUndefined();
    const parsers: Record<string, string> = {
      'dbml-parse-v9': 'npm:@dbml/parse@9.1.1',
      'dbml-parse-v10': 'npm:@dbml/parse@10.3.1',
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
    const pinned = pkgAll.dependencies['@dbml/parse'];
    expect(DBML_PARSERS).toEqual([
      `@dbml/parse ${pinned}`,
      `@dbml/core ${versionOf(parsers['dbml-core-v3'])}`,
      `@dbml/core ${versionOf(parsers['dbml-core-v2'])}`,
      `@dbml/core ${versionOf(parsers['dbml-core-v24'])}`,
    ]);
    expect(RICH_DBML_PARSERS).toEqual([
      `@dbml/parse ${versionOf(parsers['dbml-parse-v9'])}`,
      `@dbml/parse ${versionOf(parsers['dbml-parse-v10'])}`,
      `@dbml/parse ${pinned}`,
    ]);
    expect(MERMAID_PARSERS).toEqual([`mermaid ${parsers.mermaid}`, `mermaid ${versionOf(parsers['mermaid-current'])}`]);
  });

  it('imports nothing outside core in the export sources', () => {
    const src = path.resolve(__dirname, '../../src');
    for (const file of ['exportDiagram.ts', 'exportDbml.ts', 'exportDbmlRich.ts', 'exportMermaid.ts', 'exportShared.ts', 'exportFileName.ts', 'dbdiagramLayout.ts', 'dbmlRichProperties.ts']) {
      const text = fs.readFileSync(path.join(src, file), 'utf-8');
      const specs = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(specs.filter((s) => !s.startsWith('./')), file).toEqual([]);
    }
  });
});
