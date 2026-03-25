import Resolver from '@forge/resolver';
import { fetch } from '@forge/api';
import { storage } from '@forge/api';

const resolver = new Resolver();

// Helper: fetch a file from GitHub via API (supports private repos)
async function fetchGitHubFile(repo, branch, path, token) {
  // Use GitHub Contents API — works for both public and private repos
  const url = `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`;
  const headers = {
    'Accept': 'application/vnd.github.raw+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const response = await fetch(url, { headers });
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

resolver.define('getDomain', async (req) => {
  try {
    const payload = req.payload || {};
    const { repo, branch, domainPath, githubToken } = payload;

    if (!repo || !domainPath) {
      return { error: `Missing required config: repo=${repo}, domainPath=${domainPath}` };
    }

    // 1. Fetch domain JSON
    const domainText = await fetchGitHubFile(repo, branch || 'main', domainPath, githubToken);
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
          const yamlText = await fetchGitHubFile(repo, branch || 'main', modelPath, githubToken);
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
  } catch (err) {
    return { error: err.message || 'Failed to load domain from GitHub' };
  }
});

resolver.define('saveConfig', async ({ payload, context }) => {
  const localId = context.extension?.macro?.id || context.localId || 'default';
  await storage.set(`config-${localId}`, payload);
  return { success: true };
});

resolver.define('getConfig', async ({ context }) => {
  const localId = context.extension?.macro?.id || context.localId || 'default';
  return await storage.get(`config-${localId}`);
});

export const handler = resolver.getDefinitions();
