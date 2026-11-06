#!/usr/bin/env bash
# Encodes the shipped video and poster from build/master.mkv + build/narration.wav, then
# asserts the result with ffprobe. Audio is MP3-in-MP4: the one audio codec VS Code documents
# for webview video (AAC plays silently; Opus-in-MP4 is undocumented, and a user reported no
# sound while it was the shipped codec) — see README.md.
#
#   bash encode.sh                 build media/onboarding/getting-started.mp4 + poster
#   bash encode.sh --placeholder   2 s test pattern + tone through the same encoder and checks
#                                  (lets the Welcome panel be wired up before the real render)
#   VARIANT=logical bash encode.sh the cut for a folder without dbt: build-logical/ in,
#                                  media/onboarding/getting-started-logical.mp4 + poster out
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
OUT="$ROOT/media/onboarding"
# VARIANT picks the cut (build-timeline.mjs CUTS): unset is build/ -> getting-started.*,
# e.g. logical is build-logical/ -> getting-started-logical.*.
VARIANT="${VARIANT:-}"
if [[ -z "$VARIANT" ]]; then B=build; NAME=getting-started; else B="build-$VARIANT"; NAME="getting-started-$VARIANT"; fi
MP4="$OUT/$NAME.mp4"
POSTER="$OUT/$NAME-poster.jpg"
MAX_BYTES=$((9 * 1024 * 1024))
mkdir -p "$OUT" "$B"
export B

VIDEO_OPTS=(-c:v libx264 -preset slow -tune animation -profile:v high -level 4.1 -pix_fmt yuv420p -r 30 -g 150)
AUDIO_OPTS=(-c:a libmp3lame -b:a 64k -ac 1 -ar 44100)

if [[ "${1:-}" == "--placeholder" ]]; then
  ffmpeg -v error -y -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=2" -f lavfi -i "sine=frequency=440:duration=2:sample_rate=44100" \
    "${VIDEO_OPTS[@]}" -crf 30 "${AUDIO_OPTS[@]}" -movflags +faststart -shortest "$MP4"
  ffmpeg -v error -y -f lavfi -i "testsrc2=size=1280x720:rate=1" -frames:v 1 -q:v 3 "$POSTER"
  EXPECT_DUR=2
else
  [[ -f $B/master.mkv && -f $B/narration.wav ]] || { echo "run capture.mjs and build-timeline.mjs first" >&2; exit 1; }
  EXPECT_DUR=$(node -e "console.log(require('./'+process.env.B+'/timeline.json').total)")
  # Voice only, no background music: build-timeline.mjs already normalised build/narration.wav
  # (two-pass linear loudnorm to -16 LUFS / -1.5 dBTP), so it goes in as it is.
  AUDIO_IN=$B/narration.wav
  for CRF in 20 22 24 26; do
    ffmpeg -v error -y -i $B/master.mkv -i "$AUDIO_IN" -map 0:v -map 1:a \
      "${VIDEO_OPTS[@]}" -crf "$CRF" "${AUDIO_OPTS[@]}" -movflags +faststart -shortest "$MP4"
    SIZE=$(stat -f %z "$MP4" 2>/dev/null || stat -c %s "$MP4")
    echo "crf $CRF -> $SIZE bytes"
    (( SIZE <= MAX_BYTES )) && break
  done
  # Poster: the opening (hook) scene once everything on it has landed, just before the next
  # scene. Never the end card: its "Install ERD Studio" chip reads wrong to someone who has.
  POSTER_T=$(node -e "const t=require('./'+process.env.B+'/timeline.json');console.log(Math.max(0,t.scenes[1].start-0.6).toFixed(3))")
  ffmpeg -v error -y -ss "$POSTER_T" -i $B/master.mkv -frames:v 1 -vf "scale=1280:720:flags=lanczos,format=yuvj420p" -q:v 3 "$POSTER"
fi

# ---- assertions -------------------------------------------------------------------------
fail() { echo "encode.sh: $*" >&2; exit 1; }
probe() { ffprobe -v error -select_streams "$1" -show_entries "stream=$2" -of default=nw=1:nk=1 "$3"; }
[[ "$(probe v:0 codec_name "$MP4")" == h264 ]] || fail "video codec is not h264"
[[ "$(probe v:0 profile "$MP4")" == High ]] || fail "h264 profile is not High"
[[ "$(probe v:0 pix_fmt "$MP4")" == yuv420p ]] || fail "pix_fmt is not yuv420p"
[[ "$(probe a:0 codec_name "$MP4")" == mp3 ]] || fail "audio codec is not mp3 (never aac: VS Code cannot decode it)"
[[ "$(probe a:0 sample_rate "$MP4")" == 44100 ]] || fail "audio is not 44.1 kHz"
[[ "$(probe a:0 channels "$MP4")" == 1 ]] || fail "audio is not mono"
SIZE=$(stat -f %z "$MP4" 2>/dev/null || stat -c %s "$MP4")
(( SIZE <= MAX_BYTES )) || fail "mp4 is $SIZE bytes, over the 9 MiB ceiling even at crf 26"
DUR=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$MP4")
node -e "process.exit(Math.abs($DUR - $EXPECT_DUR) <= 0.25 ? 0 : 1)" || fail "duration $DUR s, expected $EXPECT_DUR s"
# faststart: the moov atom must precede mdat so the webview can start playing before the end loads
node -e "const b=require('fs').readFileSync('$MP4');const m=b.indexOf('moov'),d=b.indexOf('mdat');process.exit(m>0&&m<d?0:1)" || fail "moov atom is not at the front (+faststart)"
[[ "$(probe v:0 codec_name "$POSTER")" == mjpeg ]] || fail "poster is not a JPEG"
[[ "$(probe v:0 width "$POSTER")x$(probe v:0 height "$POSTER")" == 1280x720 ]] || fail "poster is not 1280x720"

echo "ok: $MP4 ($SIZE bytes, ${DUR}s, h264 High yuv420p + mp3 44.1k mono, faststart)"
echo "ok: $POSTER (1280x720 jpeg, $(stat -f %z "$POSTER" 2>/dev/null || stat -c %s "$POSTER") bytes)"

# A shareable copy for QuickTime, Slack, LinkedIn and the like: same picture, AAC audio.
# QuickTime cannot play MP3-in-MP4 (VS Code cannot play AAC), so this never ships in the VSIX.
if [[ "${1:-}" != "--placeholder" ]]; then
  ffmpeg -v error -y -i "$MP4" -i "${AUDIO_IN:-$B/narration.wav}" -map 0:v -map 1:a -c:v copy \
    -c:a aac -b:a 128k -ac 1 -ar 48000 -movflags +faststart -shortest "$B/$NAME-share.mp4"
  echo "ok: $B/$NAME-share.mp4 (AAC copy for QuickTime and sharing; not shipped)"
  # docs/assets/ keeps each cut's AAC copy (the README links the default cut's; the logical cut's
  # is its copy for Safari and sharing), never the MP3 one: Safari and QuickTime play MP3-in-MP4
  # silently. docs/** is not in the VSIX.
  cp "$B/$NAME-share.mp4" "../docs/assets/$NAME.mp4"
  echo "ok: docs/assets/$NAME.mp4 (AAC; not shipped)"
fi
