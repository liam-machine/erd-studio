import { z } from 'zod';
import { buildServices } from '../services.js';

export const list_models = {
  name: 'list_models',
  config: {
    title: 'List logical models',
    description:
      'List all logical model definitions in erd-studio/logical-models/. ' +
      'Each model is one table (dimension, fact, bridge, etc.) reusable across domains. ' +
      'Returns model names + light metadata. Call read_model for full column-level detail.',
    inputSchema: {
      project_path: z
        .string()
        .describe('Absolute path to the dbt project root.'),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  async handler({ project_path }: { project_path: string }) {
    const { logicalModelService } = buildServices(project_path);
    const models = logicalModelService.listModels();
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
