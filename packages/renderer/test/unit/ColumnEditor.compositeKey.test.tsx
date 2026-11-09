// @vitest-environment jsdom
/**
 * A composite primary key (two or more PK columns, `indexes { (a, b) [pk] }`)
 * is one key, never a fault: the detail panel shows no "Multiple primary
 * keys detected" warning on its columns (dbml-qut-workbench Bug 1), in the
 * editor and the viewer alike. And a long type (`SET(…)`, `character
 * varying(255)`, a computed expression) is cut with an ellipsis rather than
 * squeezing the column name out (cross/9c), from the panel's own stylesheet.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { CanvasEditMessage, DisplaySubjectArea } from '@erd-studio/core';
import { createCanvasStore, CanvasStoreProvider } from '../../src/store/editorStore';
import { CanvasEnvironmentProvider } from '../../src/host/canvasEnvironment';
import { DetailPanel } from '../../src/components/DetailPanel/DetailPanel';

afterEach(cleanup);

const col = (name: string, isPrimaryKey: boolean, dataType = 'bigint') => ({ name, dataType, description: '', isPrimaryKey, isForeignKey: false, isNaturalKey: false });

function renderPanel(pkColumns: number, viewer: boolean, readOnly = false) {
  const columns = [
    ...Array.from({ length: pkColumns }, (_, i) => col(`key_${i + 1}`, true)),
    col('status', false, "SET('new','queued','working','finished','failed','cancelled','timed_out')"),
  ];
  const domain = {
    schemaVersion: 7, domain: 'jobs', layer: 'main', stage: 'logical', description: '', viewConfig: {},
    readOnly, positionDraggable: true,
    models: [{ name: 'analysis_jobs_scripts', schema: 'main', description: '', columns }],
    relationships: [],
  } as unknown as DisplaySubjectArea;
  const host = { postMessage: vi.fn((_m: CanvasEditMessage) => {}) };
  const store = createCanvasStore({ domain, selectedNode: 'analysis_jobs_scripts', detailPanelOpen: true });
  return render(
    <CanvasStoreProvider store={store}>
      <CanvasEnvironmentProvider host={host} viewer={viewer}>
        <ReactFlowProvider><DetailPanel /></ReactFlowProvider>
      </CanvasEnvironmentProvider>
    </CanvasStoreProvider>,
  );
}

describe('a composite primary key in the detail panel', () => {
  it.each([[2, false], [3, false], [2, true]])('%i key columns (viewer: %s): no "multiple primary keys" warning', (pkColumns, viewer) => {
    const { container } = renderPanel(pkColumns, viewer);
    expect(container.querySelector('.key-badge-group__warning')).toBeNull();
    expect(container.innerHTML).not.toContain('Multiple primary keys');
    // The key columns are still shown, each with its PK badge.
    expect(container.textContent).toContain('key_1');
    expect(container.textContent).toContain('key_2');
  });

  it('one key column: no warning either (as before)', () => {
    const { container } = renderPanel(1, false);
    expect(container.querySelector('.key-badge-group__warning')).toBeNull();
  });
});

describe('long types in a narrow detail panel', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../src/components/DetailPanel/ColumnEditor.css'), 'utf-8');
  const rule = (selector: string): string => {
    const at = css.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf('}', at));
  };

  it('the column name keeps a minimum width and the type is cut with an ellipsis', () => {
    expect(rule('.column-editor .column-row-editor__name')).toMatch(/min-width:\s*min\(/);
    const type = rule('.column-editor .column-row-editor__type');
    expect(type).toMatch(/text-overflow:\s*ellipsis/);
    expect(type).toMatch(/white-space:\s*nowrap/);
    expect(type).toMatch(/min-width:\s*0/);
    expect(type).toMatch(/flex:\s*0 1 auto/);
  });

  it.each([[false, 'editor'], [true, 'read-only view']])('the cut type shows whole as its tooltip (read-only: %s, %s), with the edit hint only where it can be edited', (readOnly) => {
    const { container } = renderPanel(1, readOnly, readOnly);
    const long = [...container.querySelectorAll('.column-row-editor__type')].find((t) => t.textContent?.startsWith('SET('));
    expect(long).toBeDefined();
    const full = "SET('new','queued','working','finished','failed','cancelled','timed_out')";
    expect(long!.getAttribute('title')).toBe(readOnly ? full : `${full} — double-click to edit`);
  });

  it('adds no colour of its own (light and dark themes come from the theme variables)', () => {
    const added = css.slice(css.indexOf('Long types in a narrow panel'));
    expect(added).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
