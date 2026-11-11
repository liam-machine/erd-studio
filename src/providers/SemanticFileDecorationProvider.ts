import * as vscode from 'vscode';
import * as path from 'path';

import { classifySemanticFile } from '@erd-studio/core';

import type { LayerService } from '../services/layerService';
import type { TableFileEntry } from '../services/logicalModelService';
import { otherLayerCounts, tableHomesById, tableHomesOf } from '../services/tableHomes';
import { plural } from '../services/logger';
import type { TableUsageKeys } from '../services/sidebarTables';
import { tableIdOfEntry } from '../services/tableLibraryIndex';
import type { TableId } from '../types/tableId';

/**
 * Where the Explorer's tooltips get their counts: the Table Library's
 * listing and caches, and the diagrams' member names. Every call here is
 * made from a background pass ({@link SemanticFileDecorationProvider}),
 * never while VS Code asks for a decoration.
 */
export interface ExplorerFactsSource {
  /** The library's table files, listed (not read). */
  listTableFiles(): readonly TableFileEntry[];
  /** A table's warehouse name (`alias`) when its file has been read already; never a read. Told apart by identity, the table is named by its TableId. */
  peekAlias?(name: TableId | string): string | undefined;
  /** Every diagram, with its layer. */
  listDiagrams(): ReadonlyArray<{ filePath: string; layer: string }>;
  /** A diagram's member table names (cached by file version); may throw for a file that cannot be read. */
  diagramMembers(filePath: string): string[] | null;
  /**
   * How tables and diagram members are matched (`tableUsageOf`). Optional:
   * without it (or by name), by the names {@link diagramMembers} gives. Told
   * apart by identity, a table file is counted on the diagrams whose `use`
   * lines read it, never on those showing another schema folder's table of its name.
   */
  usage?(): TableUsageKeys;
  /** The library's relationships files (`<layer>/relationships/*.dbml`). */
  listRelationshipsFiles?(): readonly string[];
  /** How many relationships (Refs) a relationships file holds, or undefined when it does not read. */
  relationshipsCount?(filePath: string): number | undefined;
}

/** What the tooltips say beyond the path: read in the background, a slice at a time. */
interface ExplorerFacts {
  readonly tables: ReadonlyMap<string, { name: string; schema: string; alias?: string; diagrams: number }>;
  readonly diagrams: ReadonlyMap<string, { tables: number; others: ReadonlyArray<{ layer: string; count: number }> }>;
  readonly relationships: ReadonlyMap<string, number>;
}

/** Where the provider is: the project's own semantic dir, and how `tables/` is read there. */
export interface SemanticFileDecorationOptions {
  /**
   * The project's semantic dir, absolute. With it only paths under it are
   * decorated, so a folder of the same name in another project of the
   * workspace (or a test fixture) never shows this project's layers. Without
   * it any `/<semanticDir>/` in a path matches, and layer folders get a tooltip but no badge.
   */
  semanticRoot?: string;
  /** Whether `tables/` is a layer folder rather than the YAML library (`TableLibraryService.tablesDirIsLayer`). */
  tablesDirIsLayer?: () => boolean;
}

/**
 * The Explorer's mark for each part of the layer-first tree, shown as the
 * decoration's badge. VS Code allows a badge two characters and no codicons,
 * and git's letters (M, U, A) share the spot, so these are symbols, not letters.
 * A kind's folder and its files share a mark (`diagrams/` and its diagrams), as
 * the tree already shows which is a folder; table files have none (see below).
 */
export const EXPLORER_MARKS = {
  layer: '≡',
  schema: '◫',
  table: '⊞',
  relationships: '⇄',
  diagram: '◇',
} as const;

/** How long one slice of the background pass may run before it yields. */
const FACTS_SLICE_MS = 30;
/** How long a refresh waits for more changes before reading the facts again. */
const FACTS_DEBOUNCE_MS = 300;

/** The key a file's facts are kept under: its absolute path, case folded (names are unique without case). */
const factKey = (filePath: string): string => path.resolve(filePath).toLowerCase();

/**
 * A mark ({@link EXPLORER_MARKS}; on a layer folder, after its stage number)
 * and a tooltip for the files and folders of the semantic dir in the Explorer, in the words the
 * sidebar uses: a layer folder ("Layer 2 of 3: Silver"), its `tables/`,
 * schema, `relationships/` and `diagrams/` folders, and each table,
 * relationships and diagram file. Colours are intentionally omitted so the
 * Explorer keeps its normal look; the sidebar draws the layer colours.
 *
 * Read-only and fast: a decoration is worked out from the path and the last
 * background read of the counts (diagram usage, warehouse names, Refs per
 * file), which {@link refresh} schedules again; it fires
 * `onDidChangeFileDecorations` when new counts are in.
 */
export class SemanticFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  /** Configured semantic dir, normalised to forward slashes with no leading `./` or trailing `/`. */
  private readonly semanticDir: string;
  /** {@link SemanticFileDecorationOptions.semanticRoot}, `/`-separated with no trailing `/`. */
  private readonly semanticRoot: string | undefined;

  /** The last complete background read (kept while the next one runs, so tooltips never flicker). */
  private facts: ExplorerFacts | undefined;
  /** A decoration has asked for counts: only then are they read (and read again on a refresh). */
  private wanted = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private building = false;
  /** A refresh came while a read was running: read again after it. */
  private again = false;
  private disposed = false;

  constructor(
    private readonly layerService: LayerService,
    semanticDir: string = '.erd-studio',
    /** Where the counts come from. Optional: without it the tooltips name the files only. */
    private readonly source?: ExplorerFactsSource,
    private readonly options: SemanticFileDecorationOptions = {},
  ) {
    this.semanticDir = semanticDir
      .replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/\/+$/, '') || '.erd-studio';
    this.semanticRoot = options.semanticRoot !== undefined
      ? options.semanticRoot.replace(/\\/g, '/').replace(/\/+$/, '')
      : undefined;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme && uri.scheme !== 'file') return undefined;
    const rel = this.relativeToSemanticDir(uri.fsPath);
    if (rel === null || rel === '') return undefined;
    const segments = rel.split('/');
    const layerId = segments[0];
    const layer = this.layerService.getLayer(layerId);
    if (!layer) return undefined;
    const label = layer.label;

    if (segments.length === 1) {
      return rel.includes('.') ? undefined : this.layerFolderDecoration(layerId, label);
    }

    // Folders of the layer-first tree, by path (a decoration is never told whether a path is a folder).
    if (segments.length === 2) {
      if (segments[1] === 'tables') return { badge: EXPLORER_MARKS.table, tooltip: `Tables of the ${label} layer, one folder per schema` };
      if (segments[1] === 'relationships') return { badge: EXPLORER_MARKS.relationships, tooltip: `Relationships of the ${label} layer: each is stored once, with its foreign-key table` };
      if (segments[1] === 'diagrams') return { badge: EXPLORER_MARKS.diagram, tooltip: `Diagrams of the ${label} layer` };
    }
    if (segments.length === 3 && segments[1] === 'tables' && !/\.dbml$/i.test(segments[2])) {
      const schema = segments[2];
      return { badge: EXPLORER_MARKS.schema, tooltip: `Schema ${schema} in the ${label} layer: each table is declared Table ${schema}.<name>` };
    }

    // Files: what the one classifier calls them, by path alone.
    // The first segment is a configured layer here; `tables/` is still the YAML library unless the library says otherwise.
    const tablesDirIsLayer = layerId === 'tables' && (this.options.tablesDirIsLayer?.() ?? true);
    const kind = classifySemanticFile(rel, { tablesDirIsLayer });
    if (kind.kind === 'diagram') return { badge: EXPLORER_MARKS.diagram, tooltip: this.diagramTooltip(uri.fsPath, label) };
    if (kind.kind === 'table' && kind.storage === 'dbml' && kind.schema !== undefined) {
      // No mark on a table file: the Table Library's rows point at these files, so a badge would
      // show on every row there too, beside the table icon they already have. Its folders carry the mark.
      return { tooltip: this.tableTooltip(uri.fsPath, kind.schema, kind.name ?? path.basename(uri.fsPath, '.dbml')) };
    }
    if (kind.kind === 'relationships') {
      const count = this.factsFor()?.relationships.get(factKey(uri.fsPath));
      return { badge: EXPLORER_MARKS.relationships, tooltip: `Relationships of the ${label} layer${count !== undefined ? ` (${count})` : ''}` };
    }
    return undefined;
  }

  /**
   * A layer folder: the layer mark after its stage number (layers.json order),
   * and what it holds. The number shows only on this project's own layer
   * folders, and a badge is at most two characters, so from stage 10 it is the
   * number alone and past 99 the mark alone.
   */
  private layerFolderDecoration(layerId: string, label: string): vscode.FileDecoration {
    const listed = typeof this.layerService.configFileExists !== 'function' || this.layerService.configFileExists();
    const layers = listed && typeof this.layerService.getAllLayers === 'function' ? this.layerService.getAllLayers() : [];
    const index = layers.findIndex((l) => l.id === layerId);
    if (index === -1) return { badge: EXPLORER_MARKS.layer, tooltip: `The ${label} layer — its tables, relationships and diagrams` };
    const stage = index + 1;
    const numbered = this.semanticRoot !== undefined;
    const badge = !numbered || stage > 99 ? EXPLORER_MARKS.layer : stage <= 9 ? `${stage}${EXPLORER_MARKS.layer}` : String(stage);
    return {
      badge,
      tooltip: `Layer ${stage} of ${layers.length}: ${label} — its tables, relationships and diagrams`,
    };
  }

  private tableTooltip(filePath: string, schema: string, stem: string): string {
    const fact = this.factsFor()?.tables.get(factKey(filePath));
    const name = fact?.name ?? stem;
    const alias = fact?.alias && fact.alias.toLowerCase() !== name.toLowerCase() ? fact.alias : undefined;
    const usage = fact === undefined ? '' : ` — on ${fact.diagrams === 0 ? 'no diagram' : plural(fact.diagrams, 'diagram')}`;
    return `${schema}.${name}${alias ? ` (warehouse table ${alias})` : ''}${usage}`;
  }

  private diagramTooltip(filePath: string, label: string): string {
    const fact = this.factsFor()?.diagrams.get(factKey(filePath));
    if (!fact) return `A diagram in the ${label} layer`;
    const others = fact.others.map((o) => `, ${o.count} from ${this.layerService.getLayer(o.layer)?.label ?? o.layer}`).join('');
    return `A diagram in the ${label} layer: ${plural(fact.tables, 'table')}${others}`;
  }

  /** The last background read of the counts, asking for one the first time a decoration needs them. */
  private factsFor(): ExplorerFacts | undefined {
    if (!this.source) return undefined;
    if (!this.wanted) {
      this.wanted = true;
      this.schedule(0);
    }
    return this.facts;
  }

  private schedule(delay: number): void {
    if (this.disposed || !this.source) return;
    if (this.building) {
      this.again = true;
      return;
    }
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.readFacts();
    }, delay);
  }

  /** Read the counts a slice at a time, then ask VS Code for the decorations again. Never writes. */
  private async readFacts(): Promise<void> {
    const source = this.source;
    if (!source || this.disposed) return;
    this.building = true;
    this.again = false;
    try {
      const entries = source.listTableFiles();
      const keys = source.usage?.();
      const byIdentity = keys?.byIdentity === true;
      // By identity, homes and counts are keyed by each table's identity (`TableUsageKeys.keyOf`), not its name.
      const homes = byIdentity ? tableHomesById(entries) : tableHomesOf(entries);
      const order = typeof this.layerService.getAllLayers === 'function' ? this.layerService.getAllLayers().map((l) => l.id) : [];
      const usage = new Map<string, number>();
      const diagrams = new Map<string, { tables: number; others: ReadonlyArray<{ layer: string; count: number }> }>();
      let started = Date.now();
      const breathe = async (): Promise<void> => {
        if (Date.now() - started < FACTS_SLICE_MS) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
        started = Date.now();
      };
      for (const diagram of source.listDiagrams()) {
        await breathe();
        if (this.disposed) return;
        let names: string[] | null;
        try {
          names = byIdentity ? keys!.membersOf(diagram.filePath) : source.diagramMembers(diagram.filePath);
        } catch {
          continue;
        }
        if (!names) continue;
        const unique = [...new Set(names.map((n) => n.toLowerCase()))];
        for (const name of unique) usage.set(name, (usage.get(name) ?? 0) + 1);
        diagrams.set(factKey(diagram.filePath), { tables: unique.length, others: otherLayerCounts(unique, diagram.layer, homes, order) });
      }
      const tables = new Map<string, { name: string; schema: string; alias?: string; diagrams: number }>();
      for (const entry of entries) {
        if (entry.layer === undefined || entry.shadowedBy) continue;
        await breathe();
        if (this.disposed) return;
        const alias = source.peekAlias?.(byIdentity ? tableIdOfEntry(entry) : entry.name);
        tables.set(factKey(entry.filePath), {
          name: entry.name,
          schema: entry.folder,
          ...(alias ? { alias } : {}),
          diagrams: usage.get(byIdentity ? keys!.keyOf({ name: entry.name, filePath: entry.filePath }) : entry.name.toLowerCase()) ?? 0,
        });
      }
      const relationships = new Map<string, number>();
      for (const file of source.listRelationshipsFiles?.() ?? []) {
        await breathe();
        if (this.disposed) return;
        const count = source.relationshipsCount?.(file);
        if (count !== undefined) relationships.set(factKey(file), count);
      }
      this.facts = { tables, diagrams, relationships };
    } catch {
      // A listing that fails leaves the last counts (or none): the tooltips still name the files.
    } finally {
      this.building = false;
    }
    if (this.disposed) return;
    this._onDidChangeFileDecorations.fire(undefined);
    if (this.again) this.schedule(FACTS_DEBOUNCE_MS);
  }

  /**
   * The path relative to the configured semantic dir (`/`-separated), or
   * null when it is not under it. With a {@link semanticRoot} only that
   * folder counts; without one the last `/<semanticDir>/` in the path wins,
   * so a semantic dir inside a folder of the same name still resolves.
   */
  private relativeToSemanticDir(fsPath: string): string | null {
    const normalised = fsPath.replace(/\\/g, '/');
    if (this.semanticRoot !== undefined) {
      // Paths are compared without case where the file system usually ignores it.
      const fold = process.platform === 'win32' || process.platform === 'darwin';
      const at = fold ? normalised.toLowerCase() : normalised;
      const root = fold ? this.semanticRoot.toLowerCase() : this.semanticRoot;
      if (at === root) return '';
      if (!at.startsWith(`${root}/`)) return null;
      return normalised.substring(this.semanticRoot.length + 1).replace(/\/+$/, '');
    }
    const marker = `/${this.semanticDir}/`;
    const idx = normalised.lastIndexOf(marker);
    if (idx === -1) return null;
    return normalised.substring(idx + marker.length).replace(/\/+$/, '');
  }

  /**
   * Ask VS Code for the decorations again (a layer's label or order may have
   * changed), and read the counts again shortly (a table, relationship or
   * diagram may have changed).
   */
  refresh(): void {
    this._onDidChangeFileDecorations.fire(undefined);
    this.refreshFacts();
  }

  /** Read the counts again shortly, once the library or the diagrams changed; the decorations update when they are in. */
  refreshFacts(): void {
    if (this.wanted) this.schedule(FACTS_DEBOUNCE_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this._onDidChangeFileDecorations.dispose();
  }
}
