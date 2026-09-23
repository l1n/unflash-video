//! Decoded frames: sample planes of 8-bit (`u8`) or 10/12-bit (`u16`)
//! samples, and the pixel type the prediction and filter code is generic
//! over.

/// A sample type: `u8` for 8-bit streams, `u16` for 10 and 12-bit ones.
pub trait Pixel: Copy + Default + PartialEq + Send + Sync + 'static {
    fn get(self) -> i32;
    /// A value known to be in range.
    fn new(v: i32) -> Self;
    /// Clip1: clamp to 0..(1 << bd) - 1.
    fn clip(v: i32, bd: u32) -> Self;
}

impl Pixel for u8 {
    #[inline(always)]
    fn get(self) -> i32 {
        self as i32
    }
    #[inline(always)]
    fn new(v: i32) -> Self {
        v as u8
    }
    #[inline(always)]
    fn clip(v: i32, _bd: u32) -> Self {
        v.clamp(0, 255) as u8
    }
}

impl Pixel for u16 {
    #[inline(always)]
    fn get(self) -> i32 {
        self as i32
    }
    #[inline(always)]
    fn new(v: i32) -> Self {
        v as u16
    }
    #[inline(always)]
    fn clip(v: i32, bd: u32) -> Self {
        v.clamp(0, (1 << bd) - 1) as u16
    }
}

/// One plane. The buffer covers whole 64x64 superblocks (blocks at the
/// right and bottom edges are decoded in full); `width` and `height` are
/// the plane's visible size, which is also where references stop:
/// prediction reads past them as the nearest visible sample.
#[derive(Clone)]
pub struct Plane<T> {
    pub data: Vec<T>,
    pub stride: usize,
    pub width: usize,
    pub height: usize,
}

/// A decoded frame, 4:2:0.
#[derive(Clone)]
pub struct FrameBuf<T> {
    pub planes: [Plane<T>; 3],
    /// FrameWidth and FrameHeight.
    pub width: u32,
    pub height: u32,
    pub bit_depth: u8,
    pub color_space: u8,
    pub color_range: bool,
    /// Some of it could not be decoded, or it was predicted from a damaged
    /// frame.
    pub damaged: bool,
}

impl<T: Pixel> FrameBuf<T> {
    pub fn new(width: u32, height: u32, bit_depth: u8) -> Self {
        let (w, h) = (width as usize, height as usize);
        let aw = (w + 63) & !63;
        let ah = (h + 63) & !63;
        let luma = Plane { data: vec![T::default(); aw * ah], stride: aw, width: w, height: h };
        let chroma = || Plane { data: vec![T::default(); (aw / 2) * (ah / 2)], stride: aw / 2, width: w.div_ceil(2), height: h.div_ceil(2) };
        FrameBuf { planes: [luma, chroma(), chroma()], width, height, bit_depth, color_space: 0, color_range: false, damaged: false }
    }

    /// Whether this buffer can hold a frame of this size and depth.
    pub fn fits(&self, width: u32, height: u32, bit_depth: u8) -> bool {
        self.width == width && self.height == height && self.bit_depth == bit_depth
    }
}
