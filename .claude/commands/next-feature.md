## Determine the next feature

1. Parse the `features.json` file and find the first feature where `status` is `"pending"`, `skip` is not `true`, and all `dependencies` have `status: "completed"` (in ID order). If `$ARGUMENTS` contains a feature ID, select that specific feature instead.
2. If no eligible feature is found, show a progress summary and stop.
3. Print the feature ID, name, and description so it is clear what will be built.

## Build the feature

4. IMMEDIATELY use the `Skill` tool to invoke skill `feature-dev:feature-dev` to implement the feature. You MUST call the Skill tool — do NOT attempt to implement the feature yourself, and do NOT explore the codebase beforehand. Pass the feature name, description, implementation_notes, and validation_criteria as the `args` string so the feature-dev agent has full context.

## MANDATORY post-implementation steps

**CRITICAL: The feature-dev skill only handles implementation. When it finishes and returns control to you, you MUST continue with ALL of the steps below. Do NOT stop or summarise early — the job is not done until step 11 is complete.**

### Validate

5. Once the feature is implemented, validate it against the `validation_criteria` array defined for that feature in `features.json`. Run the following checks in order:

   **a. Type-check** — Run `npm run compile` (runs `tsc --noEmit` for both extension host and webview tsconfigs). Fix any type errors before continuing.

   **b. Build** — Run `npm run build` and verify both extension host and webview bundles are produced without errors.

   **c. Unit tests** — Run `npm test` and verify all tests pass. If the feature added new test files, confirm they are included in the run.

   **d. Extension Development Host** — Many validation criteria begin with "Verify in Extension Development Host:". These require launching VS Code with the extension loaded. To do this:
      - Run `code --extensionDevelopmentPath="$(pwd)"` to open an Extension Development Host window with the extension side-loaded.
      - Use Chrome browser automation (claude-in-chrome) to interact with the Extension Development Host window and verify UI-visible criteria (sidebar tree views, custom editors, commands in the palette, graph rendering, etc.).
      - If the feature is purely backend/infrastructure with no UI criteria, this step can be skipped.

   **e. Browser verification** — If the feature involves webview or browser-visible changes, use Chrome browser automation (claude-in-chrome) to visually verify the implementation works as expected in the Extension Development Host.

6. Fix any issues found during validation before proceeding.

### Update features.json

7. After validation passes, update the feature's `status` from `"pending"` to `"completed"` in `features.json`. If all features in a phase are completed, update that phase's `status` to `"completed"` as well.

### Commit

8. Stage all changed files and commit (do NOT push) with a descriptive commit message referencing the feature ID and name:
   `Implement [ID]: [Name]\n\n[summary of what was built]\n\nCo-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`
9. Run `git status` to verify the commit succeeded and the working tree is clean.

### Summary

10. Summarise what was implemented, including key files changed and any important decisions made.
11. Identify the next pending feature in `features.json` (the one that would be built on the next run) and explain what it involves, so the developer has context for the next iteration.
12. Give a total number of features complete out of the total features (excluding `skip: true`) and a percentage.
