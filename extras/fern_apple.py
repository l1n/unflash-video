"""Bad Apple, but it's a Barnsley fern.

Redraws a black-and-white video as a halftone meadow of Barnsley ferns: the
picture is cut into cells, and each cell grows a fern whose size follows the
brightness underneath it, so the silhouettes read as dark shapes carved out
of the undergrowth. The ferns sway in a breeze that rolls across the frame.

    python extras/fern_apple.py "Bad Apple.mp4" -o fern_apple.mp4
    python extras/fern_apple.py --demo -o fern_demo.mp4

Any video works, but high-contrast silhouette footage reads best. The audio
of the source is copied across untouched. With --demo no source is needed:
a procedurally drawn apple rolls, spins and splits in two instead.

Bad Apple has fast black/white inversions in places, and this keeps every one
of them. Scan the result with Unflash before you share it.
"""

import argparse
import math
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from unflash.ffio import CREATE_NO_WINDOW, FFMPEG, probe  # noqa: E402

# Barnsley's original four maps: (a, b, c, d, e, f, probability)
FERN_MAPS = np.array([
    (0.00, 0.00, 0.00, 0.16, 0.0, 0.00, 0.01),   # stem
    (0.85, 0.04, -0.04, 0.85, 0.0, 1.60, 0.85),  # ever-smaller leaflets
    (0.20, -0.26, 0.23, 0.22, 0.0, 1.60, 0.07),  # largest left leaflet
    (-0.15, 0.28, 0.26, 0.24, 0.0, 0.44, 0.07),  # largest right leaflet
])
FERN_X = (-2.1820, 2.6558)
FERN_Y = (0.0, 9.9983)

BACKGROUND = np.array([6, 10, 6])
FROND_DARK = np.array([18, 70, 28])
FROND_LIGHT = np.array([190, 255, 120])


def barnsley_points(n, seed=1):
    """n points of the fern attractor, by the chaos game. Vectorised by
    running many independent walkers at once rather than one long walk."""
    rng = np.random.default_rng(seed)
    walkers = 4096
    steps = max(n // walkers, 1) + 20
    xy = np.zeros((walkers, 2))
    out = []
    cum = np.cumsum(FERN_MAPS[:, 6])
    for i in range(steps):
        m = FERN_MAPS[np.searchsorted(cum, rng.random(walkers))]
        x, y = xy[:, 0], xy[:, 1]
        xy = np.stack([m[:, 0] * x + m[:, 1] * y + m[:, 4],
                       m[:, 2] * x + m[:, 3] * y + m[:, 5]], axis=1)
        if i >= 20:  # let each walker settle onto the attractor first
            out.append(xy)
    pts = np.concatenate(out)[:n]
    # normalise: x centred on the stem, y from 0 (root) to 1 (tip)
    pts[:, 0] /= FERN_Y[1]
    pts[:, 1] /= FERN_Y[1]
    return pts


def rasterize(pts, cw, ch, scale, sway, supersample=6):
    """One fern glyph, cw x ch, rooted at the bottom middle of the cell.
    Each pixel is the share of its subpixels the attractor touches, rather
    than a point density: density piles up at the tip, where every map
    converges, and would leave the fronds themselves washed out."""
    x = pts[:, 0] + sway * pts[:, 1] ** 2  # tips bend further than the stem
    y = pts[:, 1]
    # the fern's natural width is about half its height; fill the cell's
    # height and let the width follow
    px = (0.5 + x * scale * ch / cw) * cw * supersample
    py = (1.0 - y * scale) * ch * supersample
    hist, _, _ = np.histogram2d(
        py, px, bins=(ch * supersample, cw * supersample),
        range=((0, ch * supersample), (0, cw * supersample)))
    cover = (hist > 0).reshape(ch, supersample, cw, supersample).mean(axis=(1, 3))
    return (cover * 255).astype(np.uint8)


def build_glyphs(cw, ch, levels, phases, sway):
    """glyphs[phase, mirror, level] -> (ch, cw) uint8. Level 0 is bare
    ground; fern area grows linearly with level, like a halftone dot."""
    # enough points to hit every subpixel the fern covers, several times over
    pts = barnsley_points(min(3_000_000, 1500 * cw * ch))
    glyphs = np.zeros((phases, 2, levels, ch, cw), np.uint8)
    for p in range(phases):
        s = sway * math.sin(2 * math.pi * p / phases)
        for k in range(1, levels):
            glyphs[p, 0, k] = rasterize(pts, cw, ch, math.sqrt(k / (levels - 1)), s)
    # a mirrored fern leaning into the same breeze is the flip of an unmirrored
    # one leaning the opposite way, which is the phase half a cycle round
    for p in range(phases):
        glyphs[p, 1] = glyphs[(phases - p) % phases, 0, :, :, ::-1]
    return glyphs


def colour_lut():
    t = np.linspace(0, 1, 256)[:, None]
    ramp = FROND_DARK + (FROND_LIGHT - FROND_DARK) * t
    lut = BACKGROUND + (ramp - BACKGROUND) * np.minimum(t * 3, 1)
    return np.clip(lut, 0, 255).astype(np.uint8)


class FernRenderer:
    def __init__(self, cols, rows, cell, levels, phases, sway, invert):
        self.cols, self.rows = cols, rows
        self.ch = cell
        self.cw = max(2, int(round(cell * 0.6 / 2)) * 2)
        self.levels, self.phases, self.invert = levels, phases, invert
        self.glyphs = build_glyphs(self.cw, self.ch, levels, phases, sway)
        self.lut = colour_lut()
        rng = np.random.default_rng(7)
        self.mirror = rng.integers(0, 2, (rows, cols))
        gx, gy = np.meshgrid(np.arange(cols), np.arange(rows))
        # a gust front travelling left to right, with a little jitter
        self.wind_offset = gx * 0.35 + gy * 0.08 + rng.random((rows, cols)) * 0.6

    @property
    def size(self):
        return self.cols * self.cw, self.rows * self.ch

    def render(self, gray, frame_no):
        """gray: (rows, cols) uint8, one value per cell -> (H, W, 3) RGB."""
        v = gray.astype(np.float32) / 255.0
        if self.invert:
            v = 1.0 - v
        level = np.clip(np.rint(v * (self.levels - 1)), 0, self.levels - 1).astype(int)
        phase = (np.floor(frame_no * 0.25 + self.wind_offset * 2).astype(int)
                 % self.phases)
        tiles = self.glyphs[phase, self.mirror, level]  # (rows, cols, ch, cw)
        img = tiles.transpose(0, 2, 1, 3).reshape(self.rows * self.ch,
                                                  self.cols * self.cw)
        return self.lut[img]


def demo_frames(cols, rows, fps, seconds=12.0):
    """A stand-in for Bad Apple: a black apple that rolls in, spins, splits
    and lets the scene fade to negative. Every change is gradual, so the
    demo itself has no flashing in it."""
    n = int(seconds * fps)
    aspect = cols / rows * 0.6  # cells are 0.6 as wide as they are tall
    yy, xx = np.mgrid[0:rows, 0:cols].astype(np.float32)
    u = (xx / cols - 0.5) * aspect * 2
    w = (yy / rows - 0.5) * 2

    def apple(cx, cy, r, angle, half=0):
        cu, cv = u - cx, w - cy
        ca, sa = math.cos(angle), math.sin(angle)
        pu, pv = ca * cu + sa * cv, -sa * cu + ca * cv
        # two overlapping lobes and a dimple make the classic apple outline
        body = (np.hypot(pu - 0.3 * r, pv + 0.1 * r) < 0.72 * r) | \
               (np.hypot(pu + 0.3 * r, pv + 0.1 * r) < 0.72 * r)
        body &= ~(np.hypot(pu, pv + 0.95 * r) < 0.2 * r)
        stalk = (np.abs(pu + 0.15 * (pv + 0.7 * r)) < 0.06 * r) & \
                (pv < -0.6 * r) & (pv > -1.15 * r)
        leaf = np.hypot((pu - 0.3 * r) / 2.0, pv + 1.0 * r) < 0.11 * r
        shape = body | stalk | leaf
        if half < 0:
            shape &= pu < 0
        elif half > 0:
            shape &= pu > 0
        return shape

    for i in range(n):
        t = i / n
        r = 0.55
        if t < 0.3:  # roll in from the left
            k = t / 0.3
            ease = 1 - (1 - k) ** 3
            cx, ang = -aspect - r + (aspect + r) * ease, -4 * math.pi * (1 - ease)
            mask = apple(cx, 0.1, r, ang)
        elif t < 0.55:  # bob and spin in place
            k = (t - 0.3) / 0.25
            mask = apple(0.0, 0.1 - 0.1 * math.sin(k * math.pi * 2),
                         r * (1 + 0.15 * math.sin(k * math.pi)), k * 2 * math.pi)
        else:  # split in two, halves drift apart
            k = (t - 0.55) / 0.45
            gap = 0.9 * k * k
            mask = apple(-gap, 0.1 + 0.3 * k * k, r, -0.4 * k, half=-1) | \
                   apple(gap, 0.1 + 0.3 * k * k, r, 0.4 * k, half=1)
        frame = np.where(mask, 0.0, 1.0)
        # slow fade to negative over the last 1.5 s: well under any flash rate
        fade = np.clip((i - (n - 1.5 * fps)) / (1.5 * fps), 0, 1)
        frame = frame * (1 - fade) + (1 - frame) * fade
        yield (frame * 255).astype(np.uint8)


def source_frames(path, cols, rows):
    """Decode the source straight down to one grey value per cell."""
    cmd = [FFMPEG, "-v", "error", "-i", path, "-an",
           "-vf", f"scale={cols}:{rows}:flags=area,format=gray",
           "-f", "rawvideo", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                            creationflags=CREATE_NO_WINDOW)
    size = cols * rows
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(rows, cols)
    finally:
        proc.stdout.close()
        proc.wait()


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Redraw a video as a meadow of Barnsley ferns.")
    ap.add_argument("input", nargs="?", help="source video (omit with --demo)")
    ap.add_argument("-o", "--output", default="fern_apple.mp4")
    ap.add_argument("--demo", action="store_true",
                    help="render a built-in 12 s apple instead of a source video")
    ap.add_argument("--width", type=int, default=1920,
                    help="output width in pixels, rounded down to whole ferns (default 1920)")
    ap.add_argument("--cell", type=int, default=40,
                    help="fern height in pixels; smaller gives a sharper picture, "
                         "bigger gives sharper ferns (default 40)")
    ap.add_argument("--levels", type=int, default=7,
                    help="fern sizes, counting bare ground (default 7)")
    ap.add_argument("--sway", type=float, default=0.12,
                    help="how far the breeze bends the tips; 0 for still air")
    ap.add_argument("--invert", action="store_true",
                    help="grow ferns in the dark areas instead of the light ones")
    ap.add_argument("--crf", type=int, default=20)
    args = ap.parse_args(argv)

    if bool(args.input) == args.demo:
        ap.error("give a source video, or --demo, but not both")
    if args.levels < 2:
        ap.error("--levels must be at least 2")
    cell = max(4, args.cell // 2 * 2)  # even, so the output stays yuv420p-friendly

    if args.demo:
        src_w, src_h, fps, has_audio = 16, 9, 30.0, False
    else:
        info = probe(args.input)
        src_w, src_h = info["width"], info["height"]
        fps, has_audio = info["fps"] or 30.0, info["has_audio"]

    cw = max(2, int(round(cell * 0.6 / 2)) * 2)
    cols = max(1, args.width // cw)
    rows = max(1, int(round(cols * cw * src_h / src_w / cell)))
    fr = FernRenderer(cols, rows, cell, args.levels, 8, args.sway, args.invert)
    out_w, out_h = fr.size
    print(f"{cols}x{rows} ferns -> {out_w}x{out_h} @ {fps:.3f} fps", file=sys.stderr)

    frames = demo_frames(cols, rows, fps) if args.demo else \
        source_frames(args.input, cols, rows)

    cmd = [FFMPEG, "-v", "error", "-y",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{out_w}x{out_h}",
           "-r", f"{fps:.6f}", "-i", "-"]
    if has_audio:
        cmd += ["-i", args.input, "-map", "0:v", "-map", "1:a:0", "-c:a", "copy",
                "-shortest"]
    cmd += ["-c:v", "libx264", "-crf", str(args.crf), "-preset", "medium",
            "-pix_fmt", "yuv420p", args.output]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                           creationflags=CREATE_NO_WINDOW)
    n = 0
    try:
        for n, gray in enumerate(frames, 1):
            enc.stdin.write(fr.render(gray, n).tobytes())
            if n % 100 == 0:
                print(f"\r{n} frames", end="", file=sys.stderr)
    except BrokenPipeError:
        pass
    finally:
        enc.stdin.close()
        rc = enc.wait()
    print(f"\r{n} frames -> {args.output}", file=sys.stderr)
    return rc


if __name__ == "__main__":
    sys.exit(main())
