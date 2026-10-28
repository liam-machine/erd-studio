/**
 * What Convert Project to DBML (native DBML storage, §6.1) reads, from disk:
 * every file under the semantic dir that the single classifier names, with
 * its text. Shared by the extension's command and `erd-studio doctor`'s
 * preview; it generalises `readNamingMigrationInput`. No `vscode`: the CLI
 * bundles it.
 */

import * as fs from 'fs';
import * as path from 'path';

import { LAYERS_CONFIG_FILE, LOGICAL_MODELS_DIR, TABLES_DIR, classifySemanticFile, parseLayersText } from '@erd-studio/core';

import type { DbmlConversionFile, DbmlConversionInput } from './dbmlConversion';
import { tablesDirIsLayer } from './logicalModelService';

/** A file's text with its byte-order mark stripped, and whether it had one; null when it cannot be read. */
function readText(filePath: string): { text: string; hadBom: boolean } | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const hadBom = raw.charCodeAt(0) === 0xfeff;
    return { text: hadBom ? raw.slice(1) : raw, hadBom };
  } catch {
    return null;
  }
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * The planner's input for the semantic dir at `semanticRoot`: `layers.json`,
 * every table (`logical-models/` and `tables/`, top level and one folder
 * down), every relationships file, and every diagram and layout file in a
 * layer folder. An unreadable file is left out.
 */
export function readDbmlConversionInput(workspaceRoot: string, semanticDir: string): DbmlConversionInput {
  const semanticRoot = path.join(workspaceRoot, semanticDir);
  const tablesIsLayer = fs.existsSync(path.join(semanticRoot, TABLES_DIR)) && tablesDirIsLayer(semanticRoot);
  const files: DbmlConversionFile[] = [];
  const add = (rel: string): void => {
    const read = readText(path.join(semanticRoot, ...rel.split('/')));
    if (read === null) return;
    const firstLine = rel.toLowerCase().endsWith('.dbml') ? read.text.split(/\r?\n/)[0] : undefined;
    const cls = classifySemanticFile(rel, { tablesDirIsLayer: tablesIsLayer, ...(firstLine !== undefined ? { firstLine } : {}) });
    if (cls.kind === 'other' || cls.kind === 'template') return;
    files.push({ path: rel, text: read.text, hadBom: read.hadBom, kind: cls.kind, ...(cls.storage ? { storage: cls.storage } : {}) });
  };
  for (const entry of listDir(semanticRoot).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile()) {
      if (entry.name === LAYERS_CONFIG_FILE) add(entry.name);
      continue;
    }
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const library = entry.name === LOGICAL_MODELS_DIR || (entry.name === TABLES_DIR && !tablesIsLayer);
    for (const child of listDir(path.join(semanticRoot, entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.isFile()) {
        add(`${entry.name}/${child.name}`);
      } else if (library && child.isDirectory() && !child.name.startsWith('.')) {
        for (const leaf of listDir(path.join(semanticRoot, entry.name, child.name)).sort((a, b) => a.name.localeCompare(b.name))) {
          if (leaf.isFile()) add(`${entry.name}/${child.name}/${leaf.name}`);
        }
      }
    }
  }
  const layersText = files.find((f) => f.kind === 'layers')?.text ?? null;
  const layers = parseLayersText(layersText, () => { /* doctor reports layers.json itself */ }).map((l) => l.id);
  return { semanticDir, layers, tablesDirIsLayer: tablesIsLayer, files };
}
