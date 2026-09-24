# @erd-studio/core

The ERD Studio domain model, shared by the [ERD Studio](https://github.com/liam-machine/erd-studio) VS Code extension and `@erd-studio/renderer`.

It holds:

- the TypeScript types for the on-disk domain format (schema v5 plus `logical-models/*.yml` and `logical-models/{layer}/*.yml`), the layer configuration, the display-ready `DisplayDomain` the canvas renders, the cross-stage discrepancy report, and the edit messages the canvas posts to its host;
- the pure pipeline the extension host uses to turn those files into a `DisplayDomain`: `parseDomainJson`, `validateDomainDocument`, `buildUnifiedDomain`, `toLogicalStage`, `parseLogicalModelText`, `parseLayersText` / `validateLayersConfig`, `computeMissingPositions` and `toDisplayDomain`;
- `loadDisplayDomain`, which does all of that in one call over any async `readFile`.

The package has no Node, `vscode`, React or React Flow dependency (its only dependency is `yaml`), so it runs in a browser, in Node and in bundlers alike.

The on-disk contract is documented in [`docs/semantic-domain-json-reference.md`](https://github.com/liam-machine/erd-studio/blob/main/docs/semantic-domain-json-reference.md).

```ts
import { detectDomainFormat, type DisplayDomain } from '@erd-studio/core';
```

## Loading a domain

```ts
import { loadDisplayDomain } from '@erd-studio/core';

const domain = await loadDisplayDomain({
  domainPath: '.erd-studio/silver/sales.json',   // {semanticDir}/{layer}/{domain}.json
  readFile: async (path) => fetchText(path),       // resolve null when the file does not exist
  readOnly: true,
});
```

`layers.json` and the `logical-models/` library are read from the same semantic directory as the domain file. A model file may sit at the top of the library or one folder down, in a folder named after a layer (`logical-models/gold/fct_order.yml`); names are unique across the library. Since `readFile` cannot list a directory, each model is found by probing `logical-models/{model}.yml`, then `logical-models/{layer}/{model}.yml` for every layer in `layers.json` (and the domain's own) in alphabetical order — the same order the extension uses — taking the first file that exists — a flat library costs one read per model, as before. A folder not named after a layer is only visible to hosts that can list directories (the extension). Each model file is read and parsed once, however often the domain lists it, with at most `maxParallelReads` (8) reads in flight. A model that is missing, unparseable or rejected renders as a placeholder, as it does in the extension.

Bad input rejects with one of four classes, so a host can map them to its own errors:

| Class | When |
|---|---|
| `DomainFileError` | the domain file is missing (`reason: 'missing'`), empty or not JSON |
| `DomainValidationError` | not a loadable domain: not an object, no or a newer `schemaVersion`, a legacy or hybrid layout, an unconfigured layer, a malformed v4 inline model (say, `columns` that is not a list) |
| `TooManyModelsError` | `logical.models` has more than `maxModels` entries (checked before any model file is read) |
| `FileTooLargeError` | the domain file is longer than `maxDomainChars` |

A `readFile` rejection is passed through unchanged. For files you do not control, the options also take:

- `modelNameFilter` (default `isSafeModelName`: no path separators, `..` or control characters); a rejected name is never read.
- `maxDomainChars`, which also applies to `layers.json`: a longer `layers.json` is not parsed, and the default layers are used instead.
- `maxYamlChars` and `maxYamlNodes`. A model file renders as a placeholder when it is longer than `maxYamlChars`, when its scalar text (counting every repeat through an alias) adds up to more than `maxYamlChars`, or when it expands to more than `maxYamlNodes` nodes. Between them they stop anchor/alias expansion bombs, whether they repeat many nodes or one long string (the entries of a `!!pairs` or `!!omap` sequence count as the nodes under them and the text they are read back as). A model the domain lists more than once is charged to both budgets once per listing, as an alias's repeats are; the listings past the budget render as placeholders, so repeating a name cannot make the result larger than the budgets allow one file.
- `ignoreStrayPositions`, which places models that have no position using only the positions of the domain's own models. The extension's placement checks every `viewConfig.positions` entry for every grid cell it tries, so a file listing many entries that name no model makes it slow; with this set, its cost depends only on the model count. The entries are still kept in the result. It defaults to on when any of `maxModels`, `maxYamlNodes`, `maxDomainChars` or `maxYamlChars` is finite, and to off otherwise; pass `false` to place models exactly as the extension does.

Every limit is off by default. The four-class contract above holds for input within the limits: with them all off, input large enough to exhaust the JavaScript engine (for example a domain listing on the order of 100,000 positions) can fail with the engine's own `RangeError` in the extension's placement code. Set every limit for files you do not control. A numeric limit must be a number of at least 0, or `Infinity` for none (`maxParallelReads`: a whole number of at least 1); anything else, `NaN` included, rejects with a `TypeError` before any file is read.

Each occurrence of a model is its own object, but occurrences share the parsed strings. The result keeps `undefined` values; serialise it (for example `JSON.parse(JSON.stringify(domain))`) if you need them dropped. Serialising writes out every occurrence's text, so the serialised size grows with the number of times the domain lists a model (within `maxYamlNodes` and `maxYamlChars` when they are set).

## Development

This package lives in the `packages/core` workspace of the ERD Studio repository. Inside the repository it is consumed from source (TypeScript `paths` and vitest aliases); the published package ships only `dist/`.

```sh
npm run build -w @erd-studio/core       # dist/index.js (esbuild, ESM) + dist/*.d.ts (tsc)
npm run typecheck -w @erd-studio/core
npm test -w @erd-studio/core
```

## License

[PolyForm Shield 1.0.0](./LICENSE), the same licence as the rest of the repository.
