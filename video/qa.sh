#!/usr/bin/env bash
# Review aids for a finished render (writes to build/qa/, never to the shipped media):
#   contact.png      one frame from the middle of every scene, 4x3
#   scene-NN.png     the same frames at full size, for checking clipping / overflow / spacing
#   A/V check        speech onsets measured in the MIXED narration (silencedetect) against the
#                    line start times every visual beat is keyed to — catches a mix that drifted
#                    from the timeline the player was rendered with.
set -euo pipefail
cd "$(dirname "$0")"
MP4=../media/onboarding/getting-started.mp4
QA=build/qa
mkdir -p "$QA"
rm -f "$QA"/scene-*.png

TIMES=$(node -e "
const t=require('./build/timeline.json');
const pts=t.scenes.map(s=>s.start+s.dur*0.72);
pts.push(t.scenes.at(-1).start+1.5);
console.log(pts.map(x=>x.toFixed(2)).join(' '))")
i=0; INPUTS=()
for T in $TIMES; do
  F=$(printf "%s/scene-%02d.png" "$QA" "$i")
  ffmpeg -v error -y -ss "$T" -i "$MP4" -frames:v 1 "$F"
  INPUTS+=(-i "$F"); i=$((i+1))
done
N=$i
LAYOUT=$(node -e "const n=$N,w=480,h=270;console.log(Array.from({length:n},(_,k)=>(k%4*w)+'_'+(Math.floor(k/4)*h)).join('|'))")
FILTER=$(node -e "const n=$N;console.log(Array.from({length:n},(_,k)=>'['+k+':v]scale=480:270[s'+k+']').join(';')+';'+Array.from({length:n},(_,k)=>'[s'+k+']').join('')+'xstack=inputs='+n+':layout=$LAYOUT:fill=black')")
ffmpeg -v error -y "${INPUTS[@]}" -filter_complex "$FILTER" -frames:v 1 "$QA/contact.png"
echo "contact sheet: $QA/contact.png ($N frames)"

# A/V: speech onsets vs line starts
ffmpeg -hide_banner -i build/narration.wav -af silencedetect=noise=-40dB:d=0.1 -f null - 2>&1 \
  | sed -n 's/.*silence_end: \([0-9.]*\).*/\1/p' > "$QA/onsets.txt"
node -e "
const t=require('./build/timeline.json');
const on=require('fs').readFileSync('$QA/onsets.txt','utf8').trim().split('\n').map(Number);
on.unshift(0);
let worst=0; const rows=[];
for (const s of t.scenes) for (const l of s.lines) {
  const at=s.start+l.t; const near=on.reduce((a,b)=>Math.abs(b-at)<Math.abs(a-at)?b:a);
  const d=near-at; worst=Math.max(worst,Math.abs(d)); rows.push([l.id,at.toFixed(2),near.toFixed(2),(d>=0?'+':'')+d.toFixed(3)]);
}
for (const r of rows) console.log(r[0].padEnd(14), 'line', r[1].padStart(6), ' onset', r[2].padStart(6), ' ', r[3]);
console.log('worst |onset - line start| =', worst.toFixed(3)+'s');
process.exit(worst > 0.12 ? 1 : 0);
"
