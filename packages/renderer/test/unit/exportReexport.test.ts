// @vitest-environment jsdom
/**
 * The viewer entry (`@erd-studio/renderer`) re-exports core's diagram export
 * API, so a page that depends only on the renderer can offer Mermaid and DBML
 * downloads (rich DBML carries its positions in the Project's `erd_layout`). They must be core's own functions, not copies.
 */
import { describe, it, expect } from 'vitest';
import * as core from '@erd-studio/core';
import * as renderer from '../../src/index';

describe('renderer entry re-exports the diagram export API', () => {
  it.each([
    'toMermaid',
    'toDbml',
    'toDbmlRich',
    'DBML_RICH_EXPORT_HEADER',
    'exportDiagram',
    'diagramExportFileName',
    'DIAGRAM_EXPORT_FORMATS',
    'DIAGRAM_EXPORT_FILE_EXTENSIONS',
  ] as const)(
    '%s is core\'s own',
    (name) => {
      expect(renderer[name]).toBeDefined();
      expect(renderer[name]).toBe(core[name]);
    },
  );

  it('exports a DisplaySubjectArea the viewer renders', () => {
    const domain: core.DisplaySubjectArea = {
      schemaVersion: 5,
      domain: 'viewer',
      layer: 'gold',
      stage: 'logical',
      description: '',
      models: [{ name: 'a', schema: '', description: '', columns: [{ name: 'id', dataType: 'int', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false }] }],
      relationships: [],
      viewConfig: {},
      readOnly: true,
      positionDraggable: false,
    };
    for (const format of renderer.DIAGRAM_EXPORT_FORMATS) {
      // DBML opens with its version line; Mermaid with `erDiagram`, then its version line.
      const lines = renderer.exportDiagram(domain, format).split('\n');
      const expected = {
        mermaid: ['erDiagram', '%% erd-studio mermaid-export v1'],
        dbml: ['// erd-studio dbml-export v1'],
        'dbml-rich': [renderer.DBML_RICH_EXPORT_HEADER],
      }[format];
      expect(lines.slice(0, expected.length)).toEqual(expected);
      expect(renderer.diagramExportFileName(domain, format)).toBe(`viewer.${renderer.DIAGRAM_EXPORT_FILE_EXTENSIONS[format]}`);
    }
  });

  it('no longer re-exports the dbdiagram.io layout file helpers', () => {
    for (const gone of ['toDbdiagramLayout', 'serializeDbdiagramLayout', 'dbdiagramLayoutFileName']) {
      expect(renderer, gone).not.toHaveProperty(gone);
    }
  });
});
