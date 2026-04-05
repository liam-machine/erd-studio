#!/usr/bin/env bash
# ERD Studio — PreToolUse hook for Edit and Write tools.
# Blocks the first erd-studio file edit per Claude session to ensure the
# /erd-studio skill is loaded before any changes are made. Subsequent edits
# in the same session are allowed (flag keyed on session ID).

# Read all stdin (Claude sends hook input JSON via stdin)
input="$(cat)"

# Extract file_path using grep (avoids python3/jq dependency)
file_path="$(echo "$input" | grep -o '"file_path" *: *"[^"]*"' | head -1 | sed 's/.*: *"//;s/"$//')"

# Only act on files inside erd-studio/ directories
case "$file_path" in
  */erd-studio/*)
    # One-time block per Claude session ($CLAUDE_SESSION_ID is set by Claude Code)
    session_key="${CLAUDE_SESSION_ID:-$$}"
    flag="/tmp/.erd-studio-skill-${session_key}"
    if [ ! -f "$flag" ]; then
      touch "$flag"
      # Deny with modern hookSpecificOutput format
      echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"You must load the /erd-studio skill before editing erd-studio files. It contains the two-file editing rules (YAML models vs JSON domains). Run: /erd-studio — then retry."}}'
      exit 0
    fi
    ;;
esac

# Allow — modern format to avoid phantom "hook error" label
echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":""}}'
exit 0
