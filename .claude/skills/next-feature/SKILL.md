---
name: next-feature
description: >
  Implement the next feature from features.json using Anthropic's feature-dev agent.
  Invoke with /next-feature or /next-feature F102 for a specific feature.
---

## Determine the next feature

1. Parse the `features.json` file and find the first feature where `status` is `"pending"`, `skip` is not `true`, and all `dependencies` have `status: "completed"` (in ID order). If `<args>` contains a feature ID, select that specific feature instead.
2. If no eligible feature is found, show a progress summary and stop.
3. Print the feature ID, name, and description so it is clear what will be built.

## Build the feature

4. IMMEDIATELY use the `Skill` tool to invoke skill `feature-dev:feature-dev` to implement the feature. You MUST call the Skill tool — do NOT attempt to implement the feature yourself, and do NOT explore the codebase beforehand. Pass the feature name, description, implementation_notes, and validation_criteria as the `args` string so the feature-dev agent has full context.

## Validate

5. Once the feature is implemented, validate it against the `validation_criteria` array defined for that feature in `features.json`.
6. If the feature involves UI or browser-visible changes, use Chrome browser automation (claude-in-chrome) to visually verify the implementation works as expected.
7. Fix any issues found during validation before proceeding.

## Update features.json

8. After validation passes, update the feature's `status` from `"pending"` to `"completed"` in `features.json`. If all features in a phase are completed, update that phase's `status` to `"completed"` as well.

## Commit

9. Commit all changes (do NOT push) with a descriptive commit message referencing the feature ID and name:
   `Implement [ID]: [Name]\n\n[summary of what was built]\n\nCo-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`

## Summary

10. Summarise what was implemented, including key files changed and any important decisions made.
11. Identify the next pending feature in `features.json` (the one that would be built on the next run) and explain what it involves, so the developer has context for the next iteration.
12. Give a total number of features complete out of the total features (excluding `skip: true`) and a percentage.
