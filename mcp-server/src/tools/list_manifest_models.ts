import { z } from 'zod';
import { buildServices } from '../services.js';

export const list_manifest_models = {
  name: 'list_manifest_models',
  config: {
    title: 'List dbt manifest models',
    description:
      'List all models from target/manifest.json — what dbt actually built. ' +
      'Returns model name, schema, columns with data types from the warehouse, and existing ' +
      'unique/relationship test coverage. This is the ground truth from dbt, ' +
      'complementing the design source-of-truth in list_models / read_domain.',
    inputSchema: {
      project_path: z
        .string()
        .describe('Absolute path to the dbt project root.'),
      name_contains: z
        .string()
        .optional()
        .describe('Optional. Case-insensitive substring filter on model name (e.g. "dim_" or "fct_").'),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  async handler({
    project_path,
    name_contains,
  }: {
    project_path: string;
    name_contains?: string;
  }) {
    const { manifestService, projectPath } = buildServices(project_path);
    const manifest = await manifestService.loadManifest(projectPath);

    const filter = name_contains?.toLowerCase();
    const allModels = Array.from(manifest.models.entries());
    const matched = filter
      ? allModels.filter(([name]) => name.toLowerCase().includes(filter))
      : allModels;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              count: matched.length,
              total: allModels.length,
              models: matched.map(([name, info]) => ({
                name,
                schema: info.schema ?? null,
                description: info.description ?? null,
                column_count: info.columns?.length ?? 0,
                unique_columns: Array.from(manifest.uniqueColumns.get(name) ?? []),
                relationships: manifest.relationshipTests
                  .filter((t) => t.fromModel === name)
                  .map((t) => ({
                    from_column: t.fromColumn,
                    to_model: t.toModel,
                    to_column: t.toColumn,
                  })),
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
