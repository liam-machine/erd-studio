# @erd-studio/core

The ERD Studio domain model, shared by the [ERD Studio](https://github.com/liam-machine/erd-studio) VS Code extension and `@erd-studio/renderer`.

It currently holds the TypeScript types for the on-disk domain format (schema v5 plus `logical-models/*.yml`), the layer configuration, the display-ready `DisplayDomain` the canvas renders, the cross-stage discrepancy report, and the edit messages the canvas posts to its host. It also exports the few pure helpers those types come with, such as `detectDomainFormat` and `DEFAULT_LAYERS`.

The package has no Node, `vscode`, React or React Flow dependency, so it runs in a browser, in Node and in bundlers alike.

The on-disk contract is documented in [`docs/semantic-domain-json-reference.md`](https://github.com/liam-machine/erd-studio/blob/main/docs/semantic-domain-json-reference.md).

```ts
import { detectDomainFormat, type DisplayDomain } from '@erd-studio/core';
```

## Development

This package lives in the `packages/core` workspace of the ERD Studio repository. Inside the repository it is consumed from source (TypeScript `paths` and vitest aliases); the published package ships only `dist/`.

```sh
npm run build -w @erd-studio/core       # dist/index.js (esbuild, ESM) + dist/*.d.ts (tsc)
npm run typecheck -w @erd-studio/core
npm test -w @erd-studio/core
```

## License

[PolyForm Shield 1.0.0](./LICENSE), the same licence as the rest of the repository.
