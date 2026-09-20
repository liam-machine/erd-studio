# Issue #64 — validation recording

`validation.webm` (1:12) and the stills beside it were produced by replaying the
message stream a **real `SemanticEditorProvider`** posted into the **real
`dist/webview.js`** bundle, once for the pre-fix build (`v1.0.3`) and once for
this branch. Nothing on screen is a mock-up of a canvas: the only staged input
is the state of the domain file on disk, and the only output is what the
provider actually sent.

## How it was made

1. A recorder driving the real provider and the real services over a temp copy
   of `test/fixtures/dbt-project` captured every `postMessage`, with timings,
   for three scenarios:
   - **midwrite** — the domain file is zero bytes when the canvas opens, and the
     content lands 200 ms later (the writer's timing is the only input; nothing
     tells the provider to wait);
   - **empty** — the domain file is empty and stays empty;
   - **template** — `.erd-studio/templates/fact.json` opened from the explorer,
     which the custom editor's `**/.erd-studio/*/*.json` selector matches.
2. The same recorder ran unchanged against `origin/main` (v1.0.3) and this
   branch, giving two recordings.
3. Each recording was replayed into its own build's `dist/webview.js` in
   Chromium, with `acquireVsCodeApi` mocked only to deliver those messages and
   to surface what the webview posts back.
4. Every claim the captions make is asserted against the live DOM during the
   recording — a mismatch aborts the run rather than narrating something untrue.

The only cosmetic change is that the temp fixture path (`/tmp/erd-rec-XXXXXX`)
is rewritten to `~/medical` so the error text is legible at video size.

## What the recordings showed

| Scenario | v1.0.3 | This branch |
|---|---|---|
| midwrite | `error` at 142 ms — `Unexpected end of JSON input` | `domainLoaded` at 345 ms — no error ever shown |
| empty | `error` — `Invalid JSON in domain file …: Unexpected end of JSON input` | `error` — `Domain file is empty: …`, kind `domain-file`, with **Open as Text** |
| template | `error` — judged as a broken domain | `error` — `fact.json is not an ERD domain file …`, kind `not-a-domain`, **Open as Text** and no Retry |
