// @vitest-environment jsdom
/**
 * Editor store error lifecycle (H03).
 *
 * A host `error` must not be wiped by unrelated UI actions (it is shown as a
 * toast over the live canvas until dismissed), must be clearable via
 * setError(null) (toast dismiss), and must auto-clear when a fresh domain
 * payload arrives (setDomain — domainLoaded / domainUpdated / stageData).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../../webview/store/editorStore';
import type { DisplayDomain } from '../../src/types/display';

const domain: DisplayDomain = {
  schemaVersion: 4,
  domain: 'orders',
  layer: 'silver',
  stage: 'logical',
  description: '',
  models: [],
  relationships: [],
  viewConfig: {},
  readOnly: false,
  positionDraggable: true,
} as DisplayDomain;

beforeEach(() => {
  useEditorStore.setState({ domain: null, error: null });
});

describe('editorStore error lifecycle', () => {
  it('keeps the domain when an error is set (canvas stays mounted)', () => {
    const s = useEditorStore.getState();
    s.setDomain(domain);
    s.setError('Failed to rename model: EACCES');
    expect(useEditorStore.getState().domain).toBe(domain);
    expect(useEditorStore.getState().error).toBe('Failed to rename model: EACCES');
  });

  it('setError(null) clears the error (toast dismiss)', () => {
    const s = useEditorStore.getState();
    s.setDomain(domain);
    s.setError('boom');
    s.setError(null);
    expect(useEditorStore.getState().error).toBeNull();
    expect(useEditorStore.getState().domain).toBe(domain);
  });

  it('a subsequent domain payload clears the error', () => {
    const s = useEditorStore.getState();
    s.setDomain(domain);
    s.setError('boom');
    s.setDomain({ ...domain, description: 'reloaded' });
    expect(useEditorStore.getState().error).toBeNull();
    expect(useEditorStore.getState().domain?.description).toBe('reloaded');
  });

  it('unrelated selection changes do not clear the error', () => {
    const s = useEditorStore.getState();
    s.setDomain(domain);
    s.setError('boom');
    s.selectNode('x');
    s.setDetailPanelOpen(true);
    s.setSelectedEdges(['e1']);
    expect(useEditorStore.getState().error).toBe('boom');
  });
});
