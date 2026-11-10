/**
 * What Convert Project to DBML (native DBML storage, §6.1) reads, from disk:
 * every file under the semantic dir that the single classifier names, with
 * its text. Shared by the extension's command and `erd-studio doctor`'s
 * preview; it generalises `readNamingMigrationInput`. No `vscode`: the CLI
 * bundles it.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { LOGICAL_MODELS_DIR, SEMANTIC_README_NAME, TABLES_DIR, classifySemanticFile, parseLayersText, parseTableText } from '@erd-studio/core';

import type { DbmlConversionFile, DbmlConversionInput } from './dbmlConversion';
import { detectLegacyDbmlTree } from './legacyDbmlTree';
import { tablesDirIsLayer } from './logicalModelService';
import { listSemanticFiles } from './semanticFiles';

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
 * the README, every YAML table (`logical-models/` and `tables/`, top level
 * and one folder down), every JSON diagram, and every DBML table,
 * relationships file and diagram of the layer-first tree, as
 * `listSemanticFiles` lists and classifies them (by path; no file is read to
 * classify it). The 1.9 pre-release's files are named, for the planner's
 * refusal. An unreadable file is left out.
 */
export function readDbmlConversionInput(workspaceRoot: string, semanticDir: string): DbmlConversionInput {
  const semanticRoot = path.join(workspaceRoot, semanticDir);
  const tablesIsLayer = fs.existsSync(path.join(semanticRoot, TABLES_DIR)) && tablesDirIsLayer(semanticRoot);
  const files: DbmlConversionFile[] = [];
  const misnamedTables: Array<{ path: string; name: string }> = [];
  let readmeInOtherCase = false;
  const add = (rel: string, inLibrary = false): void => {
    if (rel !== SEMANTIC_README_NAME && rel.toLowerCase() === SEMANTIC_README_NAME.toLowerCase()) readmeInOtherCase = true;
    const read = readText(path.join(semanticRoot, ...rel.split('/')));
    if (read === null) return;
    const cls = classifySemanticFile(rel, { tablesDirIsLayer: tablesIsLayer });
    if (cls.kind === 'other' && inLibrary) {
      const name = misnamedTableName(rel, read.text);
      if (name !== undefined) misnamedTables.push({ path: rel, name });
    }
    if (cls.kind === 'other' || cls.kind === 'template') return;
    files.push({ path: rel, text: read.text, hadBom: read.hadBom, kind: cls.kind, ...(cls.storage ? { storage: cls.storage } : {}) });
  };
  walkConversionFiles(semanticRoot, tablesIsLayer, add);
  const layersText = files.find((f) => f.kind === 'layers')?.text ?? null;
  const layers = parseLayersText(layersText, () => { /* doctor reports layers.json itself */ }).map((l) => l.id);
  const legacy = detectLegacyDbmlTree(semanticRoot);
  return {
    semanticDir, layers, tablesDirIsLayer: tablesIsLayer, files,
    ...(misnamedTables.length > 0 ? { misnamedTables } : {}),
    ...(legacy && legacy.files.length > 0 ? { legacyDbmlFiles: legacy.files } : {}),
    ...(readmeInOtherCase ? { readmeInOtherCase } : {}),
  };
}

/**
 * Every file Convert reads, in byte order (relative, posix): what
 * `listSemanticFiles` lists, with no first-line reads. `inLibrary` says
 * whether it is in the YAML library (`logical-models/`, and `tables/` unless
 * it is a layer), at its top or one folder down.
 */
function walkConversionFiles(semanticRoot: string, tablesIsLayer: boolean, visit: (rel: string, inLibrary: boolean) => void): void {
  for (const { rel } of listSemanticFiles(semanticRoot, { tablesDirIsLayer: tablesIsLayer })) {
    const segments = rel.split('/');
    const library = segments.length <= 3 && (segments[0] === LOGICAL_MODELS_DIR || (segments[0] === TABLES_DIR && !tablesIsLayer)) && segments.length >= 2;
    visit(rel, library);
  }
}

/**
 * How close to the moment a fingerprint is taken a file's modification time
 * may be before its stamp is not trusted: a file system that records whole
 * seconds (HFS+) or two seconds (FAT, exFAT, some network mounts) can give
 * two writes in one tick the same time, and a same-size edit the same stamp.
 */
export const FINGERPRINT_RACY_MS = 3000;

/**
 * A fingerprint of everything Convert reads: each file's path, modification
 * time and size, and whether `tables/` is a layer. Equal fingerprints mean
 * the plan made from the first still holds, so Convert applies it without
 * planning again; any file added, removed or written (by ERD Studio, git, an
 * AI helper or another window) changes it. A file written within
 * {@link FINGERPRINT_RACY_MS} of `now` (git's "racy clean" rule) makes the
 * fingerprint one no later one equals, so Convert plans again rather than
 * trust a stamp a coarse clock may not have moved.
 */
export function dbmlConversionFingerprint(workspaceRoot: string, semanticDir: string, now: number = Date.now()): string {
  const semanticRoot = path.join(workspaceRoot, semanticDir);
  const tablesIsLayer = fs.existsSync(path.join(semanticRoot, TABLES_DIR)) && tablesDirIsLayer(semanticRoot);
  const hash = crypto.createHash('sha256');
  hash.update(`tablesIsLayer:${tablesIsLayer}\n`);
  let racy = false;
  walkConversionFiles(semanticRoot, tablesIsLayer, (rel) => {
    let stamp = 'unreadable';
    try {
      const stat = fs.statSync(path.join(semanticRoot, ...rel.split('/')));
      stamp = `${stat.mtimeMs}:${stat.size}`;
      if (stat.mtimeMs > now - FINGERPRINT_RACY_MS) racy = true;
    } catch { /* gone since it was listed */ }
    hash.update(`${rel}\u0000${stamp}\n`);
  });
  if (racy) hash.update(`racy:${crypto.randomUUID()}`);
  return hash.digest('hex');
}

/**
 * The fingerprint the Convert offer remembers a dead end by (a run that was
 * refused or could only list files to fix): every file's path, and the
 * time and size of each YAML table and JSON diagram, the files Convert
 * converts and lists to fix. A DBML file's stamp is left out (its diagram's
 * positions are in it), so opening and arranging a diagram does not bring
 * the offer back; fixing, adding or removing a file does.
 */
export function dbmlConversionOfferFingerprint(workspaceRoot: string, semanticDir: string): string {
  const semanticRoot = path.join(workspaceRoot, semanticDir);
  const tablesIsLayer = fs.existsSync(path.join(semanticRoot, TABLES_DIR)) && tablesDirIsLayer(semanticRoot);
  const hash = crypto.createHash('sha256');
  hash.update(`tablesIsLayer:${tablesIsLayer}\n`);
  walkConversionFiles(semanticRoot, tablesIsLayer, (rel) => {
    const lower = rel.toLowerCase();
    let stamp = '';
    if (!lower.endsWith('.dbml')) {
      try {
        const stat = fs.statSync(path.join(semanticRoot, ...rel.split('/')));
        stamp = `${stat.mtimeMs}:${stat.size}`;
      } catch { stamp = 'unreadable'; }
    }
    hash.update(`${rel}\u0000${stamp}\n`);
  });
  return hash.digest('hex');
}

/** What the Convert offer needs to know, without reading or planning anything. */
export interface DbmlConversionCandidates {
  /** `.yml` tables in the library and `.json` diagrams in layer folders: the files Convert would convert. */
  files: number;
  /** A layer called `tables`: Convert would refuse, so it is not offered. */
  tablesDirIsLayer: boolean;
}

/**
 * The files Convert would convert, counted from the listing alone (§6.4's
 * offer): no file is read and nothing is planned, so it costs a few
 * directory reads however big the project is. The full plan is made only
 * when the user asks to convert.
 */
export function countDbmlConversionCandidates(workspaceRoot: string, semanticDir: string): DbmlConversionCandidates {
  const semanticRoot = path.join(workspaceRoot, semanticDir);
  const tablesIsLayer = fs.existsSync(path.join(semanticRoot, TABLES_DIR)) && tablesDirIsLayer(semanticRoot);
  let files = 0;
  walkConversionFiles(semanticRoot, tablesIsLayer, (rel) => {
    if (rel.toLowerCase().endsWith('.dbml')) return;
    const cls = classifySemanticFile(rel, { tablesDirIsLayer: tablesIsLayer });
    if ((cls.kind === 'table' && cls.storage === 'yaml') || (cls.kind === 'diagram' && cls.storage === 'json')) files++;
  });
  return { files, tablesDirIsLayer: tablesIsLayer };
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
