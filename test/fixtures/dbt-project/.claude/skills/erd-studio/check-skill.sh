#!/usr/bin/env bash
# ERD Studio — PreToolUse hook for Edit and Write tools.
# Blocks the first erd-studio file edit per Claude session to ensure the
# /erd-studio skill is loaded before any changes are made. Subsequent edits
# in the same session are allowed (flag keyed on parent PID).
set -euo pipefail

input=$(cat)

# Extract file_path from tool input JSON
file_path=$(python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" <<< "$input" 2>/dev/null)

# Only act on files inside erd-studio/ directories
case "$file_path" in
  */erd-studio/*)
    # One-time block per Claude session (PPID = Claude process)
    flag="/tmp/.erd-studio-skill-${PPID}"
    if [ ! -f "$flag" ]; then
      touch "$flag"
      cat <<'HOOK_JSON'
{
  "hookSpecificOutput": {
    "permissionDecision": "deny"
  },
  "systemMessage": "BLOCKED: Load the /erd-studio skill before editing erd-studio files. It contains the two-file editing rules (YAML models vs JSON domains) needed to make correct changes. Run: /erd-studio — then retry this edit."
}
HOOK_JSON
      exit 0
    fi
    ;;
esac
