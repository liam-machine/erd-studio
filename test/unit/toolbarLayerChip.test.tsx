// @vitest-environment jsdom
/**
 * The toolbar's layer chip names the diagram's layer as the table badges do:
 * "[GLD] Gold layer" — the abbreviation in a small badge, then the label. A
 * single-layer project has nothing to tell apart, so it shows no chip.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const mockPostMessage = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage: mockPostMessage, getState: vi.fn(), setState: vi.fn() }),
}));

vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useReactFlow: () => ({ zoomIn: vi.fn(), zoomOut: vi.fn(), fitView: vi.fn(), getNode: vi.fn() }),
  useStore: () => 1,
  useNodesInitialized: () => true,
}));

vi.mock('../../webview/components/Toolbar/StageTabs', () => ({
  StageTabs: () => <div data-testid="stage-tabs" />,
}));

const GOLD = { id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', order: 2, creatable: true };
const SILVER = { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', order: 1, creatable: true };

const noop = vi.fn();
const mockStoreState: Record<string, unknown> = {
  setDomain: vi.fn(),
  setNewModelDialogOpen: noop,
  setNewFkDialogOpen: noop,
  setAddExistingModelDialogOpen: noop,
  searchQuery: '',
  setSearchQuery: noop,
  selectNode: noop,
  setDetailPanelOpen: noop,
  registerSearchFocus: noop,
  registerAutoLayout: noop,
  pendingAutoLayout: false,
  setPendingAutoLayout: noop,
  discrepancyVisible: false,
  discrepancyCompareStage: null,
  setDiscrepancyVisible: noop,
  setDiscrepancyCompareStage: noop,
  setToastMessage: vi.fn(),
  setFeedbackDialogOpen: vi.fn(),
  logicalOnly: false,
};

vi.mock('../../webview/store/editorStore', () => ({
  useEditorStore: (selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

import { Toolbar } from '../../webview/components/Toolbar/Toolbar';

function renderToolbar(domain: Record<string, unknown>) {
  mockStoreState.domain = {
    domain: 'reporting',
    stage: 'logical',
    models: [{ name: 'fct_order', columns: [] }],
    relationships: [],
    viewConfig: { positions: {}, layoutOptions: {} },
    readOnly: false,
    ...domain,
  };
  return render(<Toolbar nodes={[]} edges={[]} />);
}

afterEach(cleanup);

describe('Toolbar layer chip', () => {
  it('pairs the abbreviation badge with the label: "[GLD] Gold layer"', () => {
    const { container } = renderToolbar({ layer: 'gold', layerConfig: GOLD, layerConfigs: [SILVER, GOLD] });
    const chip = container.querySelector('.toolbar__layer-badge')!;
    const abbrev = chip.querySelector('.toolbar__layer-abbrev') as HTMLElement;

    expect(abbrev.textContent).toBe('GLD');
    expect(abbrev.style.color).not.toBe('');
    expect(chip.textContent).toBe('GLDGold layer');
    // No folder named: a JSON diagram lives at `<layer>/<name>.json`, a DBML one in `<layer>/diagrams/`.
    expect(chip.getAttribute('title')).toBe('This diagram belongs to the Gold layer. It can show tables from any layer.');
  });

  it('falls back to the default layer\'s abbreviation and its id without a config', () => {
    const { container } = renderToolbar({ layer: 'silver' });
    const abbrev = container.querySelector('.toolbar__layer-abbrev')!;
    expect(abbrev.textContent).toBe('SLV');
    expect(abbrev.className).toContain('toolbar__layer-abbrev--silver');
    expect(container.querySelector('.toolbar__layer-badge')!.textContent).toBe('SLVsilver layer');
  });

  it('is left off in a single-layer project', () => {
    const { container } = renderToolbar({ layer: 'gold', layerConfig: GOLD, layerConfigs: [GOLD], models: [{ name: 'a', layer: 'gold', columns: [] }] });
    expect(container.querySelector('.toolbar__layer-badge')).toBeNull();
  });
});

describe('the Convert information button (#305)', () => {
  afterEach(() => { delete mockStoreState.convertOffer; });

  it('ends the identity island, after the layer chip, while the host says the project can be converted', () => {
    mockStoreState.convertOffer = true;
    const { container } = renderToolbar({ layer: 'gold', layerConfig: GOLD, layerConfigs: [SILVER, GOLD] });
    const domain = container.querySelector('.toolbar__island--identity .toolbar__domain')!;
    expect(domain.lastElementChild!.classList.contains('convert-info')).toBe(true);
    expect(domain.querySelector('.convert-info__button')!.getAttribute('aria-label')).toMatch(/older ERD Studio/);
  });

  it('is not there otherwise, or on the physical stage', () => {
    expect(renderToolbar({ layer: 'gold' }).container.querySelector('.convert-info')).toBeNull();
    cleanup();
    mockStoreState.convertOffer = true;
    expect(renderToolbar({ layer: 'gold', stage: 'physical', readOnly: true }).container.querySelector('.convert-info')).toBeNull();
  });
});
