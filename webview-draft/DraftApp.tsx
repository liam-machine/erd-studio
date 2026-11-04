/**
 * The draft preview page (docs/dev/draft-first.md §2): the banner, the schema
 * panel, the diagram (the renderer's `ErdCanvas`, viewer mode) and the
 * details drawer. It shows what the host posts (`DraftToWebview`) and posts
 * back only `DraftToHost` ids; it writes nothing and runs nothing.
 *
 * Layout: a draft with no stored position (`autoLayout`) is laid out with the
 * canvas's own ELK options before it is drawn (`Laying out N tables…`), the
 * schema on show only; ELK failing draws the host's fallback placement and
 * posts `layoutFailed` once per draft.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErdCanvas } from '@erd-studio/renderer';
import '@xyflow/react/dist/style.css';

import { isDraftToWebview, type DraftOtherStart, type DraftView } from '../src/types/draft';
import type { DisplaySubjectArea } from '../src/types/display';
import type { NodePosition } from '../src/types/semantic';
import type { DraftHost } from './lib/draftHost';
import { layoutDraft as defaultLayout, withPositions } from './lib/draftLayout';
import { filterDisplayToSchema } from './lib/filterDisplayToSchema';
import { BUSY_LABELS, layingOutLabel } from './lib/wording';
import { DraftBanner } from './components/DraftBanner';
import { SchemaPanel } from './components/SchemaPanel';
import { DetailsDrawer } from './components/DetailsDrawer';
import { DraftGuide } from './components/DraftGuide';

export interface DraftAppProps {
  host: DraftHost;
  /** The layout (tests replace it: jsdom runs no ELK worker). */
  layout?: (display: DisplaySubjectArea) => Promise<Record<string, NodePosition>>;
}

type HostBusy = 'keep' | 'scope' | undefined;

/** The schema the canvas starts on: the draft's focus, when it names a schema the draft has. */
function initialSchema(view: DraftView): string | undefined {
  const focus = view.focusSchema;
  return focus !== undefined && view.summary.schemas.some((s) => s.schema === focus) ? focus : undefined;
}

export function DraftApp({ host, layout = defaultLayout }: DraftAppProps) {
  const [view, setView] = useState<DraftView | undefined>();
  const [hostBusy, setHostBusy] = useState<HostBusy>();
  const [notice, setNotice] = useState<string | undefined>();
  const [schema, setSchema] = useState<string | undefined>();
  const [panelOpen, setPanelOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** The onboarding guide's phase A runs here (the host's `guide`); undefined: not running. */
  const [guide, setGuide] = useState<{ nothingFound?: boolean; semanticDir?: string; resumed?: boolean } | undefined>();
  /** Laid-out positions per `<view id>\u0000<schema>`; `null`: ELK failed. */
  const [layouts, setLayouts] = useState<ReadonlyMap<string, Record<string, NodePosition> | null>>(new Map());
  const layoutFailedFor = useRef<string | undefined>();
  const hostRef = useRef(host);
  hostRef.current = host;

  // Host → page.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message: unknown = event.data;
      if (!isDraftToWebview(message)) return;
      switch (message.type) {
        case 'draft':
          setView(message.view);
          setHostBusy(undefined);
          setNotice(message.view.banner.notice);
          setSchema(initialSchema(message.view));
          setPanelOpen(message.view.panelOpen);
          setDrawerOpen(false);
          setLayouts(new Map());
          break;
        case 'busy':
          setHostBusy(message.action);
          break;
        case 'idle':
          setHostBusy(undefined);
          setNotice(message.notice);
          break;
        case 'guide':
          setGuide({
            ...(message.nothingFound ? { nothingFound: true } : {}),
            ...(message.semanticDir !== undefined ? { semanticDir: message.semanticDir } : {}),
            ...(message.resumed ? { resumed: true } : {}),
          });
          break;
      }
    };
    window.addEventListener('message', onMessage);
    hostRef.current.post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const filtered = useMemo(() => (view ? filterDisplayToSchema(view.display, schema) : undefined), [view, schema]);
  const layoutKey = view ? `${view.id}\u0000${schema ?? '\u0001'}` : undefined;
  const needsLayout = !!view && view.autoLayout && !!filtered && filtered.models.length > 0;
  const laidOut = layoutKey !== undefined ? layouts.get(layoutKey) : undefined;
  const layingOut = needsLayout && layoutKey !== undefined && !layouts.has(layoutKey);

  useEffect(() => {
    if (!layingOut || !filtered || !view || layoutKey === undefined) return;
    let cancelled = false;
    const viewId = view.id;
    layout(filtered).then(
      (positions) => {
        if (!cancelled) setLayouts((prev) => new Map(prev).set(layoutKey, positions));
      },
      (err: unknown) => {
        if (cancelled) return;
        console.error('[DraftApp] Layout failed; drawing the fallback placement.', err);
        setLayouts((prev) => new Map(prev).set(layoutKey, null));
        if (layoutFailedFor.current !== viewId) {
          layoutFailedFor.current = viewId;
          hostRef.current.post({ type: 'layoutFailed' });
        }
      },
    );
    return () => { cancelled = true; };
  }, [layingOut, filtered, view, layoutKey, layout]);

  const shown = useMemo(() => {
    if (!filtered) return undefined;
    return laidOut ? withPositions(filtered, laidOut) : filtered;
  }, [filtered, laidOut]);

  const busy = hostBusy !== undefined;
  const onKeep = useCallback(() => hostRef.current.post({ type: 'keep' }), []);
  const onChangeOptions = useCallback(() => hostRef.current.post({ type: 'changeOptions' }), []);
  const onDiscard = useCallback(() => hostRef.current.post({ type: 'discard' }), []);
  const onOtherStart = useCallback((start: DraftOtherStart) => hostRef.current.post({ type: 'otherStart', start }), []);
  const onScope = useCallback((scopeId: string) => hostRef.current.post({ type: 'scope', scopeId }), []);
  const onShowDetails = useCallback(() => {
    setDrawerOpen(true);
    hostRef.current.post({ type: 'detailsOpened' });
  }, []);
  const postToHost = useCallback((message: Parameters<DraftHost['post']>[0]) => hostRef.current.post(message), []);
  const endGuide = useCallback(() => setGuide(undefined), []);
  const onTogglePanel = useCallback(() => {
    if (!panelOpen) hostRef.current.post({ type: 'detailsOpened' });
    setPanelOpen(!panelOpen);
  }, [panelOpen]);

  if (!view || !shown) {
    return (
      <div className="draft-app draft-app--loading">
        <p className="draft-app__loading" role="status">{BUSY_LABELS.scope}</p>
      </div>
    );
  }

  const status = hostBusy !== undefined
    ? BUSY_LABELS[hostBusy]
    : layingOut
      ? layingOutLabel(filtered?.models.length ?? 0)
      : undefined;
  const showPanel = view.summary.schemas.length > 1 || view.panelOpen;

  return (
    <div className={`draft-app${busy ? ' draft-app--busy' : ''}`} aria-busy={busy || layingOut}>
      <DraftBanner
        view={view}
        notice={notice}
        status={status}
        busy={busy}
        onKeep={onKeep}
        onChangeOptions={onChangeOptions}
        onDiscard={onDiscard}
        onOtherStart={onOtherStart}
        onScope={onScope}
        onShowDetails={onShowDetails}
      />
      <div className="draft-app__body">
        {showPanel && (
          <SchemaPanel
            schemas={view.summary.schemas}
            total={view.display.models.length}
            selected={schema}
            open={panelOpen}
            onToggle={onTogglePanel}
            onSelect={setSchema}
          />
        )}
        <main className="draft-canvas" aria-label="Diagram">
          {layingOut ? (
            <p className="draft-canvas__placeholder" role="status">{status}</p>
          ) : (
            <ErdCanvas
              key={layoutKey}
              className="draft-canvas__erd"
              domain={shown}
              logicalOnly={view.logicalOnly}
            />
          )}
        </main>
        {drawerOpen && <DetailsDrawer sections={view.details} onClose={() => setDrawerOpen(false)} />}
      </div>
      {guide && (
        <DraftGuide
          view={view}
          {...guide}
          hidden={busy || layingOut}
          post={postToHost}
          onEnd={endGuide}
        />
      )}
    </div>
  );
}
