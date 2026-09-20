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
*_h264.mp4   the same clips as H.264 (what most browsers decode; also the
             unsupported-codec path in a Chromium without H.264).
flash_h264i.mp4  the flash clip as interlaced H.264 (MBAFF), for the
             built-in decoder's field / frame macroblock pairs.
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
        vcodec = ["-c:v", "libvpx-vp9", "-b:v", bitrate, "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p"]
    elif codec == "h264i":
        # interlaced (x264 codes MBAFF frames): the built-in decoder's field / frame macroblock pairs
        vcodec = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-g", "30", "-flags", "+ildct+ilme", "-x264-params", "interlaced=1"]
    else:
        vcodec = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-g", "30"]
    cmd = ["ffmpeg", "-y", "-v", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={secs}",
           *vcodec, "-c:a", "aac", "-b:a", "64k", "-shortest", "-movflags", "+faststart", path]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for fr in frames:
        p.stdin.write(np.ascontiguousarray(fr).tobytes())
    p.stdin.close()
    p.wait()
    if p.returncode != 0:
        raise SystemExit(f"ffmpeg failed for {name}")
    print("wrote", path, os.path.getsize(path), "bytes")


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
    encode("flash_h264.mp4", flash_frames(), "h264", 10)
    encode("steady_h264.mp4", steady_frames(), "h264", 6)
    encode("extended_h264.mp4", extended_frames(), "h264", 10)
    encode("stripes_h264.mp4", stripes_frames(), "h264", 10)
    encode("flash_h264i.mp4", flash_frames(), "h264i", 10)
