#!/usr/bin/env bash
# REPRO helper: the smallest `node --stack-size` (KB) at which one raw ELK
# layout (no fallbacks) of a generated diagram succeeds, per strategy and rung.
# A Chromium dedicated Worker is about --stack-size=500 (see browser.cjs).
#   scripts/repro-layout-stack/minstack.sh <shape> <tables> <rels> <strategy> <seed> <rung>
here="$(cd "$(dirname "$0")" && pwd)"
lo=40; hi=${MAX_STACK:-4000}
ok() { node --stack-size="$1" "$here/frames.cjs" "$2" "$3" "$4" "$5" "$6" "$7" 2>/dev/null | head -1 | grep -q '^OK'; }
if ! ok "$hi" "$@"; then echo ">$hi"; exit 0; fi
while (( hi - lo > 10 )); do mid=$(( (lo + hi) / 2 )); if ok "$mid" "$@"; then hi=$mid; else lo=$mid; fi; done
echo "$hi"
