/**
 * What Convert Project to DBML (native DBML storage, §6.1) reads, from disk:
 * every file under the semantic dir that the single classifier names, with
 * its text. Shared by the extension's command and `erd-studio doctor`'s
 * preview; it generalises `readNamingMigrationInput`. No `vscode`: the CLI
 * bundles it.
 */

import * as fs from 'fs';
import * as path from 'path';

import { LAYERS_CONFIG_FILE, LOGICAL_MODELS_DIR, TABLES_DIR, classifySemanticFile, parseLayersText, parseTableText } from '@erd-studio/core';

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
  const misnamedTables: Array<{ path: string; name: string }> = [];
  const add = (rel: string, inLibrary = false): void => {
    const read = readText(path.join(semanticRoot, ...rel.split('/')));
    if (read === null) return;
    const firstLine = rel.toLowerCase().endsWith('.dbml') ? read.text.split(/\r?\n/)[0] : undefined;
    const cls = classifySemanticFile(rel, { tablesDirIsLayer: tablesIsLayer, ...(firstLine !== undefined ? { firstLine } : {}) });
    if (cls.kind === 'other' && inLibrary) {
      const name = misnamedTableName(rel, read.text);
      if (name !== undefined) misnamedTables.push({ path: rel, name });
    }
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
        add(`${entry.name}/${child.name}`, library);
      } else if (library && child.isDirectory() && !child.name.startsWith('.')) {
        for (const leaf of listDir(path.join(semanticRoot, entry.name, child.name)).sort((a, b) => a.name.localeCompare(b.name))) {
          if (leaf.isFile()) add(`${entry.name}/${child.name}/${leaf.name}`, true);
        }
      }
    }
  }
  const layersText = files.find((f) => f.kind === 'layers')?.text ?? null;
  const layers = parseLayersText(layersText, () => { /* doctor reports layers.json itself */ }).map((l) => l.id);
  return { semanticDir, layers, tablesDirIsLayer: tablesIsLayer, files, ...(misnamedTables.length > 0 ? { misnamedTables } : {}) };
}

/**
 * The table files in the library (top level and one folder down) named `.yaml`
 * or `.YML` (see {@link misnamedTableName}), by path. For doctor, which does not
 * read the whole conversion input.
 */
export function listMisnamedTableFiles(semanticRoot: string): Array<{ path: string; name: string }> {
  const tablesIsLayer = fs.existsSync(path.join(semanticRoot, TABLES_DIR)) && tablesDirIsLayer(semanticRoot);
  const out: Array<{ path: string; name: string }> = [];
  const check = (rel: string): void => {
    if (!/\.ya?ml$/i.test(rel) || rel.endsWith('.yml')) return;
    const read = readText(path.join(semanticRoot, ...rel.split('/')));
    const name = read === null ? undefined : misnamedTableName(rel, read.text);
    if (name !== undefined) out.push({ path: rel, name });
  };
  for (const dir of [LOGICAL_MODELS_DIR, ...(tablesIsLayer ? [] : [TABLES_DIR])]) {
    for (const child of listDir(path.join(semanticRoot, dir)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.isFile()) check(`${dir}/${child.name}`);
      else if (child.isDirectory() && !child.name.startsWith('.')) {
        for (const leaf of listDir(path.join(semanticRoot, dir, child.name)).sort((a, b) => a.name.localeCompare(b.name))) {
          if (leaf.isFile()) check(`${dir}/${child.name}/${leaf.name}`);
        }
      }
    }
  }
  return out;
}

/**
 * The table a library file holds when it is a table file in all but its name's
 * ending (`.yaml`, or `.yml` in another case, such as `.YML`): ERD Studio's
 * table library never lists it. Undefined for any other file (or one that does
 * not read as a table).
 */
export function misnamedTableName(rel: string, text: string): string | undefined {
  const file = rel.slice(rel.lastIndexOf('/') + 1);
  if (!/\.ya?ml$/i.test(file) || file.endsWith('.yml')) return undefined;
  try {
    const table = parseTableText(text, file.replace(/\.ya?ml$/i, ''), { duplicateKeys: 'last' });
    return table && typeof table.name === 'string' && table.name !== '' ? table.name : undefined;
  } catch {
    return undefined;
  }
}
