//! Reading the raw byte sequence payload of a NAL unit: fixed-length fields
//! and Exp-Golomb codes (9.2), with the reader the two NAL-unit decoders
//! share (`unflash_codec::bits`), failing with this decoder's errors.

use unflash_codec::bits::BitsError;

use crate::Error;

pub use unflash_codec::bits::unescape_into;

/// The RBSP of a NAL unit (emulation-prevention bytes removed), read MSB
/// first.
pub type BitReader<'a> = unflash_codec::bits::BitReader<'a, Error>;

impl BitsError for Error {
    fn overrun() -> Self {
        Error::Bitstream("read past the end of the NAL unit")
    }
    fn invalid(what: &'static str) -> Self {
        Error::Bitstream(what)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_read_that_fails_is_an_error_of_this_decoder() {
        let mut r = BitReader::new(&[0b0010_1000]);
        assert_eq!(r.se_range(-1, 1, "out of its range"), Err(Error::Bitstream("out of its range")));
        assert_eq!(r.skip(4), Err(Error::Bitstream("read past the end of the NAL unit")));
        // a code running off the end is an error, not a panic
        assert!(matches!(BitReader::new(&[0, 0]).ue(), Err(Error::Bitstream(_))));
    }
}
