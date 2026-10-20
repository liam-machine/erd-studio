#!/usr/bin/env bash
# The ERD Studio Telegram session: a long-lived Claude Code session in ~/erd-bot whose CLAUDE.md
# (steward.md beside this file) makes it Liam's assistant for erd-studio and erd-studio-pro.
# Liam's messages to the ERD Studio bot reach it through the Telegram channel plugin. The issue
# bot (run.sh) sends its messages as the same bot, so he can answer one in the same chat.
#
# This bot's state (token, allowlist) is in its own folder, so it runs beside any other Telegram
# channel session on the Pi without touching it. erd-tg.service runs this file in tmux:
#   tmux capture-pane -t erd-tg -pS -40     see what it's doing
#   tmux attach -t erd-tg                   Ctrl-b d to detach
#
# claude is restarted when it exits, at most 5 times an hour; past that this stops and says so on
# Telegram, so a lasting failure (an expired login) stays visible instead of looping.
set -uo pipefail

ERD="$HOME/erd-bot"
export TELEGRAM_STATE_DIR="$HOME/.claude/channels/telegram-erd"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
unset WAYLAND_DISPLAY
cd "$ERD" || exit 1

# The token stays in the plugin's .env, which it reads itself: claude's environment never has it.
# Alerts start with 🤖, like run.sh's notifications, so Liam can tell them from the session's replies.
alert() {
  local token chat
  token=$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$TELEGRAM_STATE_DIR/.env" 2> /dev/null)
  chat=$(sed -n 's/^TELEGRAM_CHAT_ID=//p' "$HOME/.config/issue-bot/env" 2> /dev/null)
  [ -n "$token" ] && [ -n "$chat" ] || return 0
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" \
    | curl -sS -m 20 -o /dev/null -K - --data-urlencode "chat_id=$chat" --data-urlencode "text=🤖 $1" || true
}

# The instructions come from develop, like run.sh, so a merged change reaches the next start.
# git show reads the commit without touching the session's working tree.
refresh_instructions() {
  local new="$ERD/CLAUDE.md.new"
  git -C "$ERD/erd-studio" fetch -q origin \
    && git -C "$ERD/erd-studio" show origin/develop:.claude/skills/issue-to-pr/scripts/pi/steward.md > "$new" 2> /dev/null \
    && [ -s "$new" ] && mv "$new" "$ERD/CLAUDE.md"
  rm -f "$new"
}

starts=()
while true; do
  refresh_instructions
  rc=0
  claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions || rc=$?
  echo "claude exited with code $rc at $(date -Is)" >&2
  now=$(date +%s); recent=()
  for t in ${starts[@]+"${starts[@]}"}; do (( now - t < 3600 )) && recent+=("$t"); done
  starts=(${recent[@]+"${recent[@]}"})
  if (( ${#starts[@]} >= 5 )); then
    alert "⚠️ The ERD Studio session stopped (exit $rc) and restarted 5 times this hour, so it's given up. Restart it: systemctl --user restart erd-tg"
    exit 1
  fi
  starts+=("$now")
  alert "⚠️ The ERD Studio session exited (code $rc). Restarting it."
  sleep 10
done
