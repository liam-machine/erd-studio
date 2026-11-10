import { z } from 'zod';
import { buildServices } from '../services.js';
import { isInitialized, NOT_INITIALIZED_TIP } from '../lib/setup.js';

export const list_models = {
  name: 'list_models',
  config: {
    title: 'List logical models',
    description:
      'List all logical model definitions in the table library — one .dbml table file per table, in .erd-studio/<layer>/tables/<schema>/ ' +
      '(or older .yml files in .erd-studio/logical-models/ or tables/, from before ERD Studio 2.0, at the top level and one folder down). ' +
      'Names are unique across folders. ' +
      'Each model is one table (dimension, fact, bridge, etc.) reusable across domains. ' +
      'Returns model names + light metadata. Call read_model for full column-level detail.',
    inputSchema: {
      project_path: z
        .string()
        .describe('Absolute path to the dbt project root, or a folder holding .erd-studio/ with no dbt project.'),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  async handler({ project_path }: { project_path: string }) {
    const { tableLibraryService, projectPath, semanticDir } = buildServices(project_path);

    if (!isInitialized(projectPath, semanticDir)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { count: 0, models: [], tip: NOT_INITIALIZED_TIP },
              null,
              2,
            ),
          },
        ],
      };
    }

    const models = tableLibraryService.listTables();
    const formatOf = (name: string): 'dbml' | 'yaml' => tableLibraryService.tableStorage(name) ?? 'yaml';
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              count: models.length,
              models: models.map((m) => ({
                name: m.name,
                schema: m.schema ?? null,
                description: m.description ?? null,
                grain: m.grain ?? null,
                model_role: m.modelRole ?? null,
                column_count: m.columns?.length ?? 0,
                file_format: formatOf(m.name),
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
