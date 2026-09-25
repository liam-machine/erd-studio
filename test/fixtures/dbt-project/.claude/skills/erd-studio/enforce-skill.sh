#!/usr/bin/env bash
# ERD Studio — PreToolUse hook for Edit and Write tools.
# Blocks the first .erd-studio file edit per Claude Code session to ensure the
# /erd-studio skill is loaded before any changes are made. Every other call
# exits 0 with NO output, so Claude Code's normal permission flow decides —
# this hook only ever denies, it never approves an edit.

deny='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"ERD Studio: load the /erd-studio skill (file-format rules) before editing .erd-studio files, then retry. This is a one-time check per session — the /erd-studio-setup walkthrough expects it."}}'

# Read all stdin (Claude sends hook input JSON via stdin)
input="$(cat)"

# Extract fields from JSON using grep (avoids jq/python dependency)
tool_name="$(echo "$input" | grep -o '"tool_name" *: *"[^"]*"' | head -1 | sed 's/.*: *"//;s/"$//')"
# Claude Code's own Edit and Write only. Copilot can run this hook too when
# it reads Claude hooks (chat.useClaudeHooks), and it ignores the matcher,
# so every other tool name is waved through here.
case "$tool_name" in
  Edit|Write) ;;
  *) exit 0 ;;
esac
file_path="$(echo "$input" | grep -o '"file_path" *: *"[^"]*"' | head -1 | sed 's/.*: *"//;s/"$//')"
session_id="$(echo "$input" | grep -o '"session_id" *: *"[^"]*"' | head -1 | sed 's/.*: *"//;s/"$//')"

# Only act on files inside .erd-studio/ directories. modelling-approach.md is
# free-form notes with no file format, so it needs no skill loaded first.
case "$file_path" in
  */.erd-studio/modelling-approach.md) ;;
  */.erd-studio/*)
    flag="/tmp/.erd-studio-skill-${session_id}"
    if [ ! -f "$flag" ]; then
      touch "$flag"
      echo "$deny"; exit 0
    fi
    ;;
esac

# Not ours to decide: no output, normal permission flow.
exit 0
