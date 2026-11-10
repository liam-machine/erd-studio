import { z } from 'zod';
import { buildServices } from '../services.js';
import { isInitialized, NOT_INITIALIZED_TIP } from '../lib/setup.js';

export const read_model = {
  name: 'read_model',
  config: {
    title: 'Read a logical model',
    description:
      'Read full metadata for one logical model: columns with data types and PK/FK/NK flags, ' +
      'grain, model role, SCD types, additive types, and design rationale. ' +
      'This is the design specification — the single source of truth for what the table should be.',
    inputSchema: {
      project_path: z
        .string()
        .describe('Absolute path to the dbt project root, or a folder holding .erd-studio/ with no dbt project.'),
      model_name: z
        .string()
        .describe('Logical model name (file name without its extension: a .dbml table file in <layer>/tables/<schema>/, or an older .yml in logical-models/ or tables/).'),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  async handler({
    project_path,
    model_name,
  }: {
    project_path: string;
    model_name: string;
  }) {
    const { tableLibraryService, projectPath, semanticDir } = buildServices(project_path);

    if (!isInitialized(projectPath, semanticDir)) {
      throw new Error(NOT_INITIALIZED_TIP);
    }

    const model = tableLibraryService.getTable(model_name);
    if (!model) {
      throw new Error(
        `Model not found: ${model_name}. Use list_models to see what's available, or call get_editor_setup if you haven't created any models yet.`,
      );
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              name: model.name,
              schema: model.schema ?? null,
              alias: model.alias ?? null,
              description: model.description ?? null,
              grain: model.grain ?? null,
              model_role: model.modelRole ?? null,
              rationale: model.rationale ?? null,
              columns: (model.columns ?? []).map((c) => ({
                name: c.name,
                data_type: c.dataType ?? null,
                description: c.description ?? null,
                is_primary_key: c.isPrimaryKey === true,
                is_foreign_key: c.isForeignKey === true,
                is_natural_key: c.isNaturalKey === true,
                ...(c.scdType != null ? { scd_type: c.scdType } : {}),
                ...(c.additiveType ? { additive_type: c.additiveType } : {}),
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
