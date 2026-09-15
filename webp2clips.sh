#!/bin/sh
# Turn a folder of animated webp previews into one mp4 per clip.
#
#   ./webp2clips.sh test1/UCgauBHVjmcc-irYUbp0wYfw clipmp4
#
# Note this is NOT what yt-previews.js builds: that stitches six channels'
# clips together with title cards. A model judging one clip needs one clip.

src="${1:?usage: webp2clips.sh <src-dir> [out-dir]}"
out="${2:-clipmp4}"
mkdir -p "$out"
n=0
for f in "$src"/*.webp; do
  [ -e "$f" ] || continue
  base=$(basename "$f" .webp)
  ffmpeg -y -v error -i "$f" -vf "scale=640:-2,fps=12" \
         -c:v libx264 -pix_fmt yuv420p -crf 20 "$out/$base.mp4" || continue
  n=$((n+1))
done
echo "$n clip(s) -> $out/"
