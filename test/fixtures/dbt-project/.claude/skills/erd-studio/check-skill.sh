#!/usr/bin/env bash
# ERD Studio — PreToolUse hook for Edit and Write tools.
# Blocks the first erd-studio file edit per Claude session to ensure the
# /erd-studio skill is loaded before any changes are made. Subsequent edits
# in the same session are allowed (flag keyed on parent PID).

# Read all stdin into a variable (Claude sends JSON via stdin)
input="$(cat)"

# Extract file_path — use grep to avoid python3 dependency issues
file_path="$(echo "$input" | grep -o '"file_path" *: *"[^"]*"' | head -1 | sed 's/.*: *"//;s/"$//')"

# Only act on files inside erd-studio/ directories
case "$file_path" in
  */erd-studio/*)
    # One-time block per Claude session (PPID = Claude process)
    flag="/tmp/.erd-studio-skill-${PPID}"
    if [ ! -f "$flag" ]; then
      touch "$flag"
      echo '{"hookSpecificOutput":{"permissionDecision":"deny"},"systemMessage":"BLOCKED: You must load the /erd-studio skill before editing erd-studio files. It contains the two-file editing rules (YAML models vs JSON domains) needed to make correct changes. Run the skill with: /erd-studio — then retry this edit."}'
      exit 0
    fi
    ;;
esac

# Allow all other edits (non-erd-studio files, or subsequent edits after skill loaded)
exit 0
