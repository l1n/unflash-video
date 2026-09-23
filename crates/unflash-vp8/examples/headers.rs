//! Print the frame headers of an IVF file, one line per frame: which coding
//! tools a stream uses (for checking that test streams cover them).
//!
//!     cargo run --release -p unflash-vp8 --example headers -- <file.ivf>

use unflash_vp8::header::{parse_frame, State};

fn main() {
    let path = std::env::args().nth(1).expect("an IVF file");
    let data = std::fs::read(&path).expect("read");
    assert!(data.len() >= 32 && &data[..4] == b"DKIF", "not an IVF file");
    let mut p = u16::from_le_bytes([data[6], data[7]]) as usize;
    let mut st = State::default();
    let mut n = 0;
    while p + 12 <= data.len() {
        let size = u32::from_le_bytes(data[p..p + 4].try_into().unwrap()) as usize;
        p += 12;
        let frame = &data[p..(p + size).min(data.len())];
        p += size;
        let mut next = st.clone();
        match parse_frame(frame, &mut next) {
            Ok(f) => {
                let h = &f.header;
                let seg = &next.segmentation;
                let d = &next.deltas;
                let mut line = format!("{n:4} {} v{} {:6} bytes", if h.tag.key_frame { "key  " } else { "inter" }, h.tag.version, frame.len());
                if h.tag.key_frame {
                    line += &format!(" {}x{} scale {:?} cs {} clamp {}", h.width, h.height, h.scale, h.color_space as u8, h.clamping_type as u8);
                }
                if !h.tag.show_frame {
                    line += " INVISIBLE";
                }
                line += &format!(" parts {} q {} {:?} lf {}{} sharp {}", f.num_partitions, h.q_index, h.q_deltas, if h.simple_filter { "simple " } else { "" }, h.filter_level, h.sharpness);
                if d.enabled {
                    line += &format!(" deltas ref {:?} mode {:?}", d.ref_frame, d.mode);
                }
                if seg.enabled {
                    line += &format!(" seg{}{} q {:?} lf {:?}", if seg.update_map { " map" } else { "" }, if seg.absolute { " abs" } else { "" }, seg.quant, seg.filter_level);
                }
                if !h.tag.key_frame {
                    line += &format!(" refresh g{} a{} l{} copy g{} a{} bias g{} a{}", h.refresh_golden as u8, h.refresh_altref as u8, h.refresh_last as u8, h.copy_to_golden, h.copy_to_altref, h.sign_bias_golden as u8, h.sign_bias_altref as u8);
                }
                if !h.refresh_entropy {
                    line += " no-entropy-refresh";
                }
                if h.skip_prob.is_none() {
                    line += " no-skip";
                }
                println!("{line}");
                st = next;
                if let Some(saved) = f.saved_probs {
                    st.probs = saved;
                }
            }
            Err(e) => println!("{n:4} {e}"),
        }
        n += 1;
    }
}
