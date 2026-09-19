#!/usr/bin/env bash
# Generate small MP4 files (and ffprobe packet listings) for the demuxer and
# muxer tests. Needs ffmpeg/ffprobe with libx264, libvpx-vp9 and libaom.
set -euo pipefail
cd "$(dirname "$0")"
V="-f lavfi -i testsrc2=size=64x48:rate=30:duration=2"
A="-f lavfi -i sine=frequency=440:sample_rate=48000:duration=2"
common="-y -v error"

ffmpeg $common $V $A -c:v libx264 -pix_fmt yuv420p -profile:v baseline -bf 0 -g 15 -c:a aac -b:a 32k -shortest h264_baseline.mp4
ffmpeg $common $V $A -c:v libx264 -pix_fmt yuv420p -profile:v high -bf 2 -g 15 -c:a aac -b:a 32k -shortest h264_bframes.mp4
ffmpeg $common $V $A -c:v libx264 -pix_fmt yuv420p -profile:v main -bf 1 -g 12 -c:a aac -b:a 32k -shortest -movflags +faststart h264_faststart.mp4
ffmpeg $common $V $A -c:v libx264 -pix_fmt yuv420p -profile:v high -bf 2 -g 15 -c:a aac -b:a 32k -shortest -movflags frag_keyframe+empty_moov+default_base_moof h264_frag.mp4
ffmpeg $common -f lavfi -i testsrc2=size=64x48:rate=24000/1001:duration=2 -c:v libx264 -pix_fmt yuv420p -bf 2 -g 10 -an h264_ntsc.mp4
ffmpeg $common $V -c:v libvpx-vp9 -b:v 100k -pix_fmt yuv420p -an vp9.mp4
ffmpeg $common -f lavfi -i testsrc2=size=64x48:rate=30:duration=1 -c:v libaom-av1 -cpu-used 8 -b:v 100k -pix_fmt yuv420p -an av1.mp4 || echo "av1 skipped"
# a long-ish h264 file for keyframe / seek tests (10 s)
ffmpeg $common -f lavfi -i testsrc2=size=64x48:rate=30:duration=10 $A -c:v libx264 -pix_fmt yuv420p -profile:v high -bf 2 -g 30 -c:a aac -b:a 32k -shortest h264_10s.mp4

for f in *.mp4; do
  base="${f%.mp4}"
  ffprobe -v error -select_streams v:0 -show_entries "packet=pts_time,dts_time,flags,size,pos" -of json "$f" > "$base.video.json"
  if ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$f" | grep -q .; then
    ffprobe -v error -select_streams a:0 -show_entries "packet=pts_time,dts_time,flags,size,pos" -of json "$f" > "$base.audio.json"
  fi
  ffprobe -v error -show_entries "stream=index,codec_type,codec_name,codec_tag_string,width,height,sample_rate,channels,nb_frames,time_base,start_time,duration:format=duration" -of json "$f" > "$base.streams.json"
done
ls -la
