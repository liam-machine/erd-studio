/**
 * SelectorsService — generates a single `selectors.yml` at the dbt project root
 * describing one named selector per ERD Studio domain.
 *
 * Why this instead of tagging model YAMLs:
 *   Adding `tags: [domain:foo]` to a model's schema.yml mutates that node's
 *   parsed hash, which dbt's `state:modified` comparator picks up. For a
 *   conformed dimension shared across many domains, this cascades through
 *   `state:modified+` and rebuilds every downstream model in CI.
 *
 *   `selectors.yml` lives at the project root and is NOT part of any model's
 *   node hash, so regenerating it never marks a model as modified. Users still
 *   refresh a domain with one command:
 *
 *     dbt build --selector domain_silver_customer_360
 *
 * Selector name format: `domain_{layer}_{domain}` with `-` replaced by `_`
 * to match dbt's snake_case convention. The `domain_` prefix is reserved for
 * ERD Studio — selectors with any other name are user-managed and preserved
 * across regenerates (read-merge-write).
 *
 * Skip-on-broken-state policy: when `selectors.yml` is malformed YAML, has no
 * `selectors:` key, has a non-list `selectors:` value, OR is currently open
 * in an editor with unsaved edits, the service refuses to write. It returns
 * a `'skipped'` result with a reason; the host (extension.ts) is expected to
 * surface a notification telling the user how to fix the issue and how to
 * trigger a resync. This is deliberately conservative — we'd rather drift
 * out-of-sync (recoverable, visible) than overwrite user work (irrecoverable).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Document, parseDocument, isSeq, isMap } from 'yaml';
import type { YAMLMap, YAMLSeq, Node, Scalar } from 'yaml';

import type { DomainService } from './domainService';

const SELECTORS_FILENAME = 'selectors.yml';
const GENERATED_PREFIX = 'domain_';
const HEADER_COMMENT =
  ' ERD Studio manages selectors prefixed with `domain_` — regenerated automatically.\n' +
  ' Other selectors below are user-managed and preserved across regenerates.';

interface SelectorDef {
  name: string;
  description: string;
  definition: {
    union: Array<{ method: 'fqn'; value: string }>;
  };
}

export type SkipReason = 'malformed' | 'unsaved-edits';

export interface SkipInfo {
  reason: SkipReason;
  filePath: string;
  /** Human-readable detail (e.g. parse error message). Safe to put in a notification. */
  detail: string;
}

export type RegenerateResult =
  | { status: 'written'; selectorsWritten: number; modelsReferenced: number; filePath: string }
  | { status: 'skipped'; reason: SkipReason; filePath: string; detail: string };

export interface SelectorsServiceHooks {
  /**
   * Return true to refuse the write — used to skip when the file has unsaved
   * edits in an open editor. Receives the absolute path of `selectors.yml`.
   */
  isFileDirtyInEditor?: (filePath: string) => boolean;
  /**
   * Called when regenerate skipped a write because of unsaved edits or a
   * malformed file. Surface a notification, status bar item, etc.
   */
  onSkipped?: (info: SkipInfo) => void;
  /**
   * Called when a regenerate successfully wrote the file. Used to clear any
   * "out of sync" status bar item the host may have shown.
   */
  onWritten?: () => void;
}

type LoadOk = { status: 'ok'; doc: Document; preservedItems: Node[] };
type LoadMalformed = { status: 'malformed'; detail: string };
type LoadResult = LoadOk | LoadMalformed;

export class SelectorsService {
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly domainService: DomainService,
    private readonly workspaceRoot: string,
    private readonly semanticDir: string,
    private readonly hooks?: SelectorsServiceHooks,
  ) {}

  /**
   * Debounced regenerate — coalesces bursts of mutations (e.g. bulk add) into
   * one write. Safe to call from any mutation handler.
   */
  scheduleRegenerate(delayMs = 250): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      try {
        this.regenerate();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[SelectorsService] Regenerate failed: ${msg}`);
      }
    }, delayMs);
  }

  /**
   * Read every domain file, merge with any user-managed selectors already in
   * `selectors.yml`, and write a fresh file at the dbt project root.
   *
   * Selectors with names starting with `domain_` are owned by ERD Studio and
   * fully replaced on each regenerate (so renamed/deleted domains don't
   * leave stale entries). Selectors with any other name are preserved as
   * AST nodes — comments and formatting round-trip across regenerates.
   *
   * Returns a discriminated union:
   *   - `'written'`: file was rewritten. Includes counts.
   *   - `'skipped'`: file was NOT touched. Includes reason and detail. The
   *     host should surface a notification telling the user what to fix and
   *     offering a re-sync action.
   *
   * Skip conditions (any of these):
   *   - `selectors.yml` is open in an editor with unsaved edits
   *     (detected via `hooks.isFileDirtyInEditor`).
   *   - `parseDocument` reports any error (malformed YAML).
   *   - `selectors:` key is missing or its value isn't a list.
   */
  regenerate(): RegenerateResult {
    const filePath = path.join(this.workspaceRoot, SELECTORS_FILENAME);

    // Skip #1: open with unsaved edits.
    if (this.hooks?.isFileDirtyInEditor?.(filePath)) {
      const result: RegenerateResult = {
        status: 'skipped',
        reason: 'unsaved-edits',
        filePath,
        detail: 'File has unsaved edits in an open editor.',
      };
      this.hooks.onSkipped?.(result);
      return result;
    }

    const summaries = this.domainService.listDomains(this.workspaceRoot, this.semanticDir);

    const generated: SelectorDef[] = [];
    let modelsReferenced = 0;

    // Stable ordering: layer then domain name
    const sorted = [...summaries].sort((a, b) =>
      a.layer === b.layer ? a.domain.localeCompare(b.domain) : a.layer.localeCompare(b.layer),
    );

    for (const summary of sorted) {
      let unified;
      try {
        unified = this.domainService.getDomain(summary.filePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[SelectorsService] Skipping ${summary.filePath}: ${msg}`);
        continue;
      }

      const models = unified.logical?.models ?? [];
      if (models.length === 0) {
        continue;
      }

      const seen = new Set<string>();
      const members: Array<{ method: 'fqn'; value: string }> = [];
      for (const model of models) {
        if (seen.has(model.name)) { continue; }
        seen.add(model.name);
        members.push({ method: 'fqn', value: model.name });
      }

      modelsReferenced += members.length;
      generated.push({
        name: this.selectorName(summary.layer, summary.domain),
        description: `All models in the ${summary.domain} domain (${summary.layer} layer). Managed by ERD Studio.`,
        definition: { union: members },
      });
    }

    const loaded = this.loadDocAndExtractUserItems(filePath);

    // Skip #2: malformed file.
    if (loaded.status === 'malformed') {
      const result: RegenerateResult = {
        status: 'skipped',
        reason: 'malformed',
        filePath,
        detail: loaded.detail,
      };
      this.hooks?.onSkipped?.(result);
      return result;
    }

    const { doc, preservedItems } = loaded;

    // Replace the selectors seq's items with [generated, ...preservedItems].
    // Mutating the same doc keeps anchor/alias references resolvable.
    const seq = doc.get('selectors') as YAMLSeq;
    seq.items.length = 0;
    seq.flow = false;
    // Any leading comment was promoted onto a specific item during extraction,
    // so the seq itself should no longer carry it (else it would re-attach
    // above the first generated selector on the next round-trip).
    seq.commentBefore = null;
    for (const gen of generated) {
      seq.add(doc.createNode(gen));
    }
    for (const item of preservedItems) {
      seq.add(item);
    }

    // The whole region above `selectors:` is ERD-Studio-owned. The yaml lib
    // parks comments differently depending on whitespace: a header written
    // without a trailing blank line attaches to the `selectors:` key node,
    // not to the document. Wipe every slot above the seq so HEADER_COMMENT
    // is the only thing that survives there.
    const root = doc.contents;
    if (root && isMap(root)) {
      (root as YAMLMap).commentBefore = null;
      for (const pair of (root as YAMLMap).items) {
        const keyValue = (pair.key as Scalar | undefined)?.value;
        if (keyValue !== 'selectors') { continue; }
        if (pair.key && typeof pair.key === 'object') {
          (pair.key as Scalar).commentBefore = null;
        }
        break;
      }
    }
    doc.commentBefore = HEADER_COMMENT;

    const content = doc.toString({ lineWidth: 0 });
    this.atomicWrite(filePath, content);

    this.hooks?.onWritten?.();

    return {
      status: 'written',
      selectorsWritten: generated.length,
      modelsReferenced,
      filePath,
    };
  }

  /**
   * Parse the existing `selectors.yml` and return either:
   *   - `{ status: 'ok', doc, preservedItems }` — clean parse with usable
   *     selectors seq. `preservedItems` are the AST nodes for every
   *     user-managed selector (name does NOT start with `domain_`).
   *   - `{ status: 'malformed', detail }` — anything else: parse error,
   *     missing `selectors:` key, or non-list `selectors:` value.
   *
   * No file → fresh empty doc, `preservedItems: []`. Empty file → same.
   */
  private loadDocAndExtractUserItems(filePath: string): LoadResult {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { status: 'ok', doc: new Document({ selectors: [] }), preservedItems: [] };
      }
      throw err;
    }

    if (raw.trim() === '') {
      return { status: 'ok', doc: new Document({ selectors: [] }), preservedItems: [] };
    }

    const doc = parseDocument(raw);
    if (doc.errors.length > 0) {
      return { status: 'malformed', detail: doc.errors[0].message };
    }

    const selectorsNode = doc.get('selectors');
    if (selectorsNode === undefined || selectorsNode === null) {
      return { status: 'malformed', detail: 'No top-level `selectors:` key found.' };
    }
    if (!isSeq(selectorsNode)) {
      return { status: 'malformed', detail: '`selectors:` value is not a list.' };
    }

    const seq = selectorsNode as YAMLSeq;

    // The yaml lib stores a comment that appears immediately before the FIRST
    // seq item on the seq itself (`seq.commentBefore`), not on the item.
    // Promote it onto the first item so the comment-to-item binding survives
    // filtering and re-emission. Comments between subsequent items already
    // live on the *next* item's `commentBefore`, which round-trips naturally.
    if (seq.commentBefore && seq.items.length > 0) {
      const firstItem = seq.items[0] as Node | undefined;
      if (firstItem && typeof firstItem === 'object') {
        const existing = firstItem.commentBefore;
        firstItem.commentBefore = existing
          ? `${seq.commentBefore}\n${existing}`
          : seq.commentBefore;
      }
    }

    const preserved: Node[] = [];
    for (const item of seq.items) {
      // Non-map items (bare strings, numbers, etc.) cannot be ours by shape
      // — preserve verbatim. Better to keep something we don't understand
      // than to delete user data.
      if (!isMap(item)) {
        preserved.push(item as Node);
        continue;
      }
      const nameNode = (item as YAMLMap).get('name', true) as Scalar | undefined;
      const nameValue = nameNode?.value;
      const nameStr = typeof nameValue === 'string' ? nameValue : '';
      // Missing/non-string `name` → cannot be ours → preserve.
      if (!nameStr.startsWith(GENERATED_PREFIX)) {
        preserved.push(item as Node);
      }
    }

    return { status: 'ok', doc, preservedItems: preserved };
  }

  /**
   * Selector name format — dbt-friendly snake_case. dbt requires selector
   * names to be identifier-safe. Domain slugs are already validated at
   * creation time, but layer IDs come from user-editable layers.json and
   * may contain arbitrary characters (dots, spaces, slashes, etc.), so we
   * defensively replace anything non-alphanumeric with `_` and collapse/trim.
   */
  private selectorName(layer: string, domain: string): string {
    const sanitize = (s: string): string =>
      s
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
    return `domain_${sanitize(layer)}_${sanitize(domain)}`;
  }

  /** Write via temp file + rename so a crash never leaves a partial selectors.yml. */
  private atomicWrite(filePath: string, content: string): void {
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }
}
