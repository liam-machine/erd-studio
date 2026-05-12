import { z } from 'zod';
import { buildServices } from '../services.js';
import { isInitialized, NOT_INITIALIZED_TIP } from '../lib/setup.js';

export const list_domains = {
  name: 'list_domains',
  config: {
    title: 'List ERD domains',
    description:
      'List all ERD Studio domains (diagrams) in a dbt project, grouped by layer. ' +
      'Each domain represents one ERD with its own models and relationships. ' +
      'Returns lightweight summaries — call read_domain for full details.',
    inputSchema: {
      project_path: z
        .string()
        .describe('Absolute path to the dbt project root (directory containing dbt_project.yml).'),
      layer: z
        .string()
        .optional()
        .describe('Optional. Filter to a single layer (e.g. "silver", "gold").'),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  async handler({ project_path, layer }: { project_path: string; layer?: string }) {
    const { domainService, projectPath, semanticDir } = buildServices(project_path);

    if (!isInitialized(projectPath, semanticDir)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                count: 0,
                project_path: projectPath,
                domains: [],
                tip: NOT_INITIALIZED_TIP,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const summaries = domainService.listDomains(projectPath, semanticDir);
    const filtered = layer ? summaries.filter((s) => s.layer === layer) : summaries;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              count: filtered.length,
              project_path: projectPath,
              domains: filtered.map((s) => ({
                domain: s.domain,
                layer: s.layer,
                file_path: s.filePath,
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
