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

# scene = "image|narration". Images are demo-stack (fabricated residents) except the wide map,
# which is real data showing only clusters and counts — no name or address is legible on it.
SC="/private/tmp/claude-501/-Users-seanhunt-Code-mc-canvass/a23073dd-a3c0-41e5-9a67-4a15013373c1/scratchpad/tablet-shots"
CH="/var/folders/53/nm8g_by100qblvwj6lh7v47r0000gn/T/claude-chrome-screenshots-ulPXn2"

scenes=(
"$CH/screenshot-1788657457706-1.jpg|MC Canvass is a door knocking tool built for one municipal campaign. It imports the voters list for Middlesex Centre: seven thousand one hundred and forty households, sixteen thousand electors, mapped."
"$SC/11-tablet-turf-list-two-up.jpg|An organiser cuts the municipality into turfs, by picking streets or drawing a shape on the map, and sees the door count before committing. Then hands a turf to a volunteer."
"$SC/05-phone-390x844-bottom-sheet-unchanged.jpg|At the door, it is a phone. Doors come in walking order. One tap records what happened, and it moves you to the next one."
"$SC/02-tablet-834x1194-ipad-pro-11-portrait.jpg|On an iPad the list and the door sit side by side, so you can see where you are in the turf while you record."
"$SC/04-tablet-1194x834-ipad-landscape.jpg|Every door carries what happened last time, so coverage is obvious at a glance and nobody knocks the same house twice."
"$CH/screenshot-1788667365622-3.jpg|Rural signal is bad, so results queue on the phone and sync themselves later. And when a battery dies, the turf prints on paper."
"$SC/10-tablet-auto-advance-after-result.jpg|The voters list is personal information under the Municipal Elections Act. So it is self hosted, every access is logged, and one command destroys it after the election."
)

echo "voice: $VOICE"
i=0; : > "$B/concat.txt"; : > "$B/audio.txt"
for s in "${scenes[@]}"; do
  img="${s%%|*}"; txt="${s#*|}"
  [ -f "$img" ] || { echo "missing image: $img" >&2; exit 1; }
  n=$(printf '%02d' "$i")

  # narration -> wav, and its exact duration decides how long the still is held
  say -v "$VOICE" -o "$B/a$n.aiff" "$txt"
  ffmpeg -y -v error -i "$B/a$n.aiff" -ar 44100 -ac 2 "$B/a$n.wav"
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$B/a$n.wav")
  dur=$(python3 -c "print(round(float('$dur') + 0.45, 3))")   # a beat of silence after each line

  # The captures carry a dead margin (the app was rendered at a device width inside a wider window),
  # so trim to the app itself before scaling — otherwise half the frame is empty.
  python3 demo/crop_to_content.py "$img" "$B/c$n.png" >/dev/null
  img="$B/c$n.png"

  # letterbox onto 1920x1080 without distorting, on the app's own dark background
  ffmpeg -y -v error -i "$img" -vf \
    "scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0d1622" \
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
ffmpeg -y -v error -f concat -safe 0 -i "$B/audio.txt" -c copy "$B/narration.wav"
ffmpeg -y -v error -i "$B/video.mp4" -i "$B/narration.wav" \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "$OUT"

echo
echo "$OUT  $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")s  $(du -h "$OUT" | cut -f1)"
