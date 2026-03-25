import Resolver from '@forge/resolver';
import api from '@forge/api';
import { kvs as storage } from '@forge/kvs';

const resolver = new Resolver();

// Helper: get an authenticated GitHub API handle for the current user
function getGitHubApi() {
  return api.asUser().withProvider('github', 'github-api');
}

// Custom error class for 401s — lets getDomain distinguish auth failures
// from other errors and re-throw outside the try/catch for Forge to intercept.
class GitHubAuthError extends Error {
  constructor(path) {
    super(`GitHub auth expired for ${path}`);
    this.name = 'GitHubAuthError';
  }
}

// Helper: fetch a file from GitHub via the Forge-authenticated provider
async function fetchGitHubFile(github, repo, branch, path) {
  const apiPath = `/repos/${repo}/contents/${path}?ref=${branch}`;
  const response = await github.fetch(apiPath, {
    headers: {
      'Accept': 'application/vnd.github.raw+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (response.status === 401) {
    throw new GitHubAuthError(path);
  }
  if (!response.ok) {
    throw new Error(`GitHub fetch failed: ${response.status} for ${path}`);
  }
  return response.text();
}

// Simple YAML parser for logical model files
function parseLogicalModelYaml(yamlText) {
  const model = { name: '', columns: [] };
  const lines = yamlText.split('\n');
  let currentColumn = null;
  let inColumns = false;
  let inRationale = false;
  const rationale = {};

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Top-level fields
    if (!trimmed.startsWith(' ') && !trimmed.startsWith('-')) {
      inColumns = false;
      inRationale = false;
      const match = trimmed.match(/^(\w+):\s*(.*)$/);
      if (match) {
        const [, key, value] = match;
        if (key === 'name') model.name = value.trim();
        else if (key === 'schema') model.schema = value.trim();
        else if (key === 'description') model.description = value.trim();
        else if (key === 'grain') model.grain = value.trim();
        else if (key === 'modelRole') model.modelRole = value.trim();
        else if (key === 'columns') inColumns = true;
        else if (key === 'rationale') inRationale = true;
      }
      continue;
    }

    // Rationale sub-fields
    if (inRationale && trimmed.match(/^\s{2}\w+:/)) {
      const match = trimmed.match(/^\s{2}(\w+):\s*(.*)$/);
      if (match) {
        rationale[match[1]] = match[2].trim();
      }
      continue;
    }

    // Column entries
    if (inColumns) {
      if (trimmed.match(/^\s{2}-\s+name:/)) {
        if (currentColumn) model.columns.push(currentColumn);
        const nameMatch = trimmed.match(/name:\s*(.+)/);
        currentColumn = {
          name: nameMatch ? nameMatch[1].trim() : '',
          dataType: 'VARCHAR',
          description: '',
          isPrimaryKey: false,
          isForeignKey: false,
          isNaturalKey: false,
        };
      } else if (currentColumn && trimmed.match(/^\s{4}\w+:/)) {
        const match = trimmed.match(/^\s{4}(\w+):\s*(.*)$/);
        if (match) {
          const [, key, value] = match;
          if (key === 'dataType') currentColumn.dataType = value.trim();
          else if (key === 'description') currentColumn.description = value.trim();
          else if (key === 'isPrimaryKey') currentColumn.isPrimaryKey = value.trim() === 'true';
          else if (key === 'isForeignKey') currentColumn.isForeignKey = value.trim() === 'true';
          else if (key === 'isNaturalKey') currentColumn.isNaturalKey = value.trim() === 'true';
          else if (key === 'scdType') currentColumn.scdType = parseInt(value.trim(), 10);
          else if (key === 'additiveType') currentColumn.additiveType = value.trim();
        }
      }
    }
  }

  // Push last column
  if (currentColumn) model.columns.push(currentColumn);

  // Attach rationale if non-empty
  if (Object.keys(rationale).length > 0) model.rationale = rationale;

  return model;
}

// Check if the current user has connected their GitHub account
resolver.define('getAuthStatus', async () => {
  try {
    const github = getGitHubApi();
    const hasCredentials = await github.hasCredentials();
    if (!hasCredentials) {
      return { authenticated: false };
    }
    const account = await github.getAccount();
    return {
      authenticated: true,
      user: account ? { displayName: account.displayName, avatarUrl: account.avatarUrl } : null,
    };
  } catch {
    return { authenticated: false };
  }
});

resolver.define('getDomain', async (req) => {
  // Credential check MUST be outside try/catch — requestCredentials() throws
  // a platform exception that Forge intercepts to show its OAuth consent UI.
  // If caught, Forge never sees the throw and can't show the auth prompt.
  const github = getGitHubApi();
  if (!(await github.hasCredentials())) {
    await github.requestCredentials();
  }

  let result;
  let needsReauth = false;
  try {
    result = await _getDomainInner(github, req);
  } catch (err) {
    if (err instanceof GitHubAuthError) {
      needsReauth = true;
    } else {
      return { error: err.message || 'Failed to load domain from GitHub' };
    }
  }

  // Token was revoked/expired on GitHub's side — force re-auth.
  // requestCredentials() MUST be outside try/catch so Forge intercepts
  // the platform exception and shows the OAuth consent UI.
  if (needsReauth) {
    await github.requestCredentials();
  }

  return result;
});

async function _getDomainInner(github, req) {
    const payload = req.payload || {};
    const { repo, branch, domainPath } = payload;

    if (!repo || !domainPath) {
      return { error: `Missing required config: repo=${repo}, domainPath=${domainPath}` };
    }

    // 1. Fetch domain JSON
    const domainText = await fetchGitHubFile(github, repo, branch || 'main', domainPath);
    const domainJson = JSON.parse(domainText);

    // 2. Determine base directory for logical-models
    const pathParts = domainPath.split('/');
    const baseDir = pathParts.slice(0, -2).join('/'); // Remove layer/filename

    // 3. Check if models are string references (v5) or inline objects (v4)
    const modelEntries = domainJson.logical?.models ?? [];
    const resolvedModels = [];

    if (modelEntries.length > 0 && typeof modelEntries[0] === 'string') {
      // v5 format: models are string references to YAML files
      for (const modelName of modelEntries) {
        try {
          const modelPath = `${baseDir}/logical-models/${modelName}.yml`;
          const yamlText = await fetchGitHubFile(github, repo, branch || 'main', modelPath);
          const model = parseLogicalModelYaml(yamlText);
          resolvedModels.push({
            name: model.name || modelName,
            schema: model.schema || '',
            description: model.description || '',
            columns: (model.columns || []).map(col => ({
              name: col.name,
              dataType: col.dataType || 'VARCHAR',
              description: col.description || '',
              isPrimaryKey: col.isPrimaryKey || false,
              isForeignKey: col.isForeignKey || false,
              isNaturalKey: col.isNaturalKey || false,
              ...(col.scdType != null ? { scdType: col.scdType } : {}),
              ...(col.additiveType ? { additiveType: col.additiveType } : {}),
            })),
            ...(model.rationale ? { rationale: model.rationale } : {}),
            ...(model.grain ? { grain: model.grain } : {}),
            ...(model.modelRole ? { modelRole: model.modelRole } : {}),
          });
        } catch (err) {
          resolvedModels.push({
            name: modelName,
            schema: '',
            description: `Could not load ${modelName}.yml`,
            columns: [],
          });
        }
      }
    } else {
      // v4 format: models are inline objects
      for (const model of modelEntries) {
        resolvedModels.push({
          name: model.name,
          schema: model.schema || '',
          description: model.description || '',
          columns: (model.columns || []).map(col => ({
            name: col.name,
            dataType: col.dataType || 'VARCHAR',
            description: col.description || '',
            isPrimaryKey: col.isPrimaryKey || false,
            isForeignKey: col.isForeignKey || false,
            isNaturalKey: col.isNaturalKey || false,
            ...(col.scdType != null ? { scdType: col.scdType } : {}),
            ...(col.additiveType ? { additiveType: col.additiveType } : {}),
          })),
          ...(model.rationale ? { rationale: model.rationale } : {}),
          ...(model.grain ? { grain: model.grain } : {}),
          ...(model.modelRole ? { modelRole: model.modelRole } : {}),
        });
      }
    }

    // 4. Build relationships
    const relationships = (domainJson.logical?.relationships ?? []).map(rel => ({
      fromModel: rel.fromModel,
      fromColumn: rel.fromColumn,
      toModel: rel.toModel,
      toColumn: rel.toColumn,
      cardinality: rel.cardinality || 'many-to-one',
    }));

    // 5. Build layer from path
    const layer = pathParts[pathParts.length - 2] || 'silver';

    // 6. Assemble DisplayDomain
    return {
      schemaVersion: domainJson.schemaVersion || 5,
      domain: domainJson.domain || pathParts[pathParts.length - 1].replace('.json', ''),
      layer,
      stage: 'logical',
      description: domainJson.description || '',
      models: resolvedModels,
      relationships,
      viewConfig: domainJson.viewConfig || {},
      readOnly: true,
      positionDraggable: false,
    };
}

resolver.define('saveConfig', async ({ payload, context }) => {
  const localId = context.extension?.macro?.id || context.localId || 'default';
  // Strip githubToken from legacy configs — auth is now handled via OAuth
  const { githubToken, ...cleanPayload } = payload;
  await storage.set(`config-${localId}`, cleanPayload);
  return { success: true };
});

resolver.define('getConfig', async ({ context }) => {
  const localId = context.extension?.macro?.id || context.localId || 'default';
  const config = await storage.get(`config-${localId}`);
  // Strip any legacy githubToken from stored config
  if (config && config.githubToken) {
    const { githubToken, ...clean } = config;
    return clean;
  }
  return config;
});

export const handler = resolver.getDefinitions();
