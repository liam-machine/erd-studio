import * as fs from 'node:fs';
import * as path from 'node:path';

import { LayerService } from '../../src/services/layerService.js';
import { TableLibraryService } from '../../src/services/logicalModelService.js';
import { SubjectAreaService } from '../../src/services/domainService.js';
import { ManifestService } from '../../src/services/manifestService.js';

export interface Services {
  projectPath: string;
  /**
   * The project holds dbt_project.yml. False for a logical-only folder (one
   * holding .erd-studio/ and no dbt project): the manifest service is built
   * disabled, so it reads nothing and lists no models.
   */
  hasDbt: boolean;
  semanticDir: string;
  layerService: LayerService;
  tableLibraryService: TableLibraryService;
  subjectAreaService: SubjectAreaService;
  manifestService: ManifestService;
}

const SEMANTIC_DIR = '.erd-studio';

/**
 * The project root: a dbt project (the folder holding dbt_project.yml), or a
 * logical-only folder holding .erd-studio/ and no dbt project — the same two
 * kinds of root the extension and the erd-studio CLI open.
 */
export function resolveProjectPath(input: string): string {
  const resolved = path.resolve(input);
  const dbtProjectFile = path.join(resolved, 'dbt_project.yml');
  if (!fs.existsSync(dbtProjectFile) && !fs.existsSync(path.join(resolved, SEMANTIC_DIR))) {
    throw new Error(
      `No dbt project or ${SEMANTIC_DIR}/ folder in ${resolved}. ` +
      `Pass the absolute path to the directory containing dbt_project.yml, or the one containing ${SEMANTIC_DIR}/.`,
    );
  }
  return resolved;
}

export function buildServices(projectPathInput: string): Services {
  const projectPath = resolveProjectPath(projectPathInput);
  const hasDbt = fs.existsSync(path.join(projectPath, 'dbt_project.yml'));
  const layerService = new LayerService(projectPath, SEMANTIC_DIR);
  const tableLibraryService = new TableLibraryService(projectPath, SEMANTIC_DIR);
  const subjectAreaService = new SubjectAreaService(layerService);
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const manifestService = new ManifestService({ enabled: hasDbt });
  return {
    projectPath,
    hasDbt,
    semanticDir: SEMANTIC_DIR,
    layerService,
    tableLibraryService,
    subjectAreaService,
    manifestService,
  };
}
