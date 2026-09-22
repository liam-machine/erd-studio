# @erd-studio/renderer

The entity-relationship diagram canvas from the [ERD Studio](https://github.com/liam-machine/erd-studio) VS Code extension, packaged for reuse. It is built on React Flow and renders a `DisplayDomain` from `@erd-studio/core`.

> This package is being extracted from the extension's webview. The API documentation (the `ErdCanvas` viewer component, the `/editor`, `/store` and `/sizing` entry points, and the `--vscode-*` CSS variables a host page must define) is added as the code moves in.

## Development

This package lives in the `packages/renderer` workspace of the ERD Studio repository. Inside the repository it is consumed from source (TypeScript `paths` and vitest aliases); the published package ships only `dist/`.

```sh
npm run build -w @erd-studio/renderer       # dist/*.js (esbuild, ESM), dist/styles.css, dist/types/*.d.ts
npm run typecheck -w @erd-studio/renderer
npm test -w @erd-studio/renderer
```

## License

[PolyForm Shield 1.0.0](./LICENSE), the same licence as the rest of the repository.
