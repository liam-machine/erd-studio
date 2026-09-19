import React, { useCallback, useEffect, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { invoke } from '@forge/bridge';

import { transformDomain } from './lib/graphTransformer';
import { stageNodeColor } from './lib/stageColors';
import { ModelNode } from './components/Graph/ModelNode';
import { FkEdge } from './components/Graph/FkEdge';
import type { DisplayDomain } from './types/display';

import './styles/theme.css';

const nodeTypes: NodeTypes = { model: ModelNode };
const edgeTypes: EdgeTypes = { fk: FkEdge };

const DEFAULT_HEIGHT = 1200;

// ---------------------------------------------------------------------------
// GitHub URL parser
// ---------------------------------------------------------------------------

function parseGitHubUrl(url: string) {
  const match = url.trim().match(/github\.com\/([^/]+\/[^/]+)\/blob\/([^/]+)\/(.+)/);
  if (match) return { repo: match[1], branch: match[2], domainPath: match[3] };
  return null;
}

// ---------------------------------------------------------------------------
// Inline config form (shown when no config exists)
// ---------------------------------------------------------------------------

function InlineConfig({ onSaved }: { onSaved: () => void }) {
  const [url, setUrl] = useState('');
  const [height, setHeight] = useState('1200');
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const parsed = url ? parseGitHubUrl(url) : null;

  const testConnection = async () => {
    if (!parsed) { setStatus('Please paste a valid GitHub URL.'); return; }
    setSaving(true);
    setStatus(null);
    try {
      // getDomain triggers Forge's OAuth consent UI if not authenticated.
      // After auth, Forge re-invokes the resolver automatically.
      const result = await invoke<any>('getDomain', { ...parsed, height });
      if (result.error) setStatus(`Error: ${result.error}`);
      else setStatus(`Connected! Found ${result.models?.length ?? 0} models and ${result.relationships?.length ?? 0} relationships.`);
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!parsed) { setStatus('Please paste a valid GitHub URL.'); return; }
    setSaving(true);
    try {
      await invoke('saveConfig', { ...parsed, height, githubUrl: url });
      onSaved();
    } catch (err: any) {
      setStatus(`Save failed: ${err.message}`);
      setSaving(false);
    }
  };

  const isSuccess = status?.startsWith('Connected');

  return (
    <div style={{ padding: '32px', maxWidth: '560px', margin: '0 auto', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: '18px', color: '#172b4d' }}>ERD Studio</h2>
      <p style={{ margin: '0 0 20px', fontSize: '13px', color: '#6b778c' }}>
        Paste a GitHub link to your domain JSON file. GitHub authentication is handled
        automatically via OAuth when you test the connection.
      </p>

      <label style={labelStyle}>GitHub URL</label>
      <input
        style={inputStyle}
        type="text"
        placeholder="https://github.com/owner/repo/blob/main/.erd-studio/silver/domain.json"
        value={url}
        onChange={(e) => { setUrl(e.target.value); setStatus(null); }}
      />
      {parsed && (
        <div style={{ marginTop: '4px', padding: '6px 8px', backgroundColor: '#f4f5f7', borderRadius: '3px', fontSize: '11px', color: '#172b4d', lineHeight: 1.6 }}>
          <b style={{ color: '#6b778c' }}>Repo:</b> {parsed.repo} &nbsp;
          <b style={{ color: '#6b778c' }}>Branch:</b> {parsed.branch}<br />
          <b style={{ color: '#6b778c' }}>Path:</b> {parsed.domainPath}
        </div>
      )}
      {url && !parsed && (
        <div style={{ marginTop: '4px', fontSize: '11px', color: '#de350b' }}>
          Could not parse URL. Expected: github.com/owner/repo/blob/branch/path/to/file.json
        </div>
      )}

      <div style={{ marginTop: '16px' }}>
        <label style={labelStyle}>Diagram Height</label>
        <select style={{ ...inputStyle, cursor: 'pointer' }} value={height} onChange={(e) => setHeight(e.target.value)}>
          <option value="600">Small (600px)</option>
          <option value="800">Medium (800px)</option>
          <option value="1200">Large (1200px)</option>
          <option value="1600">Extra Large (1600px)</option>
          <option value="2000">Full Screen (2000px)</option>
        </select>
      </div>

      {status && (
        <div style={{
          marginTop: '12px', padding: '8px 12px', borderRadius: '3px', fontSize: '13px',
          color: isSuccess ? '#006644' : '#de350b',
          backgroundColor: isSuccess ? '#e3fcef' : '#ffebe6',
        }}>
          {status}
        </div>
      )}

      <div style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
        <button
          style={{ ...btnStyle, opacity: parsed ? 1 : 0.5 }}
          onClick={testConnection}
          disabled={saving || !parsed}
        >
          {saving ? 'Testing...' : 'Test Connection'}
        </button>
        <button
          style={{ ...btnPrimaryStyle, opacity: parsed ? 1 : 0.5 }}
          onClick={save}
          disabled={saving || !parsed}
        >
          Save & Load Diagram
        </button>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: '12px', fontWeight: 600, color: '#172b4d', marginBottom: '4px' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '6px 8px', fontSize: '13px', border: '1px solid #dfe1e6', borderRadius: '3px', backgroundColor: '#fafbfc', color: '#172b4d', boxSizing: 'border-box' };
const btnStyle: React.CSSProperties = { padding: '6px 12px', fontSize: '13px', border: '1px solid #dfe1e6', borderRadius: '3px', backgroundColor: '#fff', color: '#172b4d', cursor: 'pointer' };
const btnPrimaryStyle: React.CSSProperties = { padding: '6px 16px', fontSize: '13px', border: 'none', borderRadius: '3px', backgroundColor: '#0052cc', color: '#fff', cursor: 'pointer', fontWeight: 600 };

// ---------------------------------------------------------------------------
// Main ERD viewer
// ---------------------------------------------------------------------------

function ERDViewer() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [domain, setDomain] = useState<DisplayDomain | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsConfig, setNeedsConfig] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());
  const [heightPx, setHeightPx] = useState(DEFAULT_HEIGHT);

  const toggleExpansion = useCallback((modelName: string) => {
    setExpandedModels((prev) => {
      const next = new Set(prev);
      if (next.has(modelName)) next.delete(modelName);
      else next.add(modelName);
      return next;
    });
  }, []);

  const loadDomain = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNeedsConfig(false);
    try {
      const config = await invoke<any>('getConfig');
      if (!config || !config.repo) {
        setNeedsConfig(true);
        setLoading(false);
        return;
      }

      const h = parseInt(config.height, 10);
      if (h && h > 0) setHeightPx(h);

      // getDomain triggers Forge's OAuth consent UI if not authenticated.
      // After auth, Forge re-invokes the resolver automatically.
      const result = await invoke<any>('getDomain', config);
      if (result.error) {
        setError(result.error);
        setLoading(false);
        return;
      }
      setDomain(result as DisplayDomain);
    } catch (err: any) {
      setError(err.message || 'Failed to load domain');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadDomain(); }, [loadDomain]);

  // Transform domain to React Flow nodes/edges
  useEffect(() => {
    if (!domain) return;
    const { nodes: flowNodes, edges: flowEdges } = transformDomain(domain);
    const enrichedNodes = flowNodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        isExpanded: expandedModels.has(node.data.modelName),
        onToggleExpansion: toggleExpansion,
      },
    }));
    setNodes(enrichedNodes);
    setEdges(flowEdges);
  }, [domain, expandedModels, toggleExpansion, setNodes, setEdges]);

  const changeHeight = useCallback(async (newHeight: string) => {
    const h = parseInt(newHeight, 10);
    if (!h || h <= 0) return;
    setHeightPx(h);
    try {
      const config = await invoke<any>('getConfig');
      if (config) {
        await invoke('saveConfig', { ...config, height: newHeight });
      }
    } catch {}
  }, []);

  const reconfigure = useCallback(() => {
    setNeedsConfig(true);
    setDomain(null);
    setShowSettings(false);
  }, []);

  // Kick the Forge iframe auto-resizer
  useEffect(() => {
    document.body.style.paddingBottom = '1px';
    requestAnimationFrame(() => { document.body.style.paddingBottom = '0px'; });
  }, [loading, heightPx, needsConfig]);

  if (needsConfig) {
    return <InlineConfig onSaved={loadDomain} />;
  }

  const SETTINGS_BAR_HEIGHT = showSettings ? 36 : 0;

  return (
    <div style={{ height: `${heightPx}px`, position: 'relative' }}>
      {/* Settings toggle button — top right */}
      {!loading && !error && (
        <button
          onClick={() => setShowSettings((s) => !s)}
          title="Settings"
          style={{
            position: 'absolute', top: 8, right: 8, zIndex: 10,
            width: 28, height: 28, borderRadius: '4px',
            border: '1px solid #dfe1e6', backgroundColor: showSettings ? '#e9ecef' : '#fff',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '14px', color: '#6b778c',
          }}
        >
          &#9881;
        </button>
      )}

      {/* Settings bar */}
      {showSettings && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: '36px', zIndex: 9,
          display: 'flex', alignItems: 'center', gap: '12px', padding: '0 12px',
          backgroundColor: '#f4f5f7', borderBottom: '1px solid #dfe1e6',
          fontSize: '12px', color: '#172b4d',
        }}>
          <span style={{ fontWeight: 600 }}>Height:</span>
          <select
            value={String(heightPx)}
            onChange={(e) => changeHeight(e.target.value)}
            style={{ padding: '2px 6px', fontSize: '12px', border: '1px solid #dfe1e6', borderRadius: '3px', cursor: 'pointer' }}
          >
            <option value="600">600px</option>
            <option value="800">800px</option>
            <option value="1200">1200px</option>
            <option value="1600">1600px</option>
            <option value="2000">2000px</option>
          </select>
          <div style={{ marginLeft: 'auto' }}>
            <button
              onClick={reconfigure}
              style={{ padding: '2px 8px', fontSize: '11px', border: '1px solid #dfe1e6', borderRadius: '3px', backgroundColor: '#fff', color: '#6b778c', cursor: 'pointer' }}
            >
              Reconfigure
            </button>
          </div>
        </div>
      )}

      {loading && (
        <div className="erd-center-message" style={{ color: '#6b778c' }}>Loading ERD diagram...</div>
      )}
      {error && (
        <div className="erd-center-message" style={{ color: '#de350b' }}>{error}</div>
      )}
      {!loading && !error && (
        <div style={{ position: 'absolute', top: SETTINGS_BAR_HEIGHT, left: 0, right: 0, bottom: 0 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1.5 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={true}
            panOnDrag
            zoomOnScroll
            minZoom={0.1}
            maxZoom={2}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            <MiniMap
              nodeColor={(node) => stageNodeColor(node.data?.stage as string, node.data?.isGhost as boolean)}
              maskColor="rgba(0, 0, 0, 0.1)"
              style={{ backgroundColor: '#f4f5f7' }}
            />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <ERDViewer />
    </ReactFlowProvider>
  );
}
