#!/usr/bin/env bash
# ERD Studio — PreToolUse hook for Edit and Write tools.
# Blocks the first .erd-studio file edit per Claude Code session to ensure the
# /erd-studio skill is loaded before any changes are made. Subsequent edits
# in the same session are allowed (flag keyed on session_id from stdin JSON).

deny='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"You must load the /erd-studio skill before editing .erd-studio files. It contains the two-file editing rules (YAML models vs JSON domains). Run: /erd-studio — then retry."}}'
allow='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":""}}'

# Read all stdin (Claude sends hook input JSON via stdin)
input="$(cat)"

# Extract fields from JSON using grep (avoids jq/python dependency)
file_path="$(echo "$input" | grep -o '"file_path" *: *"[^"]*"' | head -1 | sed 's/.*: *"//;s/"$//')"
session_id="$(echo "$input" | grep -o '"session_id" *: *"[^"]*"' | head -1 | sed 's/.*: *"//;s/"$//')"

# Only act on files inside .erd-studio/ directories
case "$file_path" in
  */.erd-studio/*)
    flag="/tmp/.erd-studio-skill-${session_id}"
    if [ ! -f "$flag" ]; then
      touch "$flag"
      echo "$deny"; exit 0
    fi
    ;;
esac

echo "$allow"
exit 0
