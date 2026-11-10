# Two repos: erd-studio and erd-studio-pro

Read this at step 7 when the fix touches what the Confluence app consumes. Also read it **first**
in a Pi-mode run on an erd-studio-pro issue.

| | liam-machine/erd-studio (public) | liam-machine/erd-studio-pro (private) |
|---|---|---|
| Ships | the extension, the CLI, and `@erd-studio/core` + `@erd-studio/renderer` on npm | the Confluence app (Atlassian Forge), which pins both packages **exactly** |
| PR base | `develop` | `main`. There's no `develop`. |
| A merge | lands on `develop`. Packages publish only when the change reaches **`main`** (`publish-packages.yml`) | **deploys to production**. Say so in every PR body. |
| Repo facts | SKILL.md | `.claude/issue-to-pr.md` in that repo |

**Code and text flow public → private only.** Nothing from erd-studio-pro may reach erd-studio:
not code, file contents, paths, names, issue text, or customer details. That covers every
issue, comment, PR and commit you write in the public repo. Public → private is fine.

## A. From erd-studio: raise the Confluence follow-up issue

**When.** `git diff origin/develop...HEAD` changes something the app consumes:
- shipped package code: `packages/*/src/**`, a `packages/*/package.json`, or the `--vscode-*`
  list in `packages/renderer/README.md`;
- the on-disk format the app reads: a DBML table (`<layer>/tables/<schema>/`), relationships
  file (`<layer>/relationships/`), diagram (`<layer>/diagrams/`) or its `erd_layout` (the DBML
  codec under `packages/core/src/dbml/`, `erdLayout.ts`, `storage.ts`), the subject-area JSON,
  table yml, or `layers.json` (`docs/semantic-domain-json-reference.md`).

Package tests, goldens or docs alone don't count. When in doubt, raise it: Liam closes the
ones that need nothing.

**How.** After the PR opens, look for one already raised for this PR:

```bash
gh api -X GET search/issues -f q='repo:liam-machine/erd-studio-pro in:title "erd-studio#<pr>"' --jq '.items[] | "\(.number) \(.state) \(.html_url)"'
```

If one exists, comment on it with what changed. Otherwise create it. Create the label first; it
does nothing if it already exists:

```bash
gh label create upstream -R liam-machine/erd-studio-pro --color 1D76DB \
  --description "Follow-up for a change in liam-machine/erd-studio" 2>/dev/null
gh issue create -R liam-machine/erd-studio-pro --label upstream \
  --title "erd-studio#<pr>: <what changes for the Confluence app, in plain words>" --body-file "$SCRATCH/pro-issue.md"
```

```markdown
**Upstream:** liam-machine/erd-studio#<pr> (fixing liam-machine/erd-studio#<n>). Not merged yet.

## What changes in `@erd-studio/*`
- **Packages:** core / renderer. **Release:** patch, or a MINOR the PR pins (breaking while 0.x).
- <the change in public terms: exports, `ErdCanvas` props, `DisplaySubjectArea` fields, CSS variables, the on-disk shape>

## What the app needs
- Move the exact pins to the version that carries this, following this repo's upgrade procedure.
- <anything to adopt: a new prop or theme variable; or "nothing beyond the pin bump">
- <whether the domain cache key needs a bump, and why>

## Ready when
erd-studio#<pr> has reached erd-studio `main` and the version is on npm. Packages publish
from `main`, not `develop`. Add `issue-to-pr` then to have the Pi do the bump.
```

- **Never add `issue-to-pr` yourself.** Liam starts every run.
- In the PR body's **Ripple check**, write `⚠️ flagged: Confluence follow-up raised (private
  repo)`. Public text never carries the private issue's number, title or contents. Report the link
  to Liam in your final message, which stays on the Pi.
- **Routine mode** (a cloud session that can't reach the private repo): write the issue body
  into the PR under "Confluence follow-up needed" instead. The product-manager routine raises
  it later.

## B. Running on an erd-studio-pro issue (Pi mode)

- `S` (this skill's scripts) points into the erd-studio clone, and the work happens in the
  erd-studio-pro clone. `issues.py` reads the repo from `origin`. `gh_upload.mjs` works on a
  private repo's PR, because the bot browser is logged in as liam-machine.
- Follow `.claude/issue-to-pr.md` for the base branch, gates, how to film and the PR shape. Where
  it disagrees with SKILL.md, it wins. The council, the ripple audit, the video, the issue reply
  and the RESULT line all work as SKILL.md and pi.md say.

**An `upstream` issue** (titled `erd-studio#<pr>: …`) asks for the pin bump. First check that
the change has been published:

```bash
sha=$(gh api repos/liam-machine/erd-studio/pulls/<pr> --jq .merge_commit_sha)
git -C ~/issue-bot/erd-studio fetch -q --tags --force origin
git -C ~/issue-bot/erd-studio tag --contains "$sha" -l '@erd-studio/*' | sort -V | head
```

- If no tag holds it, the PR hasn't reached `main` or the packages haven't published yet.
  Comment that it's waiting for that release, ask Liam to add `issue-to-pr` again once it's out,
  and end with `RESULT: question <comment url>`.
- If a tag holds it, bump to that version or newer. Don't stop at the version the issue names.

**A fix that belongs in `@erd-studio/*`:** never patch it here. That means no vendored copy, no
`patch-package` and no local fork. Raise the issue in erd-studio instead:
- Title it `Confluence app needs: <the generic behaviour needed>`, with the label
  `downstream`. Create the label (colour `5319E7`) if it's missing. Don't put the private issue's
  number in it.
- Describe it in public terms only: what an embedding page needs from the renderer or the
  loader, a minimal public repro (a fixture domain), and why. None of the private repo's code,
  paths or issue text.
- Then comment on the erd-studio-pro issue with the link, and end with
  `RESULT: question <comment url>`. Liam decides when to run the public fix. Its PR then raises
  the follow-up issue here (section A).
