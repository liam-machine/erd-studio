## ERD Studio

Before editing any file inside `erd-studio/` — including domain JSON files (`erd-studio/{layer}/*.json`), model YAML definitions (`erd-studio/logical-models/*.yml`), or sync plans — **always load the `/erd-studio` skill first**. The erd-studio directory uses a two-file system (YAML for model definitions, JSON for domain diagrams and relationships) with strict format rules. Editing the wrong file is the most common mistake.

<!-- erd-studio-harness: 12 -->
