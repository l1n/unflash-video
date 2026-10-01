//! Decode an AC-3 / E-AC-3 elementary stream to interleaved 32-bit float
//! PCM, as `ffmpeg -i IN -f f32le -c:a pcm_f32le OUT` would write it.
//!
//!     cargo run --release -p unflash-ac3 --example decode -- IN OUT [stereo] [quiet]
//!
//! `stereo` asks for the Lo/Ro downmix; `quiet` turns dither and the
//! spectral extension noise off.

use unflash_ac3::{Decoder, Output};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: decode IN OUT [stereo] [quiet]");
        std::process::exit(2);
    }
    let data = std::fs::read(&args[1]).expect("read input");
    let stereo = args.iter().any(|a| a == "stereo");
    let quiet = args.iter().any(|a| a == "quiet");
    let mut dec = Decoder::new(if stereo { Output::Stereo } else { Output::Native });
    dec.set_noise(!quiet);
    let mut out = Vec::new();
    let t0 = std::time::Instant::now();
    let r = dec.decode(&data, &mut out);
    let secs = t0.elapsed().as_secs_f64();
    match r {
        Ok(d) => {
            let info = dec.info();
            eprintln!("{} samples, {} damaged frames, {:?}, {:?}", d.samples, d.damaged, info, dec.features());
            if let Some(i) = info {
                let dur = d.samples as f64 / i.sample_rate as f64;
                eprintln!("decoded {dur:.2} s in {:.3} s ({:.0}x real time)", secs, dur / secs);
            }
        }
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
    let n = out.first().map_or(0, |c| c.len());
    let mut bytes = Vec::with_capacity(n * out.len() * 4);
    for i in 0..n {
        for c in &out {
            bytes.extend_from_slice(&c[i].to_le_bytes());
        }
    }
    std::fs::write(&args[2], bytes).expect("write output");
}
