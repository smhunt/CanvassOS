#!/usr/bin/env bash
# Build the 60-second explainer from stills + `say` narration.
#
# Deliberately dumb and deterministic: one narration file per scene, each scene held for exactly
# as long as its own audio, then concatenated. No timing guesswork, no frame-by-frame capture loop.
# Re-run it and you get the same video.
#
#   ./demo/make_video.sh            -> demo/mc-canvass-60s.mp4
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

OUT="demo/mc-canvass-60s.mp4"
B="demo/build"
VOICE="${VOICE:-Daniel}"        # en_GB reads closer to Canadian than Samantha's en_US
W=1920; H=1080
rm -rf "$B"; mkdir -p "$B"

# scene = "image|narration". Every still is from the DEMO stack (fabricated residents) and lives in
# demo/stills/, so this rebuilds from a fresh checkout with no capture step.
STILLS="demo/stills"

# A generated title card rather than a screenshot: the opening line quotes the real figures, and the
# demo database shows 48 doors — a shot of it would contradict the narration. This also keeps every
# committed image demo-derived, so nothing in the repo comes from the voters list.
TITLE="$B/00-title.png"
python3 demo/title_card.py "$TITLE" "$W" "$H"

scenes=(
"$TITLE|MC Canvass is a door-knocking tool for one municipal campaign. It maps the whole voters list — seven thousand doors, sixteen thousand electors."
"$STILLS/01-turfs.jpg|An organiser cuts the map into turfs — by street or by drawing a shape — sees the door count before committing, then hands each one to a volunteer."
"$STILLS/02-door-list.jpg|Doors come in walking order, each carrying whatever happened there last time."
"$STILLS/03-door-open.jpg|One tap records the result and moves to the next house. Speaking to someone opens support, flags and a note."
"$STILLS/04-print-sheet.jpg|Rural signal is bad, so results queue on the phone and sync later. And when a battery dies, the turf prints on paper."
"$STILLS/05-signs-pickup.jpg|Lawn signs are logged with a GPS fix and a photo. They have to come down afterwards, and one nobody can find is a fine."
"$STILLS/06-stats.jpg|The list is personal information under the Municipal Elections Act. So it is self-hosted, every access is logged, and one command destroys it afterwards."
)

echo "voice: $VOICE"
i=0; : > "$B/concat.txt"; : > "$B/audio.txt"
for s in "${scenes[@]}"; do
  img="${s%%|*}"; txt="${s#*|}"
  [ -f "$img" ] || { echo "missing image: $img" >&2; exit 1; }
  n=$(printf '%02d' "$i")

  # narration -> wav, and its exact duration decides how long the still is held
  # OpenAI TTS when a key is present — macOS `say` has no enhanced voices installed here and sounds
  # it. Falls back to `say` so the script still works on a machine without a key.
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    python3 demo/tts.py "$txt" "$B/a$n.raw.wav"
    ffmpeg -y -v error -i "$B/a$n.raw.wav" -af atempo=1.07 -ar 44100 -ac 2 "$B/a$n.wav"
  else
    say -v "$VOICE" -o "$B/a$n.aiff" "$txt"
    ffmpeg -y -v error -i "$B/a$n.aiff" -ar 44100 -ac 2 "$B/a$n.wav"
  fi
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$B/a$n.wav")
  dur=$(python3 -c "print(round(float('$dur') + 0.35, 3))")   # a beat of silence after each line

  # The captures carry a dead margin (the app was rendered at a device width inside a wider window),
  # so trim to the app itself before scaling — otherwise half the frame is empty.
  # The title card is already composed at the output size; cropping it to its text would blow the
  # wordmark up to fill the frame.
  if [ "$img" = "$TITLE" ]; then
    cp "$img" "$B/c$n.png"
  else
    python3 demo/crop_to_content.py "$img" "$B/c$n.png" >/dev/null
  fi
  img="$B/c$n.png"

  # letterbox onto 1920x1080 without distorting, on the app's own dark background
  ffmpeg -y -v error -i "$img" -vf \
    "scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,unsharp=5:5:0.6:5:5:0.0,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0d1622" \
    "$B/f$n.png"
  echo "file 'f$n.png'"  >> "$B/concat.txt"
  echo "duration $dur"   >> "$B/concat.txt"
  echo "file '$(basename "$B/a$n.wav")'" >> "$B/audio.txt"
  printf "  scene %s  %5.2fs  %s\n" "$n" "$dur" "$(basename "$img")"
  i=$((i+1))
done
# The concat demuxer needs the final image repeated, and given a duration of its own — without the
# extra tail the video ends ~2s short of the narration and -shortest clips the last sentence.
last=$(grep '^file ' "$B/concat.txt" | tail -1)
echo "$last" >> "$B/concat.txt"
echo "duration 2.0" >> "$B/concat.txt"
echo "$last" >> "$B/concat.txt"

ffmpeg -y -v error -f concat -safe 0 -i "$B/concat.txt" -pix_fmt yuv420p -r 30 "$B/video.mp4"
# Normalise the whole narration once, not per line, so scene-to-scene level stays even.
ffmpeg -y -v error -f concat -safe 0 -i "$B/audio.txt" -c copy "$B/narration-raw.wav"
ffmpeg -y -v error -i "$B/narration-raw.wav" -af loudnorm=I=-16:TP=-1.5:LRA=11 "$B/narration.wav"
ffmpeg -y -v error -i "$B/video.mp4" -i "$B/narration.wav" \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "$OUT"

echo
echo "$OUT  $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")s  $(du -h "$OUT" | cut -f1)"
