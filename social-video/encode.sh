#!/usr/bin/env bash
# Encodes the LinkedIn explainer from build/master.mkv + build/narration.wav (+ build/music.wav),
# then asserts the result with ffprobe.
#
#   out/erd-studio-explainer.mp4        H.264 High 1080x1350 30 fps + AAC stereo 48 kHz, faststart
#   out/erd-studio-explainer-thumb.jpg  frame 0 (the hook) — upload as the LinkedIn thumbnail
#   out/erd-studio-explainer-end.jpg    the end card, as an alternative thumbnail
#   out/erd-studio-explainer.srt        captions, if you want LinkedIn's own caption track too
#
# LinkedIn accepts MP4/H.264/AAC up to 5 GB and 10 min; it re-encodes everything, so the upload
# is kept at a high quality (CRF 17) to survive the second pass without banding in the gradients.
set -euo pipefail
cd "$(dirname "$0")"
OUT=out
MP4="$OUT/erd-studio-explainer.mp4"
mkdir -p "$OUT"
[[ -f build/master.mkv && -f build/narration.wav ]] || { echo "run capture.mjs and build-timeline.mjs first" >&2; exit 1; }
EXPECT_DUR=$(node -e "console.log(require('./build/timeline.json').total)")

# Voice (mono, centred) over the stereo underscore at one steady level ~11 dB below it: no
# ducking, so it never pumps between lines. A gentle compressor evens out the track's own
# sections, then the mix is normalised once to LinkedIn/phone loudness.
AUDIO_IN=build/narration.wav
if [[ -f build/music.wav ]]; then
  ffmpeg -v error -y -i build/narration.wav -i build/music.wav -filter_complex \
    "[0:a]aresample=48000,pan=stereo|c0=c0|c1=c0[voice];[1:a]aresample=48000,acompressor=threshold=-24dB:ratio=3:attack=20:release=300:makeup=2,volume=0.36[bed];[voice][bed]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000" \
    -ac 2 build/mix.wav
  AUDIO_IN=build/mix.wav
fi

ffmpeg -v error -y -i build/master.mkv -i "$AUDIO_IN" -map 0:v -map 1:a \
  -c:v libx264 -preset slow -tune animation -crf 17 -profile:v high -level 4.1 -pix_fmt yuv420p -r 30 -g 60 \
  -c:a aac -b:a 192k -ac 2 -ar 48000 -movflags +faststart -shortest "$MP4"

ffmpeg -v error -y -ss 0 -i build/master.mkv -frames:v 1 -vf "format=yuvj420p" -q:v 2 "$OUT/erd-studio-explainer-thumb.jpg"
END_T=$(node -e "const t=require('./build/timeline.json');console.log((t.total-0.2).toFixed(3))")
ffmpeg -v error -y -ss "$END_T" -i build/master.mkv -frames:v 1 -vf "format=yuvj420p" -q:v 2 "$OUT/erd-studio-explainer-end.jpg"
cp build/explainer.srt "$OUT/erd-studio-explainer.srt"

# ---- assertions -------------------------------------------------------------------------
fail() { echo "encode.sh: $*" >&2; exit 1; }
probe() { ffprobe -v error -select_streams "$1" -show_entries "stream=$2" -of default=nw=1:nk=1 "$3"; }
[[ "$(probe v:0 codec_name "$MP4")" == h264 ]] || fail "video codec is not h264"
[[ "$(probe v:0 profile "$MP4")" == High ]] || fail "h264 profile is not High"
[[ "$(probe v:0 pix_fmt "$MP4")" == yuv420p ]] || fail "pix_fmt is not yuv420p"
[[ "$(probe v:0 width "$MP4")x$(probe v:0 height "$MP4")" == 1080x1350 ]] || fail "not 1080x1350"
[[ "$(probe a:0 codec_name "$MP4")" == aac ]] || fail "audio codec is not aac"
[[ "$(probe a:0 channels "$MP4")" == 2 ]] || fail "audio is not stereo"
DUR=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$MP4")
node -e "process.exit(Math.abs($DUR - $EXPECT_DUR) <= 0.25 ? 0 : 1)" || fail "duration $DUR s, expected $EXPECT_DUR s"
node -e "const b=require('fs').readFileSync('$MP4');const m=b.indexOf('moov'),d=b.indexOf('mdat');process.exit(m>0&&m<d?0:1)" || fail "moov atom is not at the front (+faststart)"
LUFS=$(ffmpeg -nostats -i "$MP4" -af ebur128 -f null - 2>&1 | sed -n 's/.*I: *\(-[0-9.]*\) LUFS.*/\1/p' | tail -1)
SIZE=$(stat -f %z "$MP4" 2>/dev/null || stat -c %s "$MP4")
echo "ok: $MP4 ($((SIZE / 1024)) KB, ${DUR}s, 1080x1350 h264 High + aac stereo, ${LUFS} LUFS, faststart)"
echo "ok: $OUT/erd-studio-explainer-thumb.jpg, $OUT/erd-studio-explainer-end.jpg, $OUT/erd-studio-explainer.srt"
