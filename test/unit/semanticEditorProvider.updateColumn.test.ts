/**
 * SemanticEditorProvider.handleUpdateColumn — scdType / additiveType handling.
 *
 * Regression for H13: a canvas inline rename or data-type change posts a
 * column without scdType/additiveType. The host must keep the existing values
 * when those fields are omitted (undefined), clear them on explicit null, and
 * set them when a value is given — for both the V5 (logical-models/) path and
 * the legacy V4 inline path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import type { ColumnDef, SemanticModel } from '../../src/types/semantic';
import type { UpdateColumnPayloadColumn } from '../../src/types/messages';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeColumn(overrides: Partial<ColumnDef> = {}): ColumnDef {
  return {
    name: 'customer_name',
    dataType: 'string',
    description: 'Customer display name',
    isPrimaryKey: false,
    isForeignKey: false,
    isNaturalKey: true,
    scdType: 2,
    additiveType: 'non-additive',
    ...overrides,
  };
}

function makeWebview() {
  const posted: unknown[] = [];
  return {
    webview: { postMessage: async (m: unknown) => { posted.push(m); return true; } } as unknown as vscode.Webview,
    posted,
  };
}

function makeDocument(text: string) {
  return {
    uri: vscode.Uri.file('/ws/.erd-studio/silver/test.json'),
    getText: () => text,
    positionAt: (offset: number) => new vscode.Position(0, offset),
    save: async () => true,
  } as unknown as vscode.TextDocument;
}

/** Build a provider whose logical model service is an in-memory fake. */
function makeProvider(models: SemanticModel[]) {
  const saved: SemanticModel[] = [];
  const logicalModelService = {
    getModel: (name: string) => models.find((m) => m.name === name) ?? null,
    saveModel: (model: SemanticModel) => { saved.push(model); },
  };
  const provider = new SemanticEditorProvider(
    {} as vscode.ExtensionContext,
    {} as never, // domainService
    {} as never, // manifestService
    {} as never, // ymlParserService
    {} as never, // templateService
    {} as never, // layerService
    '/ws',
    {} as never, // selectorsService
    logicalModelService as never,
  );
  // Refreshing the webview needs a live panel + services — not under test here.
  vi.spyOn(provider as unknown as { sendDomainData: () => Promise<void> }, 'sendDomainData')
    .mockResolvedValue(undefined);
  return { provider, saved };
}

interface UpdatePayload {
  modelName: string;
  oldColumnName: string;
  column: UpdateColumnPayloadColumn;
}

async function runUpdate(
  provider: SemanticEditorProvider,
  document: vscode.TextDocument,
  webview: vscode.Webview,
  payload: UpdatePayload,
) {
  await (provider as unknown as {
    handleUpdateColumn: (d: vscode.TextDocument, w: vscode.Webview, p: UpdatePayload, s: 'logical') => Promise<void>;
  }).handleUpdateColumn(document, webview, payload, 'logical');
}

/** The column shape a canvas inline edit posts — no scdType / additiveType keys at all. */
function canvasPayload(overrides: Partial<ColumnDef>): UpdateColumnPayloadColumn {
  const base = makeColumn();
  return {
    name: base.name,
    dataType: base.dataType,
    description: base.description,
    isPrimaryKey: base.isPrimaryKey,
    isForeignKey: base.isForeignKey,
    isNaturalKey: base.isNaturalKey,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// V5 — column lives in logical-models/, written via LogicalModelService
// ---------------------------------------------------------------------------

describe('handleUpdateColumn (V5) scdType / additiveType', () => {
  const v5Document = makeDocument(JSON.stringify({
    schemaVersion: 5,
    domain: 'test',
    layer: 'silver',
    logical: { models: ['dim_customer'], relationships: [] },
  }));

  let provider: SemanticEditorProvider;
  let saved: SemanticModel[];

  beforeEach(() => {
    ({ provider, saved } = makeProvider([{ name: 'dim_customer', columns: [makeColumn()] }]));
  });

  it('keeps existing scdType and additiveType when the payload omits them (canvas type change)', async () => {
    const { webview, posted } = makeWebview();
    await runUpdate(provider, v5Document, webview, {
      modelName: 'dim_customer',
      oldColumnName: 'customer_name',
      column: canvasPayload({ dataType: 'varchar' }),
    });

    expect(posted).toEqual([]);
    expect(saved).toHaveLength(1);
    const col = saved[0].columns![0];
    expect(col.dataType).toBe('varchar');
    expect(col.scdType).toBe(2);
    expect(col.additiveType).toBe('non-additive');
    expect(col.isNaturalKey).toBe(true);
  });

  it('clears scdType and additiveType when the payload sets them to null (detail panel clear)', async () => {
    const { webview } = makeWebview();
    await runUpdate(provider, v5Document, webview, {
      modelName: 'dim_customer',
      oldColumnName: 'customer_name',
      column: { ...canvasPayload({}), scdType: null, additiveType: null },
    });

    const col = saved[0].columns![0];
    expect(col).not.toHaveProperty('scdType');
    expect(col).not.toHaveProperty('additiveType');
  });

  it('overwrites scdType and additiveType when the payload provides values', async () => {
    const { webview } = makeWebview();
    await runUpdate(provider, v5Document, webview, {
      modelName: 'dim_customer',
      oldColumnName: 'customer_name',
      column: { ...canvasPayload({}), scdType: 1, additiveType: 'semi-additive' },
    });

    const col = saved[0].columns![0];
    expect(col.scdType).toBe(1);
    expect(col.additiveType).toBe('semi-additive');
  });

  it('does not invent scdType / additiveType when neither the payload nor the model has them', async () => {
    ({ provider, saved } = makeProvider([
      { name: 'dim_customer', columns: [makeColumn({ scdType: undefined, additiveType: undefined })] },
    ]));
    const { webview } = makeWebview();
    await runUpdate(provider, v5Document, webview, {
      modelName: 'dim_customer',
      oldColumnName: 'customer_name',
      column: canvasPayload({ dataType: 'varchar' }),
    });

    const col = saved[0].columns![0];
    expect(col).not.toHaveProperty('scdType');
    expect(col).not.toHaveProperty('additiveType');
  });
});

// ---------------------------------------------------------------------------
// V4 — legacy inline models, written via WorkspaceEdit
// ---------------------------------------------------------------------------

describe('handleUpdateColumn (V4) scdType / additiveType', () => {
  function v4Document() {
    return makeDocument(JSON.stringify({
      schemaVersion: 4,
      domain: 'test',
      layer: 'silver',
      logical: {
        models: [{ name: 'dim_customer', columns: [makeColumn()] }],
        relationships: [
          { fromModel: 'fct_order', fromColumn: 'customer_name', toModel: 'dim_customer', toColumn: 'customer_name', cardinality: 'many-to-one' },
        ],
      },
    }, null, 2));
  }

  /** Capture the JSON the handler writes through vscode.workspace.applyEdit. */
  function captureWrittenDomain() {
    let written: Record<string, unknown> | null = null;
    vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async (edit: unknown) => {
      const replacements = (edit as vscode.WorkspaceEdit & { _replacements: Array<{ newText: string }> })._replacements;
      written = JSON.parse(replacements[0].newText) as Record<string, unknown>;
      return true;
    });
    return () => {
      const logical = written!.logical as { models: Array<{ columns: ColumnDef[] }> };
      return logical.models[0].columns[0];
    };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps existing scdType and additiveType across a canvas rename', async () => {
    const { provider } = makeProvider([]);
    const readColumn = captureWrittenDomain();
    const { webview, posted } = makeWebview();

    await runUpdate(provider, v4Document(), webview, {
      modelName: 'dim_customer',
      oldColumnName: 'customer_name',
      column: canvasPayload({ name: 'customer_display_name' }),
    });

    expect(posted).toEqual([]);
    const col = readColumn();
    expect(col.name).toBe('customer_display_name');
    expect(col.scdType).toBe(2);
    expect(col.additiveType).toBe('non-additive');
    expect(col.isNaturalKey).toBe(true);
  });

  it('clears scdType and additiveType when the payload sets them to null', async () => {
    const { provider } = makeProvider([]);
    const readColumn = captureWrittenDomain();
    const { webview } = makeWebview();

    await runUpdate(provider, v4Document(), webview, {
      modelName: 'dim_customer',
      oldColumnName: 'customer_name',
      column: { ...canvasPayload({}), scdType: null, additiveType: null },
    });

    const col = readColumn();
    expect(col).not.toHaveProperty('scdType');
    expect(col).not.toHaveProperty('additiveType');
  });

  it('overwrites scdType and additiveType when the payload provides values', async () => {
    const { provider } = makeProvider([]);
    const readColumn = captureWrittenDomain();
    const { webview } = makeWebview();

    await runUpdate(provider, v4Document(), webview, {
      modelName: 'dim_customer',
      oldColumnName: 'customer_name',
      column: { ...canvasPayload({}), scdType: 0, additiveType: 'additive' },
    });

    const col = readColumn();
    expect(col.scdType).toBe(0);
    expect(col.additiveType).toBe('additive');
  });
});
