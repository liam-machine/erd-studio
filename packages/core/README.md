# @erd-studio/core

The ERD Studio domain model, shared by the [ERD Studio](https://github.com/liam-machine/erd-studio) VS Code extension and `@erd-studio/renderer`.

It holds:

- the TypeScript types for the on-disk domain format (schema v5 plus `logical-models/*.yml`), the layer configuration, the display-ready `DisplayDomain` the canvas renders, the cross-stage discrepancy report, and the edit messages the canvas posts to its host;
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

`layers.json` and `logical-models/{model}.yml` are read from the same semantic directory as the domain file. Each model file is read and parsed once, however often the domain lists it, with at most `maxParallelReads` (8) reads in flight. A model that is missing, unparseable or rejected renders as a placeholder, as it does in the extension.

Bad input rejects with one of four classes, so a host can map them to its own errors:

| Class | When |
|---|---|
| `DomainFileError` | the domain file is missing (`reason: 'missing'`), empty or not JSON |
| `DomainValidationError` | not a loadable domain: not an object, no or a newer `schemaVersion`, a legacy or hybrid layout, an unconfigured layer |
| `TooManyModelsError` | `logical.models` has more than `maxModels` entries (checked before any model file is read) |
| `FileTooLargeError` | the domain file is longer than `maxDomainChars` |

A `readFile` rejection is passed through unchanged. For files you do not control, the options also take `modelNameFilter` (default `isSafeModelName`: no path separators or `..`), `maxYamlChars` and `maxYamlNodes` (a model file over either renders as a placeholder; the node budget stops anchor/alias expansion bombs). Every limit is off by default. The result keeps `undefined` values; serialise it (for example `JSON.parse(JSON.stringify(domain))`) if you need them dropped.

## Development

This package lives in the `packages/core` workspace of the ERD Studio repository. Inside the repository it is consumed from source (TypeScript `paths` and vitest aliases); the published package ships only `dist/`.

```sh
npm run build -w @erd-studio/core       # dist/index.js (esbuild, ESM) + dist/*.d.ts (tsc)
npm run typecheck -w @erd-studio/core
npm test -w @erd-studio/core
```

## License

[PolyForm Shield 1.0.0](./LICENSE), the same licence as the rest of the repository.
