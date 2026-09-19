//! A small ISO base media file format (MP4) reader and writer, built for
//! WebCodecs: the reader produces per-track codec strings, decoder
//! descriptions and sample tables (offset, size, dts, pts, sync) from the
//! `moov` box (and `moof` boxes of fragmented files), driven by byte ranges
//! so a browser can serve them from a `Blob` without loading the file; the
//! writer takes encoded chunks back and produces a playable file.
//!
//! Nothing here decodes media.

pub mod codec;
pub mod demux;
pub mod mux;
mod reader;

pub use demux::{Demuxer, Movie, Sample, Track, TrackKind};
pub use mux::{Muxer, TrackDesc};

/// Errors are plain strings: every failure is a malformed or unsupported
/// file, and the message is what the user sees.
pub type Error = String;
