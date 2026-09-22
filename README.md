# Unflash

Unflash finds the flashing in a video that can trigger photosensitive
seizures, and helps you take it out without wrecking the footage. It removes
individual frames and holds a neighbouring frame in their place, so the
picture stays sharp, the audio stays in sync and the running time doesn't
change. It also finds hazardous **stripe patterns** (fine gratings, the
other photosensitive trigger broadcast guidance names) and can soften just
the frames that carry them.

This is the **WebAssembly + WebGPU** implementation: the detector is written
in Rust, the per-pixel work runs as WebGPU compute shaders (or an 8-lane SIMD
kernel where there is no WebGPU), frames come straight out of WebCodecs, and
everything happens in the browser tab with nothing uploaded anywhere.

There is no render–analyze cycle any more. A scan runs as fast as the GPU can
take frames (hundreds to thousands of frames a second at the default analysis
size), the **live monitor** runs the same detector on whatever the player is
showing and meters the flashing as it happens, and once a section is
prepared **every mark you make is re-checked the instant you make it**.

The original Python/ffmpeg tool this was rebuilt from is still in
[`unflash/`](unflash/README.md); its detector is the reference the Rust
port is tested against, bit for bit where the arithmetic allows.

**This reduces risk. It is not a guarantee.** See
[Limitations](#limitations).

## Using it

**Hosted:** https://l1n.github.io/unflash-video/ — built and published from
`main` by the [Pages workflow](.github/workflows/pages.yml). It is a static
site: the video never leaves your machine.

**Locally:** open `web/` from any static web server over `http://localhost`
or `https://` (WebGPU and WebCodecs need a secure context):

```
./build.sh                     # needs Rust + the wasm32 target + wasm-bindgen (see Building)
npx http-server web -p 8765    # or python3 -m http.server -d web 8765
```

then open http://127.0.0.1:8765/.

Browser support:

| | scan / prepare / export | live monitor | detector |
|---|---|---|---|
| Chrome, Edge, Opera 113+ | WebCodecs (H.264, HEVC*, VP9, AV1) | any file the `<video>` element plays | WebGPU |
| Safari 26+ | WebCodecs | yes | WebGPU |
| Firefox 141+ (Windows), 142+ (macOS), other Firefox | WebCodecs where available | yes | WebGPU where enabled (its WebGPU takes no `VideoFrame` or `<video>` as a copy source, so pictures reach it through a canvas), otherwise the SIMD CPU kernel |
| any of these without an H.264 decoder (Chromium builds without proprietary codecs, some Linux browsers) | the **built-in H.264 decoder** (Constrained Baseline, Main and High, progressive or interlaced) | no: the player cannot play the file | as above |

\* platform dependent. Files are MP4/MOV (ISO base media); the demuxer
handles fragmented files and edit lists. A file whose codec the browser
cannot decode can still be watched with the live monitor; an H.264 file
is decoded by Unflash itself when the browser cannot.

### The short version

1. **Open video**, or drop one anywhere on the page. The file's index is
   read (only its headers; nothing is uploaded), the detector starts on
   WebGPU or, failing that, on the CPU, the project is restored from the
   browser's storage if you have opened this file before, and the scan
   starts: every frame is decoded and pushed through the detector, and a
   numbered *section* goes around each problem.
2. **Open a section.** It prepares itself (its frames, plus a run-up and
   run-out, are decoded into memory at analysis resolution) and is checked.
3. **Edit it.** Mark frames: **R** removes a frame and shows the previous
   one in its place, **F** the next one, **E** holds a frame for a second;
   pressing the same key again takes the mark off, as in the original tool,
   and the keys work with the focus anywhere but a text field. **Ctrl+Z**
   undoes (and **Ctrl+Shift+Z** redoes) any change to the section's marks,
   suggestions included. The section is re-checked after every change, in
   well under a second.
4. **Suggest** gives you a first pass: *keep dark* or *keep light* removes
   the frames that make the flashing; *reduce FPS* thins the section the way
   an editor does it by hand, trying twice the rate that can never fail
   first and stepping down a tenth at a time until the check passes (the ▾
   menu thins to a rate you type). They choose by brightness alone, so
   they can take out a line of burnt-in subtitles or a frame that matters:
   mark such frames **K** (keep) first and every suggestion works around
   them, leaving their own marks (a hold, say) in place.
5. **Watch it.** With a section open, the player plays that section with
   your marks applied, rendered from the source file exactly as the export
   will render it (removed frames showing their stand-in, holds held,
   softened frames blurred); switch it to *original* to compare, or to the
   *whole video*. It plays from the selected frame, loops if asked, runs at
   ½× or ¼×, outlines the frame on screen in the grid, and with **live
   monitor** on shows the check's meter for that frame. It starts small
   and dimmed (S, M, L and *dim* above it), and the line above it says what
   is on screen and whether that passes.
6. A stripe pattern can't be removed a frame at a time; tick **soften
   stripes** and the frames that carry it are blurred just enough to take
   it under the threshold, in the check, the player and the export alike.
7. **Export**: the spans around the sections are re-encoded in the browser
   with the edits applied, several at a time; every GOP no section touches
   is copied from the source as it is, and so is the audio. **Verify**
   re-scans the exported file with the same detector.

**Auto-fix** (tick it in the header; off unless you do) does steps 2 to 7
unattended: it softens stripes, tries keep dark, then keep light, then
reduce FPS on every section, exports, verifies, and offers **Download fixed
video**. A section it can't fix stops the run and is opened for editing.
Treat what it makes as a starting point: it can't tell which frames carry
something that matters, so editing by hand, with the player, gives better
results. Its changes to each section can be undone like any other.

The **Guide** button opens the guide beside your work and closes it again
(so does Esc).

Profiles (**WCAG + extended flashes + stripe patterns**, **Exact WCAG
only**, **Stricter than WCAG**), the suggesters, the safe frame-rate bound
and the run-up/run-out logic are the reference's; see
[DETECTION.md](DETECTION.md) for what counts as a flash or a pattern and
why the check of a section agrees with a scan of the export.

### Test clips

The hosted site publishes short synthetic videos with known problems, so
there is something to try it on: open one with its **open** button on the
start page, or download it and open it from your disk (or feed it to any
other checker).

| clip | contents | VP9 | H.264 |
|---|---|---|---|
| flash | a slow pan, 4 flashes/s over the whole picture at 3.0–5.5 s, a red flash at 7.0–8.5 s | [flash.mp4](https://l1n.github.io/unflash-video/clips/flash.mp4) | [flash_h264.mp4](https://l1n.github.io/unflash-video/clips/flash_h264.mp4) |
| stripes | the pan, fine vertical stripes at 2–6 s, diagonal stripes at 6–9 s, no flashing | [stripes.mp4](https://l1n.github.io/unflash-video/clips/stripes.mp4) | [stripes_h264.mp4](https://l1n.github.io/unflash-video/clips/stripes_h264.mp4) |
| extended | 3 flashes/s for 8 s: passes WCAG, an extended flash under the default profile | [extended.mp4](https://l1n.github.io/unflash-video/clips/extended.mp4) | [extended_h264.mp4](https://l1n.github.io/unflash-video/clips/extended_h264.mp4) |
| redflash | the pan, then saturated red swapped for a grey of the same luminance 5 times a second from 2 s: no luminance flash, one red-flash failure | [redflash.mp4](https://l1n.github.io/unflash-video/clips/redflash.mp4) | [redflash_h264.mp4](https://l1n.github.io/unflash-video/clips/redflash_h264.mp4) |
| steady | the pan alone | [steady.mp4](https://l1n.github.io/unflash-video/clips/steady.mp4) | [steady_h264.mp4](https://l1n.github.io/unflash-video/clips/steady_h264.mp4) |

All are 640×360, 30 fps, with a tone on the audio track, made by
`tests/media/gen_e2e.py` (the same files the browser test runs on). The
Pages build regenerates them; for a local copy run
`python3 tests/media/gen_e2e.py web/clips`.

`?cpu=1` in the URL forces the CPU detector (for comparison);
`web/bench.html` measures both on your machine.

### Diagnostics

The console reports, at **debug level** (enable "Debug" / "Verbose" messages
in the devtools console), how long each operation takes: decoder waits, file
reads, `copyTo`, canvas blits, uploads to the detector, the GPU's
submit-to-result latency, polling, the built-in decoder's time per picture.
A summary is printed every 5 s during a scan and at the end of every scan,
section prepare, export and verify; `window.__unflash.profile.summary()`
gives the same text at any moment. The first line of each report names the
route pictures take to the detector.

Pictures reach the GPU detector by the first route that works in the
browser: the `VideoFrame` itself (Chrome, Safari); its own YUV planes
(`copyTo` of I420 / NV12, converted to RGB on the GPU: what Firefox needs,
since its WebGPU takes no `VideoFrame` or `<video>` as a copy source, and
what the built-in decoder hands over directly); WebCodecs' RGBA conversion;
a canvas blit; or canvas pixels. `?route=videoframe|yuv|rgba|canvas|pixels`
forces one, `?extsrc=canvas` (or `none`) pretends WebGPU accepts only those
copy sources, `?workers=N` sets the number of built-in decoder workers,
`?auto=0` keeps anything from starting when a file is opened (not even the
scan), `?auto=1` ticks auto-fix, and
`?monitor=detect` makes the live monitor run the detector on the player
even when a finished scan of the file could be read instead.

## How it works

```
   WebCodecs VideoFrame ─┐            ┌── GridStats (a few KB / frame) ──┐
   <video> element ──────┼─► GPU ─────┤                                  ├─► temporal stage ─► violations, sections
   cached RGBA frames ───┘   stage    └── per-pixel state stays on the GPU ┘   (Rust, on the CPU)
```

The detector is split in two.

The **pixel stage** owns the per-pixel state machine of the reference
(`_ExtremaTracker`, `_FlashCounter`, `_Pool`): a monotonic-run tracker for
luminance and one for the red value, flash pairing, a ring of the last K flash
times and their opening times, and the pooling timers, about 120 bytes per
pixel. It is written once, as a plain per-pixel function in Rust
(`crates/unflash-core/src/pixel.rs`), and restated twice: as a WGSL compute
shader and as an 8-lane SIMD kernel. All three are held bit-for-bit
identical by tests. Per frame the stage reads and partially writes that
record for every analysis pixel and reduces the frame to one 48-byte cell
per sliding-window position: window sums of luminance and red value, the
count of pixels in each of eight mask classes (strobing at the failure rate,
strobing at the permitted rate, pooled transitions), and the age of the
oldest transition still feeding a failure window. That is the whole
bandwidth story: **one pass over the pixel state per frame**, no
intermediate images, nothing per pixel read back.

The GPU version runs four dispatches per frame — an ingest pass that area-
averages the source (any size, straight from a `VideoFrame`) into the
analysis model and linearises it through the same sRGB table the CPU uses,
the update pass, a row pass and a gather pass — and copies the few-kilobyte
result into one of a ring of staging buffers, so several frames are in
flight while the CPU handles the rest. The reduction passes use no
workgroup barriers: on a real GPU they are latency-bound and take tens of
microseconds; on a software implementation (SwiftShader, lavapipe) they are
merely slow rather than pathological.

The **pattern stage** (`crates/unflash-core/src/pattern.rs`, and a fifth
dispatch on the GPU) looks for stationary hazards the flash detector cannot
see: regular stripes and gratings. It walks the luminance plane along
parallel lines in eight orientations with the same monotonic-run tracker,
and marks a pixel when it lies in a stretch of more than five regularly
spaced light–dark pairs of flash-strength contrast that is coherent across
neighbouring lines. The frame's pattern area is the number of marked
pixels; a quarter of the screen for half a second is a violation of kind
*pattern*, with its own sections. The GPU and CPU versions produce the
identical mask (it is integer and fixed-point throughout), and the mean
stripe spacing they measure sizes the blur that **soften stripes** applies.

### The built-in H.264 decoder

WebCodecs is only as good as the codecs the browser ships, and H.264, the
codec of nearly every camera and phone, is missing from Chromium builds
without proprietary codecs and from some Linux browsers. So
`crates/unflash-h264` is a complete H.264 decoder in plain Rust, used
whenever `VideoDecoder.isConfigSupported` says no to an `avc1`/`avc3`
track: the Constrained Baseline, Baseline (without FMO/ASO), Main and High
profiles for 4:2:0 8-bit video, progressive or interlaced (field pictures
and MBAFF frames), with CAVLC and CABAC, I/P/B slices and every partition
size, multiple and long-term references, memory management control
operations, explicit and implicit weighted prediction, spatial and temporal
direct prediction, the 8x8 transform, scaling matrices, I_PCM and the
deblocking filter. 4:2:2/4:4:4, high bit depths, slice groups, SP/SI
slices and data partitioning are reported as unsupported rather than
decoded wrongly. Besides the x264 streams below it is checked against the
JVT conformance suite (`cargo run --release -p unflash-h264 --example
conformance -- <dir>` over the streams from
https://fate-suite.ffmpeg.org/h264-conformance/ with ffmpeg's per-frame
MD5s): every stream within those limits decodes bit-exact, 169 of them.

It is written to the standard and tested bit-exact against ffmpeg's
decoder on x264 streams that exercise those tools
(`crates/unflash-h264/tests`, media in `tests/media/h264`). Pictures come
back in decode order with the container's timestamps; `web/media.js`
re-orders them for presentation, so the rest of the app (scan, sections,
export, verify) does not know which decoder it is on. Scans and section
prepares take the pictures as I420 planes straight into the detector (no
`VideoFrame` in between); the export, which re-encodes them, gets real
`VideoFrame`s.

The decoding runs in parallel Web Workers (`web/h264pool.js`, one group of
pictures per worker, split at sync samples), with eight-lane SIMD row
kernels (wasm simd128, SSE2 or NEON through `wide`) for the interpolation,
averaging and weighting of blocks at least eight samples wide, and, for
statistics, in a **fast mode** that leaves out the in-loop deblocking
filter: about a quarter of the decoding time. A full reconstruction is still needed (H.264 predicts
every macroblock from its neighbours and from earlier pictures, so there is
no DC-only or low-resolution shortcut as for MPEG-2), but the filter only
touches block edges: measured on a 1080p clip, at the 256×144 analysis
resolution 99.7 % of the cells differ by at most one luma code from the
full decode and the mean difference is 0.07 codes, far below anything the
flash thresholds react to. The export uses the full decode. Natively the
decoder does about 65 fps at 1080p (80 fast); in WebAssembly about 50 fps
single-threaded (60 fast) and 125 fps with four workers, and 400–550 fps
at 640×360: well above real time for the analysis but slower than a
hardware decoder. The player itself still cannot
play such a file, so the live monitor is off for it.

The **temporal stage** (`crates/unflash-core/src/temporal.rs`) is the rest
of the reference `FlashDetector`, unchanged in logic: the window-mean
coherence gate, the concurrent-area test, events, per-frame statistics,
violations, extended flashes. It runs on the CPU in float64 on a few hundred
numbers per frame, whichever pixel stage produced them.

### Time on the GPU

The reference keeps every per-pixel time in float64 because a float32 loses
the millisecond precision the 0.125 s and 1 s windows need after an hour of
video. GPUs have no float64, so the kernels keep time as **unsigned 32-bit
microseconds**: integer subtraction is exact, an age measured at second 4259
is the same number it would be at second 4, and wrap-around is handled by
computing ages with wrapping arithmetic and periodically saturating every
stored time at 2^30 µs (about 18 minutes), which is the reference's "never"
sentinel in a different coat. See [DETECTION.md](DETECTION.md#the-webgpu-implementation).

### Frames in batches, files in segments

At 256×144 the detector's work on a frame is a few tens of microseconds of
GPU time; a scan's speed is set by round trips. The stage therefore runs
**sixteen frames per command buffer**: each picture is converted into its
own slice of the input planes as it arrives, and the passes that depend on
the previous frame's state (the moved-pixel count, the pattern mask, the
update, the row sums and the gather) run for the whole batch in one
submission with one readback, so the submit-to-result latency is paid once
per sixteen frames rather than once per frame. The live monitor asks for a
batch of one, since it wants a result after every frame.

A scan of a long file is also cut into up to four **segments scanned at the
same time**, each with its own decoder and detector. Every segment after
the first starts a run-up early, the same run-up a section check gets, so
that its detector's state at the seam is the state a run from the start of
the file would have reached; the per-frame statistics are then joined with
the run-ups dropped and the internal clock made continuous, and the
violations are derived from the joined statistics exactly as they are for
one run. A test holds the merged result of a split run identical to the
sequential run, frame statistics, events and violations alike. Segments are
used with the browser's own decoder on the GPU detector (the built-in
decoder already spreads over workers); `?segments=N` forces a count, and a
file shorter than four run-ups per segment is scanned in one.

### Spans re-encoded, the rest copied

An export used to decode and re-encode every frame of the file. Almost all
of them are frames no section touches, and those are now **copied from the
source as they are**, whole GOPs at a time, with neither a decoder nor an
encoder in the way: a smart cut. Only the spans around the sections are
decoded, edited and re-encoded, from the last IDR picture before a section
to the first one after it (for H.264 the sync samples are read to make sure
they are IDR pictures, since an open-GOP I picture is marked as a sync
sample too but the B pictures after it lean on what came before). Each span
starts with a keyframe the decoder can pick up cold, so the spans are
independent: the export runs several at once (one per two logical cores,
up to four; `?parallel=N` sets the count), each with its own decoder and
encoder, and long spans are cut at keyframes between sections so the
workers stay busy. The writer takes the pieces in file order.

Copied and re-encoded samples share one track. For VP9 that is nothing
special: the frames carry their own headers. For H.264 the track's `avcC`
record has to hold the parameter sets of both streams, and both number
theirs from zero, so the encoder's are **renumbered**: the ids in its SPS
and PPS, and the `pic_parameter_set_id` in every slice header, which moves
the bits after it. CABAC slice data is aligned to its byte boundary again;
CAVLC data is shifted, and for it the new id is chosen so that the shift is
a whole byte, because I_PCM samples in CAVLC slices are aligned to the NAL
unit's bytes. Tests decode every conformance stream after renumbering and
splice GOPs of one encoding into another with B-frames on both sides, in
this decoder and in ffmpeg's. The audio is copied as before.

When the encoder's codec cannot share a track with the source's (an HEVC
or AV1 source, or an H.264 file exported as VP9 because the browser has no
H.264 encoder), or with `?smartcut=0`, the whole file is re-encoded, still
in parallel pieces cut at keyframes. The export dialog says which it will
be, and how much is copied.

### What it costs

Per frame at the default analysis size (a 16:9 source becomes 256×144, the
model of a 1024×768 screen at scale 0.25; `analysis_scale = 1.0` gives the
full 1024×576):

| stage | per frame | on this machine (4-core VM, software GPU) |
|---|---|---|
| CPU scalar kernel | 27 ns/px | 1.0 ms, ≈1000 fps |
| CPU SIMD kernel (AVX2 natively, simd128 in WASM) | 16 ns/px | 0.6 ms native, 1.0 ms in the browser |
| GPU stage | ≈130 B/px of state traffic | limited by the GPU's memory bandwidth on real hardware |

At full analysis scale the state is 71 MB and the CPU kernel is memory-bound
at ≈5 GB/s; that is where the GPU pays for itself, at a few hundred GB/s
on a discrete card. The whole-video scan is then bounded by the decoder.

`cargo run --release -p unflash-gpu --example bench` prints these numbers
for your hardware; `web/bench.html` does the same in the browser.

## Building

```
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.128   # must match the crate version in Cargo.lock
./build.sh            # -> web/pkg/
```

`wasm-opt` (binaryen) is used if present. The workspace:

| crate | what |
|---|---|
| `crates/unflash-core` | the detector: config and profiles, the per-pixel kernel (scalar and SIMD), grid reduction, temporal stage, violations, sections, editing helpers. No I/O. |
| `crates/unflash-gpu` | the WGSL pipeline on `wgpu` (native backends and the browser's WebGPU) |
| `crates/unflash-mp4` | a byte-range MP4 demuxer for WebCodecs (codec strings, decoder descriptions, sample tables, fragmented files, edit lists) and a muxer for the export |
| `crates/unflash-h264` | the built-in H.264 decoder, for browsers whose WebCodecs has none |
| `crates/unflash-wasm` | the `wasm-bindgen` API |
| `web/` | the app (plain ES modules, no build step beyond the WASM) |
| `unflash/` | the Python reference implementation |

## Deploying

`.github/workflows/pages.yml` builds the WASM on every push to `main` and
publishes `web/` to GitHub Pages; it can also be run by hand from any branch
(Actions → Pages → Run workflow). The first run enables Pages with the
"GitHub Actions" source; if the repository refuses that, enable it once under
Settings → Pages → Build and deployment → Source: GitHub Actions.
`.github/workflows/ci.yml` runs the Rust tests (on lavapipe), builds the
WASM and runs the browser test on every push.

## Testing

```
cargo test --workspace                    # unit tests, the reference cross-check, GPU-vs-CPU (needs any Vulkan/Metal/DX12 adapter; lavapipe is enough)
python3 tests/gen_fixtures.py             # regenerate the reference fixtures from unflash/analysis.py (needs numpy)
bash tests/media/gen.sh                   # demuxer/muxer test files (needs ffmpeg)
bash tests/media/h264/gen.sh              # H.264 decoder test streams and ffmpeg's per-frame MD5s (needs ffmpeg with libx264)
cargo run --release -p unflash-h264 --example compare -- file.mp4   # decode any MP4 and diff every frame against ffmpeg
cargo run --release -p unflash-h264 --example conformance -- dir [filter]   # the JVT conformance streams (Annex B) against ffmpeg's framemd5 (dir/NAME.framemd5)
python3 tests/media/gen_e2e.py            # synthetic flashing / striped videos for the browser test (and the site's test clips)
node tests/e2e/run.mjs                    # the whole app in headless Chromium with WebGPU (needs playwright)
```

`crates/unflash-core/tests/reference_fixtures.rs` regenerates the frames the
Python detector was run on (CRC-checked) and asserts identical per-frame
hazard areas, events, violations and verdicts on all fixtures.
`crates/unflash-gpu/tests/gpu_vs_cpu.rs` compares the entire per-pixel state
of the GPU stage with the CPU kernel after every frame, and the pattern mask
and statistics on striped frames. `crates/unflash-h264/tests/streams.rs`
decodes the x264 test streams and requires ffmpeg's MD5 of every frame.
`crates/unflash-h264/tests/rewrite.rs` renumbers the parameter sets of
every conformance stream and decodes it again, and splices GOPs of one
encoding into another and checks the result in this decoder and in ffmpeg.
`tests/e2e/run.mjs` scans, edits, softens, exports and verifies the
synthetic clips in headless Chromium, including the H.264 clip through the
built-in decoder (the test browser has no H.264); the VP9 exports copy
their untouched GOPs. `tests/e2e/splice.mjs` runs the H.264 smart cut with
a stand-in encoder that hands back a second encoding's samples, and
requires every frame of the exported file to decode as its source did.

To compare the two detectors on a real file rather than on synthetic
frames, run both over it and line up the violations:

```
python3 -m unflash.cli analyze file.mp4 --profile wcag_ext --json   # the Python reference (needs ffmpeg, numpy)
node tests/e2e/scanfile.mjs file.mp4 --profile wcag_ext             # this detector, in headless Chromium (--segments N to force a segment count)
```

Onsets, starts and ends agree to the hundredth of a second on the test
clips; the frames come from different decoders and scalers (ffmpeg's
against the browser's), so a frame's difference at a boundary is possible
on other material. The reference has no pattern test, so stripes are
reported by this detector alone.

### Memory and long files

Nothing scales with the length of the file except what a scan records per
frame (about 24 bytes) and what a prepared section holds. Sections are
cached at analysis resolution (256×144 for a 16:9 picture, whatever the
source), three bytes a pixel, so a second of a 30 fps section costs about
3.3 MB plus a fixed run-up and run-out of 6.5 s each side under the default
profile. Cached sections are kept up to a budget scaled to the device's
memory (a quarter to two-thirds of a gigabyte); older ones are dropped and
prepared again when opened, and an export applies their marks all the same,
from the frame times. WebAssembly memory never shrinks, so that budget is
also the high-water mark a long session settles at.

An export is streamed to disk wherever the browser allows it: to a file of
your choosing (Chrome, Edge, Opera) or to the browser's private storage
(Chrome, Firefox), from which it is offered for download. Only where neither
exists (Safari) is it assembled in memory, and then only up to a size the
device can hold; a larger one is left for you to export by hand. The
detector's clock is 32-bit microseconds with wrapping ages, so a film longer
than the 71 minutes at which it wraps is analysed like any other. With a
scan in hand, the live monitor reads the scan's per-frame numbers at the
player's position rather than detecting again, so it never misses a frame.

## Limitations

- **This reduces risk. It does not guarantee safety.** Passing the detector
  means passing a published set of thresholds, not that the video is safe
  for every person.
- The pattern test covers regular stripes and gratings, the case the
  broadcast guidance quantifies (more than five light–dark pairs, flash-
  strength contrast, a quarter of the screen). It measures contrast and
  area, not how many *cycles per degree* a viewer sees, and it does not
  claim to catch every texture that could affect someone. Softening blurs
  the frames that carry the pattern; the result is verified by the same
  detector, and it is still a blur.
- The built-in H.264 decoder does not do 4:2:2/4:4:4, 10-bit, slice groups
  or SP/SI slices; such files need a browser with its own H.264 decoder.
  HEVC has no built-in decoder at all.
- The export copies the audio; after an **E** hold the audio runs ahead of
  the picture by the length of the hold. Removals (R/F) do not change
  timing and need no audio work.
- The export copies the untouched GOPs only when the encoder's codec is the
  source's (H.264 into H.264, VP9 into VP9); an HEVC or AV1 source, or a
  browser without an H.264 encoder, gets a full re-encode.
- Sections and marks are stored in the browser's IndexedDB per file; frame
  caches live in memory and are rebuilt when a section is prepared again.
- Review the flagged sections yourself before you share anything.
