//! SIMD kernel: filled in once the `wide` API is confirmed. For now it
//! delegates to the scalar kernel so the crate builds.
use crate::pixel::{run_frame_scalar, FramePlanes, KernelParams, PixelOutputs, PixelState};

pub fn run_frame_simd(st: &mut PixelState, planes: &FramePlanes, p: &KernelParams, out: &mut PixelOutputs) {
    run_frame_scalar(st, planes, p, out)
}
