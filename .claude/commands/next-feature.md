You MUST complete ALL steps below in a single run — selecting the feature, building it, validating, updating features.json, committing, and printing the summary. Do NOT stop, pause, or ask for input between steps. The job is not done until the final summary is printed.

## Step 1 — Select the next feature

1. Parse `features.json` and find the first feature where `status` is `"pending"`, `skip` is not `true`, and all `dependencies` have `status: "completed"` (in ID order). If `$ARGUMENTS` contains a feature ID, select that specific feature instead.
2. If no eligible feature is found, show a progress summary and stop.
3. Print the feature ID, name, and description.

## Step 2 — Build the feature

4. IMMEDIATELY use the `Skill` tool to invoke skill `feature-dev:feature-dev`. You MUST call the Skill tool — do NOT implement the feature yourself and do NOT explore the codebase beforehand. Pass the feature name, description, implementation_notes, and validation_criteria as the `args` string.

## Step 3 — Validate (after feature-dev returns)

The feature-dev skill only writes code. When it returns control to you, you MUST immediately continue with validation — do NOT stop, summarise, or wait for user input.

5. Run the following checks in order. Fix any failures before proceeding.

   **a. Type-check** — `npm run compile` (tsc --noEmit for both tsconfigs). Fix type errors.

   **b. Build** — `npm run build`. Verify both bundles produced without errors.

   **c. Unit tests** — `npm test`. Verify all tests pass.

   **d. Extension Development Host** — If any validation criteria begin with "Verify in Extension Development Host:", launch VS Code with `code --extensionDevelopmentPath="$(pwd)"` and use Chrome browser automation (claude-in-chrome) to verify UI-visible criteria. Skip if the feature is purely backend with no UI criteria.

## Step 4 — Update features.json

6. Update the feature's `status` from `"pending"` to `"completed"` in `features.json`.
7. If all features in the feature's phase now have `status: "completed"`, also update that phase's `status` to `"completed"`.

## Step 5 — Commit

8. Stage all changed files (including `features.json`) and commit (do NOT push):
   ```
   Implement [ID]: [Name]

   [summary of what was built]

   Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
   ```
9. Run `git status` to verify the working tree is clean.

## Step 6 — Summary

Print all of the following:

10. **What was built** — key files changed and important decisions.
11. **Next feature** — the next pending feature in `features.json` and what it involves.
12. **Progress** — total features completed out of total (excluding `skip: true`) and percentage. Format: `**Progress: X / Y features complete (Z%)**`
