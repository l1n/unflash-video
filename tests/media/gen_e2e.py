#!/usr/bin/env python3
"""Synthetic videos for the browser tests and the site's test clips: known
problems at known times.

    python3 tests/media/gen_e2e.py [outdir]

flash.mp4    640x360 30 fps 10 s VP9: a slow pan over a textured scene, then
             4 Hz general flashing from 3.0 to 5.5 s over the whole picture,
             a red flash from 7.0 to 8.5 s, quiet elsewhere. With audio.
steady.mp4   the same scene with no flashing.
extended.mp4 3 Hz flashing for 8 s (an extended flash, not a WCAG failure).
stripes.mp4  the scene, then fine vertical stripes (16 px period, 40 pairs)
             from 2 to 6 s and diagonal stripes from 6 to 9 s: no flashing,
             a hazardous regular pattern.
redflash.mp4 the pan, then saturated red swapped for a grey of the same
             luminance 5 times a second from 2 s: a red flash with no
             luminance flash.
*_h264.mp4   the same clips as H.264 (what most browsers decode; also the
             unsupported-codec path in a Chromium without H.264).
flash_h264i.mp4  the flash clip as interlaced H.264 (MBAFF), for the
             built-in decoder's field / frame macroblock pairs.
flash.mkv    flash_h264.mp4 remuxed into Matroska (H.264 + AAC, copied).
flash.webm   flash.mp4 as WebM (VP9, the audio as Opus).
flash_vorbis.webm  the same with Vorbis audio, which an MP4 cannot carry
             (the export re-encodes it).
flash_hevc.mp4  the flash clip as HEVC (open GOPs, B-frames): the built-in
             HEVC decoder, in a browser without one.
flash_vp8.webm  the flash clip as VP8 in WebM.
flash_av1.mp4   the flash clip as AV1.
"""
import os
import subprocess
import sys

import numpy as np

W, H, FPS = 640, 360, 30
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e")


def scene(i):
    """A textured grey scene panning slowly: motion that must not be flagged."""
    yy, xx = np.mgrid[0:H, 0:W]
    shift = (i * 2) % W
    tex = ((xx + shift) // 40 + yy // 40) % 2
    f = np.where(tex == 1, 110, 80).astype(np.uint8)
    return np.repeat(f[..., None], 3, axis=2)


def encode(name, frames, codec, secs, bitrate="1200k"):
    path = os.path.join(OUT, name)
    if codec == "vp9":
        # a keyframe every second, so an export can copy the untouched GOPs
        vcodec = ["-c:v", "libvpx-vp9", "-b:v", bitrate, "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p", "-g", "30"]
    elif codec == "h264i":
        # interlaced (x264 codes MBAFF frames): the built-in decoder's field / frame macroblock pairs
        vcodec = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-g", "30", "-flags", "+ildct+ilme", "-x264-params", "interlaced=1"]
    elif codec == "hevc":
        # x265's defaults: open GOPs (CRA pictures with leading pictures) and B-frames
        vcodec = ["-c:v", "libx265", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", "-g", "30", "-tag:v", "hvc1", "-x265-params", "log-level=error"]
    elif codec == "vp8":
        vcodec = ["-c:v", "libvpx", "-b:v", bitrate, "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p", "-g", "30"]
    elif codec == "av1":
        vcodec = av1_encoder()
    else:
        vcodec = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-g", "30"]
    # WebM holds Opus rather than AAC
    audio = ["-c:a", "libopus", "-b:a", "64k"] if name.endswith(".webm") else ["-c:a", "aac", "-b:a", "64k"]
    cmd = ["ffmpeg", "-y", "-v", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={secs}",
           *vcodec, *audio, "-shortest", *([] if name.endswith(".webm") else ["-movflags", "+faststart"]), path]
    # SVT-AV1 prints its settings unless told to keep to errors
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, env={**os.environ, "SVT_LOG": "1"})
    for fr in frames:
        p.stdin.write(np.ascontiguousarray(fr).tobytes())
    p.stdin.close()
    p.wait()
    if p.returncode != 0:
        raise SystemExit(f"ffmpeg failed for {name}")
    print("wrote", path, os.path.getsize(path), "bytes")


def av1_encoder():
    """SVT-AV1 where this ffmpeg has it (fast), else libaom."""
    have = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
    if "libsvtav1" in have:
        return ["-c:v", "libsvtav1", "-preset", "10", "-crf", "35", "-pix_fmt", "yuv420p", "-g", "30"]
    return ["-c:v", "libaom-av1", "-cpu-used", "8", "-row-mt", "1", "-crf", "35", "-b:v", "0", "-pix_fmt", "yuv420p", "-g", "30"]


def flash_frames(secs=10.0, red=True):
    n = int(secs * FPS)
    for i in range(n):
        t = i / FPS
        f = scene(i)
        if 3.0 <= t < 5.5:
            phase = int(t * 8) % 2
            f[...] = 30 if phase == 0 else 200
        elif red and 7.0 <= t < 8.5:
            phase = int(t * 8) % 2
            if phase == 0:
                f[..., 0] = 255
                f[..., 1] = 0
                f[..., 2] = 0
            else:
                f[...] = 144
        yield f


def redflash_frames(secs=8.0):
    """The pan, then from 2 s a saturated red swapped for a grey of the same
    relative luminance 5 times a second: no luminance flash, a red flash."""
    n = int(secs * FPS)
    for i in range(n):
        t = i / FPS
        f = scene(i)
        if t >= 2.0:
            if int(t * 10) % 2 == 0:
                f[..., 0] = 250
                f[..., 1] = 0
                f[..., 2] = 0
            else:
                f[..., 0] = 122
                f[..., 1] = 124
                f[..., 2] = 122
        yield f


def steady_frames(secs=6.0):
    for i in range(int(secs * FPS)):
        yield scene(i)


def extended_frames(secs=10.0):
    n = int(secs * FPS)
    for i in range(n):
        t = i / FPS
        f = scene(i)
        if 1.0 <= t < 9.0:
            phase = int(t * 6) % 2
            f[...] = 30 if phase == 0 else 200
        yield f


def stripes_frames(secs=10.0):
    """Stationary high-contrast gratings: 8 px light / 8 px dark bars, so
    well over five pairs cover the whole picture and the bars survive the
    detector's downscale."""
    yy, xx = np.mgrid[0:H, 0:W]
    vertical = ((xx // 8) % 2 == 0)
    diagonal = (((xx + yy) // 10) % 2 == 0)
    n = int(secs * FPS)
    for i in range(n):
        t = i / FPS
        f = scene(i)
        if 2.0 <= t < 6.0:
            f[...] = np.where(vertical, 20, 200)[..., None]
        elif 6.0 <= t < 9.0:
            f[...] = np.where(diagonal, 20, 200)[..., None]
        yield f


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    encode("flash.mp4", flash_frames(), "vp9", 10)
    encode("steady.mp4", steady_frames(), "vp9", 6)
    encode("extended.mp4", extended_frames(), "vp9", 10)
    encode("stripes.mp4", stripes_frames(), "vp9", 10, bitrate="2500k")
    encode("redflash.mp4", redflash_frames(), "vp9", 8)
    encode("flash_h264.mp4", flash_frames(), "h264", 10)
    encode("steady_h264.mp4", steady_frames(), "h264", 6)
    encode("extended_h264.mp4", extended_frames(), "h264", 10)
    encode("stripes_h264.mp4", stripes_frames(), "h264", 10)
    encode("redflash_h264.mp4", redflash_frames(), "h264", 8)
    encode("flash_h264i.mp4", flash_frames(), "h264i", 10)
    encode("flash_hevc.mp4", flash_frames(), "hevc", 10)
    encode("flash_vp8.webm", flash_frames(), "vp8", 10)
    encode("flash_av1.mp4", flash_frames(), "av1", 10)
    # the same pictures in Matroska / WebM
    for src, dst, audio in [("flash_h264.mp4", "flash.mkv", ["-c:a", "copy"]), ("flash.mp4", "flash.webm", ["-c:a", "libopus", "-b:a", "64k"]), ("flash.mp4", "flash_vorbis.webm", ["-c:a", "libvorbis", "-q:a", "3"])]:
        path = os.path.join(OUT, dst)
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", os.path.join(OUT, src), "-c:v", "copy", *audio, path], check=True)
        print("wrote", path, os.path.getsize(path), "bytes")
