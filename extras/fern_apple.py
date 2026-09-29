"""Bad Apple, but it's a Barnsley fern.

Barnsley's fern is an iterated function system: four affine maps, each of
which shrinks the whole picture into one part of itself, drawn with the
chaos game (start anywhere, apply a randomly chosen map, plot, repeat). The
leaf is made of smaller leaves because that is all the maps can make.

This does the same to every frame of a video. The figure in the frame is
covered with shrunken copies of itself, one affine map per copy: big copies
inside the shape, smaller ones down its edges. Then the chaos game draws the
attractor, so each figure is built out of tiny copies of itself, the way the
fern is built out of ferns. Nothing is drawn per pixel: every dot on screen
is a chaos-game walker.

Each map shrinks the figure's bounding box rather than the whole frame, so
the copies are of the figure, not of a mostly empty frame. And a share of the walkers restart somewhere inside the figure on each step
(Barnsley's "IFS with condensation"), which keeps big shapes solid instead
of letting them crumble into dust.

The walkers carry on from frame to frame rather than starting over, so the
figures flow into each other. Whenever the frame is blank (Bad Apple opens
and closes on black) the maps become Barnsley's own, and the walkers settle
into the fern.

    python extras/fern_apple.py "Bad Apple.mp4" -o fern_apple.mp4
    python extras/fern_apple.py --demo -o fern_demo.mp4

Whichever of black or white covers less of the frame is drawn as the figure,
so a black/white inversion doesn't flip the whole screen from dark to lit.
It can still flash where the source does. Scan the result with Unflash
before you share it.
"""

import argparse
import math
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from unflash.ffio import CREATE_NO_WINDOW, FFMPEG, probe  # noqa: E402

# Barnsley's original four maps: (a, b, c, d, e, f, probability),
# taking (x, y) to (a x + b y + e, c x + d y + f)
FERN_MAPS = np.array([
    (0.00, 0.00, 0.00, 0.16, 0.0, 0.00, 0.01),   # stem
    (0.85, 0.04, -0.04, 0.85, 0.0, 1.60, 0.85),  # the rest of the fern, smaller
    (0.20, -0.26, 0.23, 0.22, 0.0, 1.60, 0.07),  # largest left leaflet
    (-0.15, 0.28, 0.26, 0.24, 0.0, 0.44, 0.07),  # largest right leaflet
])

# the silhouette is traced on this grid; 2**max depth must divide it
MASK_SIZE = 128
BLANK_FRACTION = 0.004  # a figure smaller than this counts as no figure

BACKGROUND = np.array([4, 8, 5])
FROND_DARK = np.array([20, 90, 35])
FROND_LIGHT = np.array([205, 255, 140])


class Maps:
    """An IFS as arrays: point p goes to mat[i] @ p + off[i] with
    probability prob[i]. Coordinates are 0..1 across and down the frame."""

    TABLE = 1 << 16
    condense = None  # (figure cells, probability): see silhouette_maps

    def __init__(self, mat, off, prob):
        self.mat = np.asarray(mat, np.float32)
        self.off = np.asarray(off, np.float32)
        # the silhouette's maps only stretch and shift, which is much cheaper
        # to apply than a full matrix
        m = self.mat
        self.diag = m[:, [0, 1], [0, 1]].copy() if (
            np.all(m[:, 0, 1] == 0) and np.all(m[:, 1, 0] == 0)) else None
        # picking a map is a lookup: each map gets table slots in proportion
        # to its probability (largest remainders, so they add up exactly)
        p = np.asarray(prob, np.float64)
        want = p / p.sum() * self.TABLE
        counts = np.floor(want).astype(np.int64)
        short = self.TABLE - counts.sum()
        counts[np.argsort(counts - want)[:short]] += 1
        self.table = np.repeat(np.arange(len(p), dtype=np.int32), counts)

    def step(self, x, y, rng):
        if self.condense is not None:
            cells, p = self.condense
            hit = np.flatnonzero(rng.random(len(x), np.float32) < p)
            c = cells[rng.integers(0, len(cells), len(hit))]
            x, y = x.copy(), y.copy()
            x[hit] = (c % MASK_SIZE + rng.random(len(hit), np.float32)) / MASK_SIZE
            y[hit] = (c // MASK_SIZE + rng.random(len(hit), np.float32)) / MASK_SIZE
        i = self.table[rng.integers(0, self.TABLE, len(x), dtype=np.int32)]
        ox, oy = self.off[i, 0], self.off[i, 1]
        if self.diag is not None:
            return self.diag[i, 0] * x + ox, self.diag[i, 1] * y + oy
        m = self.mat[i]
        return (m[:, 0, 0] * x + m[:, 0, 1] * y + ox,
                m[:, 1, 0] * x + m[:, 1, 1] * y + oy)


def fern_maps(aspect, sway):
    """Barnsley's maps, conjugated into frame coordinates so the fern stands
    upright in the middle of the frame, 90% of its height. `sway` (radians)
    turns the main map a little, which bends the whole frond."""
    h = 0.09  # frame heights per fern unit; the fern is 10 units tall
    # fern -> frame: u = 0.5 + (x - 0.24) * h / aspect, v = 0.95 - y * h
    T = np.array([[h / aspect, 0.0], [0.0, -h]])
    t = np.array([0.5 - 0.24 * h / aspect, 0.95])
    Ti = np.linalg.inv(T)
    mats, offs = [], []
    for k, (a, b, c, d, e, f, _) in enumerate(FERN_MAPS):
        A = np.array([[a, b], [c, d]])
        if k == 1 and sway:
            cs, sn = math.cos(sway), math.sin(sway)
            A = np.array([[cs, -sn], [sn, cs]]) @ A
        # frame map = T . fern map . T^-1
        M = T @ A @ Ti
        mats.append(M)
        offs.append(t + T @ np.array([e, f]) - M @ t)
    return Maps(mats, offs, FERN_MAPS[:, 6])


def silhouette_maps(region, max_depth, condense=0.0, min_depth=1):
    """Cover `region` (MASK_SIZE x MASK_SIZE bool) with quadtree blocks and
    return the maps that shrink the figure's bounding box into each one, so
    the figure is made of copies of itself. A block is taken once the
    figure fills it; at the finest level, once it half fills it. Blocks
    that aren't well inside the box on both axes are split further, so
    every map shrinks and the chaos game has something to converge to."""
    rows, cols = np.nonzero(region.any(axis=1))[0], np.nonzero(region.any(axis=0))[0]
    if not len(rows):
        return None
    bx0, by0 = cols[0] / MASK_SIZE, rows[0] / MASK_SIZE
    bw, bh = (cols[-1] + 1) / MASK_SIZE - bx0, (rows[-1] + 1) / MASK_SIZE - by0
    covered = np.zeros_like(region)
    xs, ys, ss = [], [], []
    for depth in range(min_depth, max_depth + 1):
        n = 2 ** depth
        if 1.0 / n > 0.6 * min(bw, bh):
            continue
        b = MASK_SIZE // n
        frac = region.reshape(n, b, n, b).mean(axis=(1, 3))
        taken = covered[::b, ::b]
        need = 0.5 if depth == max_depth else 0.97
        accept = (frac >= need) & ~taken
        by, bx = np.nonzero(accept)
        xs.append(bx / n)
        ys.append(by / n)
        ss.append(np.full(len(bx), 1.0 / n))
        covered |= np.kron(accept, np.ones((b, b), bool))
    if not sum(len(v) for v in ss):
        return None
    x, y, s = np.concatenate(xs), np.concatenate(ys), np.concatenate(ss)
    sx, sy = s / bw, s / bh
    mat = np.zeros((len(s), 2, 2))
    mat[:, 0, 0], mat[:, 1, 1] = sx, sy
    off = np.stack([x - sx * bx0, y - sy * by0], axis=1)
    # weight by area, so every copy gets its fair share of walkers
    maps = Maps(mat, off, s * s)
    if condense:
        # Barnsley's "IFS with condensation": some walkers restart anywhere
        # in the figure, before this step's map shrinks them into a copy.
        # Without it the figure is only as solid as the fraction of its
        # box it fills, raised to the power of the depth.
        maps.condense = (np.flatnonzero(region), condense)
    return maps


class FernRenderer:
    def __init__(self, width, height, walkers, depth=6, steps=4, condense=0.25,
                 trail=0.35, glow=2.0, blur=1, seed=1):
        self.w, self.h = width, height
        self.depth, self.steps, self.condense = depth, steps, condense
        self.trail, self.glow, self.blur = trail, glow, blur
        self.rng = np.random.default_rng(seed)
        self.x = self.rng.random(walkers, np.float32)
        self.y = self.rng.random(walkers, np.float32)
        self.figure_dark = True
        self.image = np.zeros(width * height, np.float32)
        self.lut = colour_lut()

    def pick_region(self, gray):
        """The figure is whichever colour is the minority, with some
        hysteresis so a frame hovering around half and half doesn't make
        the figure and the background swap back and forth."""
        dark = gray < 128
        share = dark.mean()
        if share > 0.62:
            self.figure_dark = False
        elif share < 0.38:
            self.figure_dark = True
        return dark if self.figure_dark else ~dark

    def render(self, gray, frame_no, fps):
        region = self.pick_region(gray)
        maps = None
        if region.mean() >= BLANK_FRACTION:
            maps = silhouette_maps(region, self.depth, self.condense)
        if maps is None:
            sway = 0.035 * math.sin(2 * math.pi * frame_no / (fps * 3.0))
            maps = fern_maps(self.w / self.h, sway)

        hist = np.zeros(self.w * self.h, np.float32)
        for k in range(self.steps):
            self.x, self.y = maps.step(self.x, self.y, self.rng)
            if k >= self.steps // 2:  # plot only once they've mostly settled
                ix = np.clip((self.x * self.w).astype(np.int32), 0, self.w - 1)
                iy = np.clip((self.y * self.h).astype(np.int32), 0, self.h - 1)
                hist += np.bincount(iy * self.w + ix, minlength=hist.size)

        # scale so the average lit pixel is 1, whatever the figure's size:
        # a small figure shouldn't glare and a big one shouldn't go dim
        lit = np.count_nonzero(hist)
        if lit:
            hist *= lit / hist.sum()
        if self.blur:
            hist = box_blur(hist.reshape(self.h, self.w), self.blur).ravel()
        self.image = self.image * self.trail + hist * (1 - self.trail)
        tone = 1.0 - np.exp(-self.image * self.glow)
        idx = (tone * 255).astype(np.uint8).reshape(self.h, self.w)
        return self.lut[idx]


def box_blur(img, r):
    """Mean over a (2r+1) square, by running sums along each axis."""
    k = 2 * r + 1
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (r + 1, r)
        c = np.cumsum(np.pad(img, pad), axis=axis, dtype=np.float32)
        n = img.shape[axis]
        img = (np.take(c, range(k, k + n), axis=axis)
               - np.take(c, range(0, n), axis=axis)) / k
    return img


def colour_lut():
    t = np.linspace(0, 1, 256)[:, None]
    ramp = FROND_DARK + (FROND_LIGHT - FROND_DARK) * t ** 1.5
    lut = BACKGROUND + (ramp - BACKGROUND) * np.minimum(t * 3, 1)
    return np.clip(lut, 0, 255).astype(np.uint8)


def demo_frames(fps, aspect, seconds=12.0):
    """A stand-in for Bad Apple: after a moment of black, a black apple rolls
    in, spins and splits in two, then the scene fades to negative. Every
    change is gradual, so the demo itself has no flashing in it."""
    n = int(seconds * fps)
    size = MASK_SIZE
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    u = (xx / size - 0.5) * aspect * 2
    w = (yy / size - 0.5) * 2

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
        if t < 0.15:  # a black opening, like Bad Apple's, shows the fern
            mask = np.ones((size, size), bool)
        elif t < 0.4:  # roll in from the left
            k = (t - 0.15) / 0.25
            ease = 1 - (1 - k) ** 3
            cx, ang = -aspect - r + (aspect + r) * ease, -4 * math.pi * (1 - ease)
            mask = apple(cx, 0.1, r, ang)
        elif t < 0.6:  # bob and spin in place
            k = (t - 0.4) / 0.2
            mask = apple(0.0, 0.1 - 0.1 * math.sin(k * math.pi * 2),
                         r * (1 + 0.15 * math.sin(k * math.pi)), k * 2 * math.pi)
        else:  # split in two, halves drift apart
            k = (t - 0.6) / 0.4
            gap = 0.9 * k * k
            mask = apple(-gap, 0.1 + 0.3 * k * k, r, -0.4 * k, half=-1) | \
                   apple(gap, 0.1 + 0.3 * k * k, r, 0.4 * k, half=1)
        frame = np.where(mask, 0.0, 1.0)
        # slow fade to negative over the last 1.5 s: well under any flash rate
        fade = np.clip((i - (n - 1.5 * fps)) / (1.5 * fps), 0, 1)
        frame = frame * (1 - fade) + (1 - frame) * fade
        yield (frame * 255).astype(np.uint8)


def source_frames(path):
    """Decode the source straight down to the silhouette-tracing grid."""
    cmd = [FFMPEG, "-v", "error", "-i", path, "-an",
           "-vf", f"scale={MASK_SIZE}:{MASK_SIZE}:flags=area,format=gray",
           "-f", "rawvideo", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                            creationflags=CREATE_NO_WINDOW)
    size = MASK_SIZE * MASK_SIZE
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(MASK_SIZE, MASK_SIZE)
    finally:
        proc.stdout.close()
        proc.wait()


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Redraw a video as Barnsley-fern-style iterated function systems.")
    ap.add_argument("input", nargs="?", help="source video (omit with --demo)")
    ap.add_argument("-o", "--output", default="fern_apple.mp4")
    ap.add_argument("--demo", action="store_true",
                    help="render a built-in 12 s apple instead of a source video")
    ap.add_argument("--height", type=int, default=1080,
                    help="output height in pixels; width follows the source (default 1080)")
    ap.add_argument("--walkers", type=float, default=1.5,
                    help="chaos-game walkers, in millions (default 1.5)")
    ap.add_argument("--depth", type=int, default=6, choices=range(2, 8),
                    help="finest copy is 1/2^depth of the frame; lower gives "
                         "fewer, bigger copies and a blockier outline (default 6)")
    ap.add_argument("--steps", type=int, default=4,
                    help="chaos-game steps per frame (default 4)")
    ap.add_argument("--condense", type=float, default=0.25,
                    help="share of walkers restarted inside the figure each step; "
                         "0 gives pure fractal dust, higher gives solider shapes "
                         "(default 0.25)")
    ap.add_argument("--trail", type=float, default=0.35,
                    help="how much of the last frame lingers, 0 to 0.95 (default 0.35)")
    ap.add_argument("--glow", type=float, default=2.0,
                    help="brightness of the dots (default 2.0)")
    ap.add_argument("--blur", type=int, default=1,
                    help="dot radius in pixels, 0 for single pixels (default 1)")
    ap.add_argument("--crf", type=int, default=20)
    args = ap.parse_args(argv)

    if bool(args.input) == args.demo:
        ap.error("give a source video, or --demo, but not both")
    if args.steps < 1:
        ap.error("--steps must be at least 1")

    if args.demo:
        src_w, src_h, fps, has_audio = 16, 9, 30.0, False
    else:
        info = probe(args.input)
        src_w, src_h = info["width"], info["height"]
        fps, has_audio = info["fps"] or 30.0, info["has_audio"]

    out_h = max(2, args.height // 2 * 2)
    out_w = max(2, int(round(out_h * src_w / src_h / 2)) * 2)
    fr = FernRenderer(out_w, out_h, int(args.walkers * 1e6), args.depth,
                      args.steps, min(max(args.condense, 0.0), 0.9),
                      min(max(args.trail, 0.0), 0.95), args.glow, max(args.blur, 0))
    print(f"{out_w}x{out_h} @ {fps:.3f} fps", file=sys.stderr)

    frames = demo_frames(fps, src_w / src_h) if args.demo else \
        source_frames(args.input)

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
            enc.stdin.write(fr.render(gray, n, fps).tobytes())
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
