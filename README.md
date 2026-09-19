# Unflash

Unflash finds the flashing in a video that can trigger photosensitive
seizures, and helps you take it out without wrecking the footage. It removes
individual frames and holds a neighbouring frame in their place, so the
picture stays sharp, the audio stays in sync and the running time doesn't
change.

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
| Firefox 141+ (Windows), other Firefox | WebCodecs where available | yes | WebGPU where enabled, otherwise the SIMD CPU kernel |

\* platform dependent. Files are MP4/MOV (ISO base media); the demuxer
handles fragmented files and edit lists. A file whose codec the browser
cannot decode can still be watched with the live monitor.

### The short version

1. **Open video.** The file's index is read (only its headers; nothing is
   uploaded), the detector starts on WebGPU or, failing that, on the CPU, and
   the project is restored from the browser's storage if you have opened this
   file before.
2. **Scan for flashes.** Every frame is decoded with WebCodecs and pushed
   through the detector. A numbered *section* is put around each problem and
   the timeline shows where the flashing is. Or tick **live monitor** and
   press play: the meter above the video shows how much of the picture is
   flashing right now, and the verdict flips the moment a violation lands.
3. **Prepare** a section. Its frames, plus a run-up and run-out, are decoded
   into memory at analysis resolution.
4. **Edit.** Mark frames (**R** remove and show the previous frame, **F**
   remove and show the next, **E** hold for a second muted, **U** unmark), or
   let **Suggest** do it. The section is re-checked automatically after every
   change, in well under a second.
5. **Export**: the video is re-encoded in the browser with the edits applied
   and the audio copied through untouched. **Verify** re-scans the exported
   file with the same detector.

Profiles (**Exact WCAG + flag extended flashes**, **Exact WCAG only**,
**Stricter than WCAG**), the suggesters, the safe frame-rate bound and the
run-up/run-out logic are the reference's; see [DETECTION.md](DETECTION.md)
for what counts as a flash and why the check of a section agrees with a scan
of the export.

`?cpu=1` in the URL forces the CPU detector (for comparison);
`web/bench.html` measures both on your machine.

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
python3 tests/media/gen_e2e.py            # synthetic flashing videos for the browser test
node tests/e2e/run.mjs                    # the whole app in headless Chromium with WebGPU (needs playwright)
```

`crates/unflash-core/tests/reference_fixtures.rs` regenerates the frames the
Python detector was run on (CRC-checked) and asserts identical per-frame
hazard areas, events, violations and verdicts on all fixtures.
`crates/unflash-gpu/tests/gpu_vs_cpu.rs` compares the entire per-pixel state
of the GPU stage with the CPU kernel after every frame.

## Limitations

- **This reduces risk. It does not guarantee safety.** Passing the detector
  means passing a published set of thresholds, not that the video is safe
  for every person.
- Static patterns like fine stripes and gratings can also trigger
  photosensitive responses, and Unflash does **not** detect those.
- The export re-encodes the whole video (no smart-cut) and copies the audio;
  after an **E** hold the audio runs ahead of the picture by the length of
  the hold. Removals (R/F) do not change timing and need no audio work.
- Sections and marks are stored in the browser's IndexedDB per file; frame
  caches live in memory and are rebuilt when a section is prepared again.
- Review the flagged sections yourself before you share anything.
