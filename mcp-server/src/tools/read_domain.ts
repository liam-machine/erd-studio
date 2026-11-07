import * as path from 'node:path';
import { z } from 'zod';
import { buildServices } from '../services.js';
import { isInitialized, NOT_INITIALIZED_TIP } from '../lib/setup.js';

export const read_domain = {
  name: 'read_domain',
  config: {
    title: 'Read a domain (logical stage)',
    description:
      'Read a full ERD domain (diagram) by name + layer — a .dbml diagram, or a .json one in a project from before ERD Studio 2.0. Returns the logical stage: ' +
      'models with columns (data types, PK/FK/NK flags, SCD types), grain, model role, ' +
      'rationale, and the relationships drawn between them with cardinality. ' +
      'This is the design source-of-truth. For what dbt actually built, see list_manifest_models.',
    inputSchema: {
      project_path: z
        .string()
        .describe('Absolute path to the dbt project root, or a folder holding .erd-studio/ with no dbt project.'),
      layer: z
        .string()
        .describe('Layer name (e.g. "silver", "gold").'),
      domain: z
        .string()
        .describe("The diagram's file name without .dbml or .json."),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  async handler({
    project_path,
    layer,
    domain,
  }: {
    project_path: string;
    layer: string;
    domain: string;
  }) {
    const { subjectAreaService, projectPath, semanticDir } = buildServices(project_path);

    if (!isInitialized(projectPath, semanticDir)) {
      throw new Error(NOT_INITIALIZED_TIP);
    }

    // Found through the listing, as the extension finds it: a `.dbml` diagram first, then a `.json` one.
    const stemOf = (filePath: string): string => path.basename(filePath).replace(/\.(dbml|json)$/i, '');
    const candidates = subjectAreaService.listSubjectAreas(projectPath, semanticDir)
      .filter((s) => s.layer === layer && stemOf(s.filePath) === domain)
      .sort((a, b) => (a.storage === 'dbml' ? 0 : 1) - (b.storage === 'dbml' ? 0 : 1));
    const filePath = candidates[0]?.filePath;
    if (!filePath) {
      throw new Error(
        `Domain not found: ${layer}/${domain} (looked for ${domain}.dbml and ${domain}.json, the diagram's file name without .dbml or .json). `
          + "Use list_domains to see what's available, or call get_editor_setup if you haven't created any ERDs yet.",
      );
    }

    const unified = subjectAreaService.getSubjectArea(filePath);
    const stage = subjectAreaService.getSubjectAreaStage(filePath);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              domain: stage.domain,
              layer: stage.layer,
              file_format: candidates[0].storage ?? 'json',
              stage: stage.stage,
              description: stage.description ?? null,
              model_folder: stage.modelFolder ?? null,
              models: stage.models.map((m) => ({
                name: m.name,
                schema: m.schema ?? null,
                description: m.description ?? null,
                grain: m.grain ?? null,
                model_role: m.modelRole ?? null,
                rationale: m.rationale ?? null,
                columns: (m.columns ?? []).map((c) => ({
                  name: c.name,
                  data_type: c.dataType ?? null,
                  description: c.description ?? null,
                  is_primary_key: c.isPrimaryKey === true,
                  is_foreign_key: c.isForeignKey === true,
                  is_natural_key: c.isNaturalKey === true,
                  ...(c.scdType != null ? { scd_type: c.scdType } : {}),
                  ...(c.additiveType ? { additive_type: c.additiveType } : {}),
                })),
              })),
              relationships: stage.relationships.map((r) => ({
                from_model: r.fromModel,
                from_column: r.fromColumn,
                to_model: r.toModel,
                to_column: r.toColumn,
                cardinality: r.cardinality,
                ...(r.role ? { role: r.role } : {}),
              })),
              view_config: unified.viewConfig ?? {},
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
