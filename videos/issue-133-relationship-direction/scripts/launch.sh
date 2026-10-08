#!/bin/bash
# usage: launch.sh before|after   — fresh demo copy, then VS Code on it with that build
SCRATCH=<work>
side=$1; U="<short-tmp>/i2pv"
pkill -f "$U/ud" 2>/dev/null; sleep 2; pkill -9 -f "$U/ud" 2>/dev/null; sleep 1
DEST="$SCRATCH/${DEST:-demo}"; rm -rf "$DEST"; cp -R "$SCRATCH/${2:-demo-template}" "$DEST"
"/Applications/Visual Studio Code.app/Contents/MacOS/Code" --remote-debugging-port=9333 \
  --user-data-dir="$U/ud" --extensions-dir="$U/exts" --extensionDevelopmentPath="$SCRATCH/ext-$side" \
  --new-window "$DEST" > "$SCRATCH/code.log" 2>&1 &
for i in $(seq 1 40); do curl -s 127.0.0.1:9333/json/list | grep -q workbench && break; sleep 1; done; sleep 8
curl -s 127.0.0.1:9333/json/list | python3 -c "import json,sys; [print(t['type'], t['url'][:110]) for t in json.load(sys.stdin)]"
