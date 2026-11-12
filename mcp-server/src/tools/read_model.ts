import { z } from 'zod';
import { buildServices } from '../services.js';
import { isInitialized, NOT_INITIALIZED_TIP } from '../lib/setup.js';
import { tableIdOfEntry } from '../../../src/services/tableLibraryIndex.js';

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
      schema: z
        .string()
        .optional()
        .describe('The table\'s schema folder (<layer>/tables/<schema>/). Needed only when tables in more than one schema folder have the name.'),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  async handler({
    project_path,
    model_name,
    schema,
  }: {
    project_path: string;
    model_name: string;
    schema?: string;
  }) {
    const { tableLibraryService, projectPath, semanticDir } = buildServices(project_path);

    if (!isInitialized(projectPath, semanticDir)) {
      throw new Error(NOT_INITIALIZED_TIP);
    }

    // A name tables in more than one schema folder have is read by its schema folder, never by picking one.
    const named = tableLibraryService.tablesNamed(model_name).map((e) => tableIdOfEntry(e));
    let model;
    if (schema !== undefined) {
      const id = named.find((t) => t.schema.toLowerCase() === schema.trim().toLowerCase());
      if (!id) {
        throw new Error(
          `No table ${model_name} in schema folder ${schema}` + (named.length > 0 ? ` (it is in: ${named.map((t) => t.schema || '(no schema folder)').join(', ')}).` : '. Use list_models to see what\'s available.'),
        );
      }
      model = tableLibraryService.getTable(id);
    } else if (tableLibraryService.isAmbiguousName(model_name)) {
      throw new Error(
        `Tables in more than one schema folder are named ${model_name} (${named.map((t) => t.schema).join(', ')}). Pass schema to say which.`,
      );
    } else {
      model = tableLibraryService.getTable(model_name);
    }
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
