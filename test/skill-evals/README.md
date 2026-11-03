# Skill evals

Checks of the AI helper's skill text that need a real AI assistant, so they
are run by hand, never by `npm test` or CI (`test/**` never ships in the VSIX).

| Folder | What it evaluates | How it runs |
|---|---|---|
| `erd-studio-setup/` | the `/erd-studio-setup` skill, 25 conversational cases | by hand with skill-creator; see its README |
| `sync-apply/` | SYNC.md: a headless Claude Code applies a sync plan and must land where the deterministic applier does | `npm run eval:sync-ai` (about US$0.50–1 a run): when SYNC.md changes and before a release; see its README |
