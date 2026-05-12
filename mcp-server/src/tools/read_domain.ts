import * as path from 'node:path';
import * as fs from 'node:fs';
import { z } from 'zod';
import { buildServices } from '../services.js';

export const read_domain = {
  name: 'read_domain',
  config: {
    title: 'Read a domain (logical stage)',
    description:
      'Read a full ERD domain by name + layer. Returns the logical stage: ' +
      'models with columns (data types, PK/FK/NK flags, SCD types), grain, model role, ' +
      'rationale, and the relationships drawn between them with cardinality. ' +
      'This is the design source-of-truth. For what dbt actually built, see list_manifest_models.',
    inputSchema: {
      project_path: z
        .string()
        .describe('Absolute path to the dbt project root.'),
      layer: z
        .string()
        .describe('Layer name (e.g. "silver", "gold").'),
      domain: z
        .string()
        .describe('Domain slug (filename without .json).'),
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
    const { domainService, projectPath, semanticDir } = buildServices(project_path);
    const filePath = path.join(projectPath, semanticDir, layer, `${domain}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `Domain not found: ${layer}/${domain}.json. Use list_domains to see what's available.`,
      );
    }

    const unified = domainService.getDomain(filePath);
    const stage = domainService.getDomainStage(filePath);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              domain: stage.domain,
              layer: stage.layer,
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
