//! Reading the raw byte sequence payload of a NAL unit, as H.264 and HEVC
//! both code their headers: fixed-length fields and Exp-Golomb codes, most
//! significant bit first (H.264 7.2 and 9.1, H.265 7.2 and 9.2), and taking
//! the emulation prevention bytes out of a NAL unit first.
//!
//! One reader for both decoders: each used to have its own, alike but for
//! where they had drifted apart (one skipped without looking, the other
//! read Exp-Golomb codes a bit at a time). A decoder names the reader with
//! its own error type (`type BitReader<'a> = bits::BitReader<'a, Error>`),
//! which says what a read past the end and an impossible value are to it
//! ([`BitsError`]), so `?` gives its own errors with nothing to convert.

use std::marker::PhantomData;

/// What reading bits can fail with, as the decoder's own error.
pub trait BitsError {
    /// A read past the end of the data.
    fn overrun() -> Self;
    /// A code that cannot be, or a value out of its range: `what` says which.
    fn invalid(what: &'static str) -> Self;
}

/// Remove the `emulation_prevention_three_byte`s of a NAL unit payload:
/// the 3 of every 00 00 03.
pub fn unescape(nal: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    unescape_into(nal, &mut out);
    out
}

/// [`unescape`] into a buffer the caller keeps (it is cleared first).
pub fn unescape_into(nal: &[u8], out: &mut Vec<u8>) {
    out.clear();
    out.reserve(nal.len());
    let mut zeros = 0;
    for &b in nal {
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        out.push(b);
        if b == 0 {
            zeros += 1;
        } else {
            zeros = 0;
        }
    }
}

/// The RBSP of a NAL unit (emulation prevention bytes removed), read most
/// significant bit first; `E` is the error its reads fail with.
pub struct BitReader<'a, E> {
    data: &'a [u8],
    /// bit position
    pos: usize,
    error: PhantomData<fn() -> E>,
}

impl<'a, E: BitsError> BitReader<'a, E> {
    pub fn new(data: &'a [u8]) -> Self {
        BitReader { data, pos: 0, error: PhantomData }
    }

    #[inline]
    pub fn bit_pos(&self) -> usize {
        self.pos
    }

    #[inline]
    pub fn byte_pos(&self) -> usize {
        self.pos >> 3
    }

    /// Bits from the position to the end: negative once [`advance`] has
    /// gone past it.
    ///
    /// [`advance`]: BitReader::advance
    #[inline]
    pub fn bits_left(&self) -> isize {
        self.data.len() as isize * 8 - self.pos as isize
    }

    /// The next 32 bits (zeros past the end), without consuming.
    #[inline]
    pub fn peek32(&self) -> u32 {
        let byte = self.pos >> 3;
        let mut v: u64 = 0;
        for i in 0..5 {
            v = (v << 8) | *self.data.get(byte + i).unwrap_or(&0) as u64;
        }
        ((v << (self.pos & 7)) >> 8) as u32
    }

    /// The next `n` bits (n <= 32; zeros past the end), without consuming.
    #[inline]
    pub fn peek(&self, n: u32) -> u32 {
        debug_assert!(n <= 32);
        if n == 0 {
            return 0;
        }
        self.peek32() >> (32 - n)
    }

    /// Move `n` bits on without looking whether they are there: after a
    /// [`peek`] that found a code's length (CAVLC's tables). Past the end,
    /// every read fails and every peek gives zeros.
    ///
    /// [`peek`]: BitReader::peek
    #[inline]
    pub fn advance(&mut self, n: usize) {
        self.pos += n;
    }

    /// Skip `n` bits, which must be there.
    pub fn skip(&mut self, n: usize) -> Result<(), E> {
        if self.pos + n > self.data.len() * 8 {
            return Err(E::overrun());
        }
        self.pos += n;
        Ok(())
    }

    /// Return to an earlier bit position (to retry a parse).
    pub fn seek(&mut self, pos: usize) {
        self.pos = pos.min(self.data.len() * 8);
    }

    /// Skip to the next byte boundary.
    pub fn byte_align(&mut self) {
        self.pos = (self.pos + 7) & !7;
    }

    /// u(n), n <= 32.
    #[inline]
    pub fn u(&mut self, n: u32) -> Result<u32, E> {
        if self.pos + n as usize > self.data.len() * 8 {
            return Err(E::overrun());
        }
        let v = self.peek(n);
        self.pos += n as usize;
        Ok(v)
    }

    #[inline]
    pub fn flag(&mut self) -> Result<bool, E> {
        Ok(self.u(1)? != 0)
    }

    /// ue(v): unsigned Exp-Golomb, up to 2^32 - 2.
    #[inline]
    pub fn ue(&mut self) -> Result<u32, E> {
        // the zeros before the code's 1, sixteen bits at a time
        let mut zeros = 0u32;
        loop {
            let chunk = self.peek(16);
            if chunk != 0 {
                // the zeros of this chunk and the 1 that ends them
                let z = chunk.leading_zeros() - 16;
                zeros += z;
                self.pos += z as usize + 1;
                break;
            }
            zeros += 16;
            self.pos += 16;
            if zeros > 32 || self.bits_left() <= 0 {
                return Err(E::invalid("bad Exp-Golomb code"));
            }
        }
        if zeros == 0 {
            return Ok(0);
        }
        if zeros > 31 {
            return Err(E::invalid("Exp-Golomb code too long"));
        }
        let suffix = self.u(zeros)?;
        Ok(((1u64 << zeros) - 1 + suffix as u64) as u32)
    }

    /// ue(v) that must not exceed `max`.
    pub fn ue_max(&mut self, max: u32, what: &'static str) -> Result<u32, E> {
        let v = self.ue()?;
        if v > max {
            return Err(E::invalid(what));
        }
        Ok(v)
    }

    /// se(v): signed Exp-Golomb.
    #[inline]
    pub fn se(&mut self) -> Result<i32, E> {
        let k = self.ue()? as i64;
        Ok(if k & 1 == 1 { (k + 1) >> 1 } else { -(k >> 1) } as i32)
    }

    /// se(v) that must lie in `min..=max`.
    pub fn se_range(&mut self, min: i32, max: i32, what: &'static str) -> Result<i32, E> {
        let v = self.se()?;
        if v < min || v > max {
            return Err(E::invalid(what));
        }
        Ok(v)
    }

    /// te(v) with the given range (H.264 9.1): one inverted bit where the
    /// range is 1, ue(v) above.
    #[inline]
    pub fn te(&mut self, range: u32) -> Result<u32, E> {
        if range > 1 {
            self.ue()
        } else {
            Ok(1 - self.u(1)?)
        }
    }

    /// Whether syntax follows before the `rbsp_trailing_bits`.
    pub fn more_rbsp_data(&self) -> bool {
        let total = self.data.len() * 8;
        if self.pos >= total {
            return false;
        }
        // find the last 1 bit of the payload (the stop bit)
        let mut last = self.data.len();
        while last > 0 && self.data[last - 1] == 0 {
            last -= 1;
        }
        if last == 0 {
            return false;
        }
        let b = self.data[last - 1];
        let stop_bit_pos = (last - 1) * 8 + (7 - b.trailing_zeros() as usize);
        self.pos < stop_bit_pos
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A decoder's error, as far as a reader goes.
    #[derive(Debug, PartialEq)]
    enum Error {
        Overrun,
        Invalid(&'static str),
    }

    impl BitsError for Error {
        fn overrun() -> Self {
            Error::Overrun
        }
        fn invalid(what: &'static str) -> Self {
            Error::Invalid(what)
        }
    }

    type Reader<'a> = BitReader<'a, Error>;

    #[test]
    fn fixed_length_fields() {
        let bytes = [0b1010_0111, 0b1000_0001, 0xff, 0x00, 0x12];
        let mut r = Reader::new(&bytes);
        assert_eq!(r.u(0), Ok(0));
        assert_eq!(r.u(3), Ok(0b101));
        assert_eq!(r.flag(), Ok(false));
        assert_eq!(r.u(9), Ok(0b0_1111_0000));
        assert_eq!((r.bit_pos(), r.byte_pos(), r.bits_left()), (13, 1, 27));
        r.byte_align();
        assert_eq!(r.bit_pos(), 16);
        r.byte_align();
        assert_eq!(r.bit_pos(), 16, "aligned already");
        assert_eq!(r.u(24), Ok(0xff0012));
        assert_eq!(r.bits_left(), 0);
        // nothing is read past the end, and nothing moves
        assert_eq!(r.u(1), Err(Error::Overrun));
        assert_eq!(r.flag(), Err(Error::Overrun));
        assert_eq!(r.bit_pos(), 40);
        assert_eq!(r.u(0), Ok(0));
        let whole = [0x80, 0, 0, 1];
        assert_eq!(Reader::new(&whole).u(32), Ok(0x8000_0001));
    }

    #[test]
    fn exp_golomb() {
        // codes for 0,1,2,3,4: 1, 010, 011, 00100, 00101
        let bits = [0b1010_0110, 0b0100_0010, 0b1000_0000];
        let mut r = Reader::new(&bits);
        for want in 0..5 {
            assert_eq!(r.ue(), Ok(want));
        }
        let bits = [0b0100_1100, 0b1000_0000]; // 010 011 00100
        let mut r = Reader::new(&bits);
        assert_eq!(r.se(), Ok(1)); // ue 1
        assert_eq!(r.se(), Ok(-1)); // ue 2
        assert_eq!(r.se(), Ok(2)); // ue 3
        // codes of 16 leading zeros and more: 65535 = 16 zeros, then 1 0000000000000000; 65536 next
        let bits = [0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x40, 0x00, 0x40];
        let mut r = Reader::new(&bits);
        assert_eq!(r.ue(), Ok(65535));
        assert_eq!(r.bit_pos(), 33);
        assert_eq!(r.ue(), Ok(65536));
        assert_eq!(r.bit_pos(), 66);
    }

    #[test]
    fn the_longest_exp_golomb_codes() {
        // 31 zeros, a one, 31 ones: 2^32 - 2, the most a ue(v) can be
        let most = [0x00, 0x00, 0x00, 0x01, 0xff, 0xff, 0xff, 0xfe];
        let mut r = Reader::new(&most);
        assert_eq!(r.ue(), Ok(u32::MAX - 1));
        assert_eq!(r.bit_pos(), 63);
        // the same as se(v): an even code number k is -(k / 2)
        assert_eq!(Reader::new(&most).se(), Ok(-i32::MAX));
        // 32 zeros before the one: no code
        let long = [0x00, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00];
        assert_eq!(Reader::new(&long).ue(), Err(Error::Invalid("Exp-Golomb code too long")));
    }

    #[test]
    fn exp_golomb_codes_that_run_off_the_end() {
        // zeros to the end: an error, not a panic, however many
        for n in [1, 2, 3, 5, 9] {
            assert!(Reader::new(&vec![0; n]).ue().is_err(), "{n} zero bytes");
        }
        assert!(Reader::new(&[]).ue().is_err());
        // the zeros and the one are there, the bits after them are not
        assert_eq!(Reader::new(&[0b0000_1000]).ue(), Err(Error::Overrun));
        // after the last bit
        let mut r = Reader::new(&[0b1000_0000]);
        assert_eq!(r.ue(), Ok(0));
        r.advance(7);
        assert!(r.ue().is_err());
    }

    #[test]
    fn values_held_to_their_ranges() {
        let bits = [0b0010_1001, 0b0100_0000]; // ue 4, then 00101: ue 4 again (se -2)
        let mut r = Reader::new(&bits);
        assert_eq!(r.ue_max(4, "too many"), Ok(4));
        r.seek(0);
        assert_eq!(r.ue_max(3, "too many"), Err(Error::Invalid("too many")));
        r.seek(0);
        assert_eq!(r.se_range(-2, 2, "out of range"), Ok(-2));
        r.seek(0);
        assert_eq!(r.se_range(-1, 2, "out of range"), Err(Error::Invalid("out of range")));
    }

    #[test]
    fn truncated_exp_golomb() {
        let bits = [0b0100_0000];
        // a range of one is a single inverted bit
        let mut r = Reader::new(&bits);
        assert_eq!(r.te(1), Ok(1));
        assert_eq!(r.te(1), Ok(0));
        assert_eq!(r.bit_pos(), 2);
        // a wider one is ue(v)
        let mut r = Reader::new(&bits);
        assert_eq!(r.te(2), Ok(1));
        assert_eq!(r.bit_pos(), 3);
    }

    #[test]
    fn peeking_and_moving() {
        let bytes = [0b1100_0101, 0xa5];
        let mut r = Reader::new(&bytes);
        assert_eq!(r.peek(3), 0b110);
        assert_eq!(r.peek(0), 0);
        assert_eq!(r.bit_pos(), 0, "a peek consumes nothing");
        assert_eq!(r.peek32(), 0xc5a5_0000, "zeros past the end");
        r.advance(4);
        assert_eq!(r.peek(8), 0b0101_1010);
        // a skip looks first; an advance does not
        assert_eq!(r.skip(12), Ok(()));
        assert_eq!(r.skip(1), Err(Error::Overrun));
        assert_eq!(r.bit_pos(), 16);
        r.advance(9);
        assert_eq!((r.bit_pos(), r.bits_left()), (25, -9));
        assert_eq!(r.peek(16), 0);
        assert_eq!(r.u(1), Err(Error::Overrun));
        // back to an earlier place, or to the end at most
        r.seek(8);
        assert_eq!(r.u(8), Ok(0xa5));
        r.seek(1000);
        assert_eq!(r.bit_pos(), 16);
    }

    #[test]
    fn trailing_bits() {
        let bits = [0b1100_0000]; // 1 bit of payload then the stop bit
        let mut r = Reader::new(&bits);
        assert!(r.more_rbsp_data());
        r.advance(1);
        assert!(!r.more_rbsp_data());
        // the stop bit is the last 1 of the payload, whatever zero bytes follow it
        let padded = [0xff, 0b1010_0000, 0x00, 0x00];
        let mut r = Reader::new(&padded);
        r.advance(9);
        assert!(r.more_rbsp_data(), "one bit before the stop bit");
        r.advance(1);
        assert!(!r.more_rbsp_data());
        assert!(!Reader::new(&[0, 0]).more_rbsp_data(), "no stop bit at all");
        assert!(!Reader::new(&[]).more_rbsp_data());
    }

    #[test]
    fn unescaping() {
        assert_eq!(unescape(&[0, 0, 3, 1, 0, 0, 3, 0, 0, 3]), vec![0, 0, 1, 0, 0, 0, 0]);
        // only a 3 after two zeros goes
        assert_eq!(unescape(&[0, 0, 4]), vec![0, 0, 4]);
        assert_eq!(unescape(&[0, 3, 0, 0, 0, 3, 3]), vec![0, 3, 0, 0, 0, 3]);
        assert_eq!(unescape(&[]), Vec::<u8>::new());
        // into a buffer that held something else
        let mut out = vec![9; 20];
        unescape_into(&[1, 0, 0, 3, 2], &mut out);
        assert_eq!(out, vec![1, 0, 0, 2]);
    }
}
