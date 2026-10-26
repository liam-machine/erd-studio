/**
 * Export a domain file as Mermaid or DBML — the one host-side entry point the
 * palette commands, the canvas and the `erd-studio export` CLI share.
 *
 * The domain is read exactly as the canvas's logical stage reads it
 * (`SubjectAreaService.getSubjectArea` → `buildLogicalDisplaySubjectArea`, the same core
 * `computeSubjectAreaDiff` uses), so library relationships are merged and a link
 * stored twice is drawn from the same winner. The text itself comes from
 * `@erd-studio/core`'s `exportDiagram`, which every host shares; a rich DBML
 * export (`dbml-rich`) also carries its `.dbdiagram` layout file.
 *
 * `exportSubjectAreaFiles` exports several domains at once (**Export All
 * Diagrams…** and `erd-studio export --all`): one file per domain (two for
 * rich DBML), named by `exportFileNames` so no two collide.
 *
 * Read-only: nothing is written. No `vscode` import — this module is bundled
 * into `dist/cli.js`.
 */

import {
  DIAGRAM_EXPORT_FILE_EXTENSIONS,
  DIAGRAM_EXPORT_FORMATS,
  computeMissingPositions,
  dbdiagramLayoutFileName,
  diagramExportFileName,
  exportDiagram,
  serializeDbdiagramLayout,
  toDbmlRich,
} from '@erd-studio/core';
import type { DbtKeyIndex, DiagramExportFormat } from '@erd-studio/core';

import type { LayerConfig } from '../types/layer';
import { SubjectAreaService } from './domainService';
import { buildLogicalDisplaySubjectArea } from './stageDisplay';

/** The extension of dbdiagram's layout file, written beside a rich DBML export. */
export const DBDIAGRAM_LAYOUT_EXTENSION = 'dbdiagram';

/** A rich DBML export's layout file: dbdiagram's `<name>.dbdiagram`. */
export interface DiagramLayoutExport {
  /** e.g. `showcase.dbdiagram` — the same base as the `.dbml`, which `dbdiagram push` relies on. */
  fileName: string;
  /** The layout JSON, ending in a newline. */
  content: string;
  /**
   * The DBML again, its header naming `layoutFileName` as the layout file
   * beside it: for a `.dbml` saved under another name. `''` names none (text
   * with no layout file beside it, such as a clipboard copy).
   */
  dbmlWithLayoutFileName(layoutFileName: string): string;
}

export interface SubjectAreaExport {
  /** The export text, ending in a newline. */
  content: string;
  /** A safe file name for it, e.g. `showcase.dbml`. */
  fileName: string;
  /** The domain's name as the domain file gives it. */
  domainName: string;
  /** The domain's layer. */
  layer: string;
  /** `dbml-rich` only: the layout file that goes beside the `.dbml`. */
  layout?: DiagramLayoutExport;
}

export interface ExportSubjectAreaFileOptions {
  /**
   * dbt's key evidence (#133 L1), as the canvas and `computeSubjectAreaDiff` pass
   * it: with it, a link stored twice with no key flagged is exported from the
   * copy the canvas draws. Optional — without it the read is the same one
   * `getSubjectArea` makes for any caller that does not pass it.
   */
  dbtKeyIndex?: DbtKeyIndex;
  /**
   * The project's layers (a `LayerService`), so the export knows the
   * domain's layer colour and label as the canvas shows them: rich DBML
   * writes them on the layer's `TableGroup`. Without it the group has no
   * colour and is labelled with the layer id. Mermaid and portable DBML do
   * not use them.
   */
  layers?: { getLayer(id: string): LayerConfig | undefined };
}

/**
 * The logical (design) stage of the domain at `domainPath` in `format`.
 *
 * Throws what `SubjectAreaService.getSubjectArea` throws (`SubjectAreaFileError`, an
 * unsupported-format or unknown-layer error), and an `Error` for a format
 * that is not in `DIAGRAM_EXPORT_FORMATS` — before reading anything.
 */
export async function exportSubjectAreaFile(
  subjectAreaService: SubjectAreaService,
  domainPath: string,
  format: DiagramExportFormat,
  options: ExportSubjectAreaFileOptions = {},
): Promise<SubjectAreaExport> {
  if (!DIAGRAM_EXPORT_FORMATS.includes(format)) {
    throw new Error(`Unknown diagram export format: ${String(format)}`);
  }
  const unified = subjectAreaService.getSubjectArea(domainPath, options.dbtKeyIndex ? { dbtKeyIndex: options.dbtKeyIndex } : {});
  // A model with no stored position is placed as the canvas places it on
  // open (and as core's loader does), so the layout file has every table.
  // Only the export's own copy of the view: nothing is written.
  const computed = computeMissingPositions(unified);
  const viewConfig = computed
    ? { ...unified.viewConfig, positions: { ...(unified.viewConfig.positions ?? {}), ...computed } }
    : unified.viewConfig;
  const display = buildLogicalDisplaySubjectArea(
    SubjectAreaService.toLogicalStage(unified), viewConfig, unified.stubColumns, options.dbtKeyIndex,
  );
  // As the canvas attaches it to the logical stage it posts.
  const layerConfig = options.layers?.getLayer(display.layer);
  if (layerConfig) { display.layerConfig = layerConfig; }
  const result: SubjectAreaExport = {
    content: exportDiagram(display, format),
    fileName: diagramExportFileName(display, format),
    domainName: display.domain,
    layer: display.layer,
  };
  if (format === 'dbml-rich') {
    result.layout = {
      fileName: dbdiagramLayoutFileName(display),
      content: serializeDbdiagramLayout(display),
      dbmlWithLayoutFileName: (layoutFileName) => toDbmlRich(display, { layoutFileName }),
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Several domains at once
// ---------------------------------------------------------------------------

/** One file of a multi-domain export. */
export interface ExportedFile {
  /** The domain file it came from. */
  domainPath: string;
  /** The diagram text, or (rich DBML) its `.dbdiagram` layout file. */
  kind: 'diagram' | 'layout';
  /** Unique within the export, ignoring case. */
  fileName: string;
  /** The text, ending in a newline. */
  content: string;
}

/** A domain a multi-domain export skipped because it could not be read. */
export interface SkippedSubjectArea {
  domainPath: string;
  /** What `exportSubjectAreaFile` threw. */
  error: unknown;
}

export interface SubjectAreaFilesExport {
  /** By layer, then domain file; a rich DBML file is followed by its layout file. */
  files: ExportedFile[];
  skipped: SkippedSubjectArea[];
}

/**
 * The file names for exporting each of `subjectAreas` in `format`, in the
 * same order and unique ignoring case (file systems on macOS and Windows
 * ignore it):
 *
 * 1. `diagramExportFileName` — the domain name, `showcase.dbml`;
 * 2. when two domains give the same name (the same name in two layers), each
 *    of those becomes `<layer>-<name>`, `silver-showcase.dbml`;
 * 3. a name still taken gets `-2`, `-3`, … in the order given.
 *
 * Deterministic: the same list always gives the same names. A rich DBML
 * export's layout file takes the same base (`silver-showcase.dbdiagram`).
 */
export function exportFileNames(
  subjectAreas: ReadonlyArray<{ domainName: string; layer: string }>,
  format: DiagramExportFormat,
): string[] {
  const key = (name: string) => name.toLowerCase();
  const plain = subjectAreas.map((s) => diagramExportFileName({ domain: s.domainName }, format));
  const counts = new Map<string, number>();
  for (const name of plain) counts.set(key(name), (counts.get(key(name)) ?? 0) + 1);
  const preferred = plain.map((name, i) => (counts.get(key(name))! > 1
    ? diagramExportFileName({ domain: `${subjectAreas[i].layer}-${subjectAreas[i].domainName}` }, format)
    : name));

  // Every name first wanted is reserved, so a numbered name never takes
  // one that a later domain wanted for itself.
  const wanted = new Set(preferred.map(key));
  const taken = new Set<string>();
  const extension = `.${DIAGRAM_EXPORT_FILE_EXTENSIONS[format] ?? 'txt'}`;
  return preferred.map((name) => {
    let chosen = name;
    if (taken.has(key(chosen))) {
      const base = name.endsWith(extension) ? name.slice(0, -extension.length) : name;
      for (let n = 2; ; n++) {
        chosen = `${base}-${n}${extension}`;
        if (!taken.has(key(chosen)) && !wanted.has(key(chosen))) break;
      }
    }
    taken.add(key(chosen));
    return chosen;
  });
}

/** The layout file's name for a rich DBML file named `dbmlFileName`: `silver-showcase.dbml` → `silver-showcase.dbdiagram`. */
export function layoutFileNameFor(dbmlFileName: string): string {
  const base = dbmlFileName.replace(/\.[^./\\]*$/, '');
  return `${base || dbmlFileName}.${DBDIAGRAM_LAYOUT_EXTENSION}`;
}

/**
 * Export every domain in `domainPaths` in `format`, by layer then domain
 * file. A domain that cannot be read is skipped and listed in `skipped` (in
 * the order given) — one broken file never stops the rest. File names come from {@link exportFileNames}; when a rich DBML file
 * is renamed to keep it unique, its header names the renamed layout file.
 *
 * Throws only for a format outside `DIAGRAM_EXPORT_FORMATS`, before reading
 * anything.
 */
export async function exportSubjectAreaFiles(
  subjectAreaService: SubjectAreaService,
  domainPaths: readonly string[],
  format: DiagramExportFormat,
  options: ExportSubjectAreaFileOptions = {},
): Promise<SubjectAreaFilesExport> {
  if (!DIAGRAM_EXPORT_FORMATS.includes(format)) {
    throw new Error(`Unknown diagram export format: ${String(format)}`);
  }
  const read: Array<{ domainPath: string; exported: SubjectAreaExport }> = [];
  const skipped: SkippedSubjectArea[] = [];
  for (const domainPath of domainPaths) {
    try {
      read.push({ domainPath, exported: await exportSubjectAreaFile(subjectAreaService, domainPath, format, options) });
    } catch (error) {
      skipped.push({ domainPath, error });
    }
  }
  // Layer then file, so the files (and any `-2` names) come out the same on
  // every run and every machine, whatever order the folders were listed in.
  read.sort((a, b) => compareText(a.exported.layer, b.exported.layer) || compareText(a.domainPath, b.domainPath));
  return { files: filesOf(read, format), skipped };
}

/** Code-unit order: the same on every machine, unlike `localeCompare`. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The files for domains already exported (`exportSubjectAreaFile` results),
 * named by {@link exportFileNames}. Exposed for the palette command, which
 * reads each domain through its own binding.
 */
export function filesOf(
  read: ReadonlyArray<{ domainPath: string; exported: SubjectAreaExport }>,
  format: DiagramExportFormat,
): ExportedFile[] {
  const names = exportFileNames(read.map((r) => r.exported), format);
  const files: ExportedFile[] = [];
  read.forEach(({ domainPath, exported }, i) => {
    const fileName = names[i];
    const layout = exported.layout;
    if (!layout) {
      files.push({ domainPath, kind: 'diagram', fileName, content: exported.content });
      return;
    }
    const layoutFileName = layoutFileNameFor(fileName);
    const renamed = layoutFileName !== layout.fileName;
    files.push({
      domainPath,
      kind: 'diagram',
      fileName,
      content: renamed ? layout.dbmlWithLayoutFileName(layoutFileName) : exported.content,
    });
    files.push({ domainPath, kind: 'layout', fileName: layoutFileName, content: layout.content });
  });
  return files;
}
