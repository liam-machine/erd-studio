import * as fs from 'node:fs';
import * as path from 'node:path';

import { LayerService } from '../../src/services/layerService.js';
import { LogicalModelService } from '../../src/services/logicalModelService.js';
import { DomainService } from '../../src/services/domainService.js';
import { ManifestService } from '../../src/services/manifestService.js';

export interface Services {
  projectPath: string;
  semanticDir: string;
  layerService: LayerService;
  logicalModelService: LogicalModelService;
  domainService: DomainService;
  manifestService: ManifestService;
}

const SEMANTIC_DIR = '.erd-studio';

export function resolveProjectPath(input: string): string {
  const resolved = path.resolve(input);
  const dbtProjectFile = path.join(resolved, 'dbt_project.yml');
  if (!fs.existsSync(dbtProjectFile)) {
    throw new Error(
      `Not a dbt project: ${resolved} (missing dbt_project.yml). ` +
      `Pass the absolute path to the directory containing dbt_project.yml.`,
    );
  }
  return resolved;
}

export function buildServices(projectPathInput: string): Services {
  const projectPath = resolveProjectPath(projectPathInput);
  const layerService = new LayerService(projectPath, SEMANTIC_DIR);
  const logicalModelService = new LogicalModelService(projectPath, SEMANTIC_DIR);
  const domainService = new DomainService(layerService);
  domainService.setLogicalModelService(logicalModelService);
  const manifestService = new ManifestService();
  return {
    projectPath,
    semanticDir: SEMANTIC_DIR,
    layerService,
    logicalModelService,
    domainService,
    manifestService,
  };
}
