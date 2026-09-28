#!/usr/bin/env bash
# Encodes the shipped video and poster from build/master.mkv + build/narration.wav, then
# asserts the result with ffprobe. Audio is MP3-in-MP4: the one audio codec VS Code documents
# for webview video (AAC plays silently; Opus-in-MP4 is undocumented, and a user reported no
# sound while it was the shipped codec) — see README.md.
#
#   bash encode.sh                 build media/onboarding/getting-started.mp4 + poster
#   bash encode.sh --placeholder   2 s test pattern + tone through the same encoder and checks
#                                  (lets the Welcome panel be wired up before the real render)
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
OUT="$ROOT/media/onboarding"
MP4="$OUT/getting-started.mp4"
POSTER="$OUT/getting-started-poster.jpg"
MAX_BYTES=$((8 * 1024 * 1024))
mkdir -p "$OUT" build

VIDEO_OPTS=(-c:v libx264 -preset slow -tune animation -profile:v high -level 4.1 -pix_fmt yuv420p -r 30 -g 150)
AUDIO_OPTS=(-c:a libmp3lame -b:a 64k -ac 1 -ar 44100)

if [[ "${1:-}" == "--placeholder" ]]; then
  ffmpeg -v error -y -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=2" -f lavfi -i "sine=frequency=440:duration=2:sample_rate=44100" \
    "${VIDEO_OPTS[@]}" -crf 30 "${AUDIO_OPTS[@]}" -movflags +faststart -shortest "$MP4"
  ffmpeg -v error -y -f lavfi -i "testsrc2=size=1280x720:rate=1" -frames:v 1 -q:v 3 "$POSTER"
  EXPECT_DUR=2
else
  [[ -f build/master.mkv && -f build/narration.wav ]] || { echo "run capture.mjs and build-timeline.mjs first" >&2; exit 1; }
  EXPECT_DUR=$(node -e "console.log(require('./build/timeline.json').total)")
  # Background music (music.py) plays at one steady level under the voice, about 10 dB below
  # it: no ducking, so it never pumps between lines. A gentle compressor evens out the track's
  # own loud and quiet sections, then the mix is normalised once.
  AUDIO_IN=build/narration.wav
  if [[ -f build/music.wav ]]; then
    ffmpeg -v error -y -i build/narration.wav -i build/music.wav -filter_complex \
      "[0:a]aresample=48000[voice];[1:a]aresample=48000,acompressor=threshold=-24dB:ratio=3:attack=20:release=300:makeup=2,volume=0.33[bed];[voice][bed]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000" \
      -ac 1 build/mix.wav
    AUDIO_IN=build/mix.wav
  fi
  for CRF in 20 22 24 26; do
    ffmpeg -v error -y -i build/master.mkv -i "$AUDIO_IN" -map 0:v -map 1:a \
      "${VIDEO_OPTS[@]}" -crf "$CRF" "${AUDIO_OPTS[@]}" -movflags +faststart -shortest "$MP4"
    SIZE=$(stat -f %z "$MP4" 2>/dev/null || stat -c %s "$MP4")
    echo "crf $CRF -> $SIZE bytes"
    (( SIZE <= MAX_BYTES )) && break
  done
  # Poster: the end card once everything on it has landed.
  POSTER_T=$(node -e "const t=require('./build/timeline.json');console.log((t.scenes.at(-1).start+1.5).toFixed(3))")
  ffmpeg -v error -y -ss "$POSTER_T" -i build/master.mkv -frames:v 1 -vf "scale=1280:720:flags=lanczos,format=yuvj420p" -q:v 3 "$POSTER"
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
(( SIZE <= MAX_BYTES )) || fail "mp4 is $SIZE bytes, over the 8 MB ceiling even at crf 26"
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
  ffmpeg -v error -y -i "$MP4" -i "${AUDIO_IN:-build/narration.wav}" -map 0:v -map 1:a -c:v copy \
    -c:a aac -b:a 128k -ac 1 -ar 48000 -movflags +faststart -shortest build/getting-started-share.mp4
  echo "ok: build/getting-started-share.mp4 (AAC copy for QuickTime and sharing; not shipped)"
fi
