//! Print the parameter sets of an Annex B stream.
use unflash_h264::bitreader::unescape;
use unflash_h264::ps::{parse_pps, parse_sps};
fn main() {
    let data = std::fs::read(std::env::args().nth(1).unwrap()).unwrap();
    let mut i = 0;
    let mut starts = Vec::new();
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    for (k, &s) in starts.iter().enumerate() {
        let e = if k + 1 < starts.len() { starts[k + 1] - 3 } else { data.len() };
        let nal = &data[s..e];
        match nal[0] & 0x1f {
            7 => println!("SPS: {:?}", parse_sps(&unescape(&nal[1..]))),
            8 => println!("PPS: {:?}", parse_pps(&unescape(&nal[1..])).map(|p| (p.id, p.sps_id, p.entropy_coding_mode, p.num_ref_idx_default_active, p.weighted_pred, p.weighted_bipred_idc, p.transform_8x8_mode))),
            _ => {}
        }
        if k > 40 { break; }
    }
}
