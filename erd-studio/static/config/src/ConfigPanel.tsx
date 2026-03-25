import React, { useEffect, useState } from 'react';
import { invoke, view } from '@forge/bridge';

interface MacroConfig {
  repo: string;
  branch: string;
  domainPath: string;
  githubToken: string;
  height: string;
  githubUrl: string;
}

const DEFAULT_CONFIG: MacroConfig = {
  repo: '',
  branch: 'main',
  domainPath: '',
  githubToken: '',
  height: '1200',
  githubUrl: '',
};

const HEIGHT_OPTIONS = [
  { value: '600', label: 'Small (600px)' },
  { value: '800', label: 'Medium (800px)' },
  { value: '1200', label: 'Large (1200px)' },
  { value: '1600', label: 'Extra Large (1600px)' },
  { value: '2000', label: 'Full Screen (2000px)' },
];

/**
 * Parse a GitHub URL into repo, branch, and path.
 * Supports: https://github.com/owner/repo/blob/branch/path/to/file.json
 */
function parseGitHubUrl(url: string): { repo: string; branch: string; domainPath: string } | null {
  const trimmed = url.trim();
  // Match: github.com/owner/repo/blob/branch/path...
  const match = trimmed.match(/github\.com\/([^/]+\/[^/]+)\/blob\/([^/]+)\/(.+)/);
  if (match) {
    return { repo: match[1], branch: match[2], domainPath: match[3] };
  }
  // Match: github.com/owner/repo/tree/branch/path... (directory link)
  const treeMatch = trimmed.match(/github\.com\/([^/]+\/[^/]+)\/tree\/([^/]+)\/(.+)/);
  if (treeMatch) {
    return { repo: treeMatch[1], branch: treeMatch[2], domainPath: treeMatch[3] };
  }
  return null;
}

export default function ConfigPanel() {
  const [config, setConfig] = useState<MacroConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [parsed, setParsed] = useState<{ repo: string; branch: string; domainPath: string } | null>(null);

  // Load existing config
  useEffect(() => {
    async function loadConfig() {
      const context = await view.getContext();
      const macroConfig = (context as any)?.extension?.config;
      if (macroConfig && macroConfig.repo) {
        setConfig({ ...DEFAULT_CONFIG, ...macroConfig });
        setParsed({ repo: macroConfig.repo, branch: macroConfig.branch || 'main', domainPath: macroConfig.domainPath });
        return;
      }
      const saved = await invoke<MacroConfig | null>('getConfig');
      if (saved && saved.repo) {
        setConfig(saved);
        setParsed({ repo: saved.repo, branch: saved.branch || 'main', domainPath: saved.domainPath });
      }
    }
    loadConfig();
  }, []);

  const onUrlChange = (url: string) => {
    setConfig((prev) => ({ ...prev, githubUrl: url }));
    setStatus(null);
    const result = parseGitHubUrl(url);
    if (result) {
      setParsed(result);
      setConfig((prev) => ({ ...prev, repo: result.repo, branch: result.branch, domainPath: result.domainPath }));
    } else if (url.trim()) {
      setParsed(null);
    }
  };

  const testConnection = async () => {
    if (!config.repo || !config.domainPath) {
      setStatus('Please paste a valid GitHub URL to a domain JSON file.');
      return;
    }
    setTesting(true);
    setStatus(null);
    try {
      const result = await invoke<any>('getDomain', config);
      if (result.error) {
        setStatus(`Error: ${result.error}`);
      } else {
        const modelCount = result.models?.length ?? 0;
        const relCount = result.relationships?.length ?? 0;
        setStatus(`Connected! Found ${modelCount} models and ${relCount} relationships.`);
      }
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!config.repo || !config.domainPath) {
      setStatus('Please paste a valid GitHub URL to a domain JSON file.');
      return;
    }
    try {
      await invoke('saveConfig', config);
    } catch (err: any) {
      setStatus(`Save failed: ${err.message}`);
      return;
    }
    // Close the config panel — try every method available
    try { await view.submit(config); return; } catch {}
    try { await (view as any).close(); return; } catch {}
    // Last resort: replace the panel content with a done message
    setStatus('__DONE__');
  };

  // If save completed but panel couldn't close, show a minimal "done" state
  if (status === '__DONE__') {
    return (
      <div style={styles.container}>
        <div style={{ padding: '24px', textAlign: 'center' }}>
          <div style={{ fontSize: '24px', marginBottom: '8px' }}>&#10003;</div>
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#006644', marginBottom: '4px' }}>Configuration saved</div>
          <div style={{ fontSize: '13px', color: '#6b778c' }}>Publish the page to see your ERD diagram.</div>
        </div>
      </div>
    );
  }

  const isSuccess = status?.startsWith('Connected') || status?.startsWith('Saved');

  return (
    <div style={styles.container}>
      <h3 style={styles.title}>ERD Studio Configuration</h3>
      <p style={styles.subtitle}>
        Paste a GitHub link to your domain JSON file.
      </p>

      <div style={styles.field}>
        <label style={styles.label}>GitHub URL</label>
        <input
          style={styles.input}
          type="text"
          placeholder="https://github.com/owner/repo/blob/main/erd-studio/silver/domain.json"
          value={config.githubUrl}
          onChange={(e) => onUrlChange(e.target.value)}
        />
        {parsed && (
          <div style={styles.parsedInfo}>
            <span style={styles.parsedLabel}>Repo:</span> {parsed.repo}
            <span style={{ ...styles.parsedLabel, marginLeft: '12px' }}>Branch:</span> {parsed.branch}
            <br />
            <span style={styles.parsedLabel}>Path:</span> {parsed.domainPath}
          </div>
        )}
        {config.githubUrl && !parsed && (
          <span style={{ ...styles.hint, color: '#de350b' }}>
            Could not parse URL. Expected format: github.com/owner/repo/blob/branch/path/to/file.json
          </span>
        )}
      </div>

      <div style={styles.field}>
        <label style={styles.label}>GitHub Token (optional)</label>
        <input
          style={styles.input}
          type="password"
          placeholder="ghp_... or github_pat_..."
          value={config.githubToken}
          onChange={(e) => {
            setConfig((prev) => ({ ...prev, githubToken: e.target.value }));
            setStatus(null);
          }}
        />
        <span style={styles.hint}>Required for private repos. Needs Contents read permission.</span>
      </div>

      <div style={{ ...styles.field, borderTop: '1px solid #dfe1e6', paddingTop: '12px', marginTop: '16px' }}>
        <label style={styles.label}>Diagram Height</label>
        <select
          style={{ ...styles.input, cursor: 'pointer' }}
          value={config.height}
          onChange={(e) => {
            setConfig((prev) => ({ ...prev, height: e.target.value }));
            setStatus(null);
          }}
        >
          {HEIGHT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {status && (
        <div style={{
          ...styles.status,
          color: isSuccess ? '#006644' : '#de350b',
          backgroundColor: isSuccess ? '#e3fcef' : '#ffebe6',
        }}>
          {status}
        </div>
      )}

      <div style={styles.buttons}>
        <button
          style={{ ...styles.testButton, opacity: parsed ? 1 : 0.5 }}
          onClick={testConnection}
          disabled={testing || !parsed}
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
        <button
          style={{ ...styles.saveButton, opacity: parsed ? 1 : 0.5 }}
          onClick={save}
          disabled={!parsed}
        >
          Save
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    padding: '16px',
    maxWidth: '520px',
  },
  title: {
    margin: '0 0 4px 0',
    fontSize: '16px',
    fontWeight: 600,
    color: '#172b4d',
  },
  subtitle: {
    margin: '0 0 16px 0',
    fontSize: '13px',
    color: '#6b778c',
  },
  field: {
    marginBottom: '12px',
  },
  label: {
    display: 'block',
    fontSize: '12px',
    fontWeight: 600,
    color: '#172b4d',
    marginBottom: '4px',
  },
  input: {
    width: '100%',
    padding: '6px 8px',
    fontSize: '13px',
    border: '1px solid #dfe1e6',
    borderRadius: '3px',
    backgroundColor: '#fafbfc',
    color: '#172b4d',
    boxSizing: 'border-box' as const,
  },
  hint: {
    display: 'block',
    fontSize: '11px',
    color: '#97a0af',
    marginTop: '2px',
  },
  parsedInfo: {
    marginTop: '6px',
    padding: '6px 8px',
    backgroundColor: '#f4f5f7',
    borderRadius: '3px',
    fontSize: '11px',
    color: '#172b4d',
    lineHeight: '1.6',
  },
  parsedLabel: {
    fontWeight: 600,
    color: '#6b778c',
  },
  status: {
    padding: '8px 12px',
    borderRadius: '3px',
    fontSize: '13px',
    marginBottom: '12px',
  },
  buttons: {
    display: 'flex',
    gap: '8px',
    marginTop: '16px',
  },
  testButton: {
    padding: '6px 12px',
    fontSize: '13px',
    border: '1px solid #dfe1e6',
    borderRadius: '3px',
    backgroundColor: '#ffffff',
    color: '#172b4d',
    cursor: 'pointer',
  },
  saveButton: {
    padding: '6px 16px',
    fontSize: '13px',
    border: 'none',
    borderRadius: '3px',
    backgroundColor: '#0052cc',
    color: '#ffffff',
    cursor: 'pointer',
    fontWeight: 600,
  },
};
