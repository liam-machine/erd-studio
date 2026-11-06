#!/usr/bin/env bash
# Encodes the LinkedIn explainer from build/master.mkv + build/narration.wav (+ build/music.wav,
# unless the script says `music: false`),
# then asserts the result with ffprobe.
#
#   out/erd-studio-explainer[-<variant>].mp4  H.264 High 1080x1350 30 fps + AAC stereo 48 kHz, faststart
#   out/erd-studio-explainer-thumb.jpg  frame 0 (the hook) — upload as the LinkedIn thumbnail
#   out/erd-studio-explainer-end.jpg    the end card, as an alternative thumbnail
#   out/erd-studio-explainer.srt        captions, if you want LinkedIn's own caption track too
#
# LinkedIn accepts MP4/H.264/AAC up to 5 GB and 10 min; it re-encodes everything, so the upload
# is kept at a high quality (CRF 17) to survive the second pass without banding in the gradients.
set -euo pipefail
cd "$(dirname "$0")"
# VARIANT picks the cut: "pro" (build/ -> erd-studio-explainer.*) or e.g. "simple"
# (build-simple/ -> erd-studio-explainer-simple.*).
VARIANT="${VARIANT:-pro}"
if [[ "$VARIANT" == pro ]]; then B=build; NAME=erd-studio-explainer; else B="build-$VARIANT"; NAME="erd-studio-explainer-$VARIANT"; fi
OUT=out
MP4="$OUT/$NAME.mp4"
mkdir -p "$OUT"
[[ -f $B/master.mkv && -f $B/narration.wav ]] || { echo "run capture.mjs and build-timeline.mjs first" >&2; exit 1; }
export B
EXPECT_DUR=$(node -e "console.log(require('./'+process.env.B+'/timeline.json').total)")

# Voice (mono, centred) over the stereo underscore at one steady level ~11 dB below it: no
# ducking, so it never pumps between lines. A gentle compressor evens out the track's own
# sections, then the mix is normalised once to LinkedIn/phone loudness.
# A cut whose script says `music: false` (timeline.json → music; the README cut) is voice only:
# no bed is mixed even if a stale music.wav is lying in its build folder, and the voice alone is
# centred and normalised to the same loudness.
MUSIC=$(node -e "console.log(require('./'+process.env.B+'/timeline.json').music === false ? 'off' : 'on')")
BED=none
if [[ $MUSIC == on && -f $B/music.wav ]]; then
  BED=mixed
  ffmpeg -v error -y -i $B/narration.wav -i $B/music.wav -filter_complex \
    "[0:a]aresample=48000,pan=stereo|c0=c0|c1=c0[voice];[1:a]aresample=48000,acompressor=threshold=-24dB:ratio=3:attack=20:release=300:makeup=2,volume=0.36[bed];[voice][bed]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000" \
    -ac 2 $B/mix.wav
else
  # Two-pass loudnorm (linear) on the voice alone: measure, then apply one gain, no pumping.
  M=$(ffmpeg -hide_banner -i $B/narration.wav -af "aresample=48000,pan=stereo|c0=c0|c1=c0,loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p')
  lnv() { echo "$M" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)['$1']))"; }
  ffmpeg -v error -y -i $B/narration.wav -af \
    "aresample=48000,pan=stereo|c0=c0|c1=c0,loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=$(lnv input_i):measured_TP=$(lnv input_tp):measured_LRA=$(lnv input_lra):measured_thresh=$(lnv input_thresh):offset=$(lnv target_offset):linear=true,aresample=48000" \
    -ac 2 $B/mix.wav
fi
AUDIO_IN=$B/mix.wav
# CRF and the AAC bitrate can be overridden per cut: the README cut is served by jsDelivr, which
# caps a file at 18 MB, so `npm run all:readme` passes CRF=19 ABR=128k (a voice-only track needs no
# more, and the frames are mostly flat UI).
CRF="${CRF:-17}"
ABR="${ABR:-192k}"

ffmpeg -v error -y -i $B/master.mkv -i "$AUDIO_IN" -map 0:v -map 1:a \
  -c:v libx264 -preset slow -tune animation -crf "$CRF" -profile:v high -level 4.1 -pix_fmt yuv420p -r 30 -g 60 \
  -c:a aac -b:a "$ABR" -ac 2 -ar 48000 -movflags +faststart -shortest "$MP4"

ffmpeg -v error -y -ss 0 -i $B/master.mkv -frames:v 1 -vf "format=yuvj420p" -q:v 2 "$OUT/$NAME-thumb.jpg"
END_T=$(node -e "const t=require('./'+process.env.B+'/timeline.json');console.log((t.total-0.2).toFixed(3))")
ffmpeg -v error -y -ss "$END_T" -i $B/master.mkv -frames:v 1 -vf "format=yuvj420p" -q:v 2 "$OUT/$NAME-end.jpg"
cp $B/explainer.srt "$OUT/$NAME.srt"

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
node -e "process.exit(Math.abs($LUFS - -14) <= 1 ? 0 : 1)" || fail "loudness $LUFS LUFS, expected -14 ±1"
if [[ $MUSIC == off ]]; then
  # Voice only: between lines the track must be (near) silent, which a music bed never is.
  QUIET=$(ffmpeg -nostats -i "$MP4" -af silencedetect=noise=-50dB:d=0.15 -f null - 2>&1 | grep -c 'silence_end' || true)
  [[ $QUIET -ge 5 ]] || fail "voice-only cut has only $QUIET silent gaps: is a music bed mixed in?"
fi
SIZE=$(stat -f %z "$MP4" 2>/dev/null || stat -c %s "$MP4")
echo "ok: $MP4 ($((SIZE / 1024)) KB, ${DUR}s, 1080x1350 h264 High + aac stereo, ${LUFS} LUFS, music $MUSIC (bed $BED), faststart)"
echo "ok: $OUT/$NAME-thumb.jpg, $OUT/$NAME-end.jpg, $OUT/$NAME.srt"
