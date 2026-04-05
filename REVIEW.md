# Code Review Guidelines

## Always check

- All domain file mutations go through `WorkspaceEdit` for undo/redo integration — never write directly via `fs`
- Physical stage is read-only and derived at runtime — reject any code that persists physical data to disk or allows mutation messages in physical stage
- Relationships in physical stage come entirely from manifest relationship tests, not from logical stage
- Schema changes (fields in `src/types/semantic.ts`, file layout, naming conventions) must update `SCHEMA_CONTENT` in `src/services/harnessService.ts` and bump `HARNESS_VERSION`
- Message protocol changes must update the discriminated unions in `src/types/messages.ts` for both directions
- React Flow custom node/edge types must be defined as module-level constants, not inside component render functions

## Legacy identifiers — do NOT rename

These internal identifiers use the `dbtSemantic` prefix and must not be changed (would break user settings, keybindings, stored state):
- Command IDs: `dbtSemantic.*`
- View IDs: `dbt-semantic`, `dbtSemantic.domainTree`
- Custom editor viewType: `dbtSemantic.domainEditor`
- Setting keys: `dbtSemantic.projectPath`, `dbtSemantic.semanticDir`
- Colour IDs: `dbtSemantic.layer.*`
- Command category: `"category": "dbt"`

## Style

- All colours must use CSS custom properties from `webview/styles/theme.css` — no hardcoded hex/rgb values
- Webview components use BEM CSS class naming (`block__element--modifier`)
- Stage colours are defined in `webview/lib/stageColors.ts` — logical is blue (`#60a5fa`), physical is green (`#22c55e`)
- Shared types live in `src/types/` and are imported by both tsconfigs

## Skip

- Formatting-only changes in lock files
- Changes to `test/fixtures/` sample data files
- Auto-generated version bump commits from the deploy workflow
