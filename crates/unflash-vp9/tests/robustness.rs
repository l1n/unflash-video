//! Corrupt input must never panic (a panic aborts the whole WebAssembly
//! instance): the test streams are decoded with random bit flips, byte
//! changes, truncated and reordered samples, and every result — frames,
//! damaged frames or errors — is acceptable except a panic.
//!
//! VP9_FUZZ_ROUNDS=n runs n rounds per stream instead of a few (in a debug
//! build, arithmetic overflow is caught too).

use std::path::PathBuf;

use unflash_vp9::Decoder;

fn media(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/media/vp9").join(name)
}

fn ivf_samples(data: &[u8]) -> Vec<Vec<u8>> {
    let mut p = u16::from_le_bytes([data[6], data[7]]) as usize;
    let mut out = Vec::new();
    while p + 12 <= data.len() {
        let size = u32::from_le_bytes(data[p..p + 4].try_into().unwrap()) as usize;
        out.push(data[p + 12..p + 12 + size].to_vec());
        p += 12 + size;
    }
    out
}

/// xorshift64*: deterministic, so a failure can be replayed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

fn mutate(rng: &mut Rng, samples: &mut Vec<Vec<u8>>, other: &[Vec<u8>]) {
    for _ in 0..1 + rng.below(3) {
        let i = rng.below(samples.len());
        let s = &mut samples[i];
        match rng.below(8) {
            // flip a few bits, often in the headers
            0 | 1 => {
                for _ in 0..1 + rng.below(4) {
                    if !s.is_empty() {
                        let limit = if rng.below(2) == 0 { s.len().min(24) } else { s.len() };
                        let k = rng.below(limit);
                        s[k] ^= 1 << rng.below(8);
                    }
                }
            }
            // overwrite a run of bytes
            2 => {
                if !s.is_empty() {
                    let k = rng.below(s.len());
                    for j in k..(k + 1 + rng.below(16)).min(s.len()) {
                        s[j] = rng.next() as u8;
                    }
                }
            }
            // truncate
            3 => {
                let n = rng.below(s.len() + 1);
                s.truncate(n);
            }
            // drop or repeat a sample
            4 => {
                samples.remove(i);
                if samples.is_empty() {
                    samples.push(Vec::new());
                }
            }
            5 => {
                let s = samples[i].clone();
                samples.insert(rng.below(samples.len()), s);
            }
            // a sample of another stream
            6 => {
                samples[i] = other[rng.below(other.len())].clone();
            }
            // random bytes appended (a bogus superframe index, say)
            _ => {
                for _ in 0..1 + rng.below(12) {
                    s.push(rng.next() as u8);
                }
            }
        }
    }
}

#[test]
fn corrupt_streams_do_not_panic() {
    let rounds: usize = std::env::var("VP9_FUZZ_ROUNDS").ok().and_then(|s| s.parse().ok()).unwrap_or(12);
    let names = ["altref.ivf", "p2_10bit.ivf", "tiles.ivf", "aq_cyclic.ivf", "lossless.ivf", "odd_small.ivf", "resize_odd.ivf", "errres.ivf"];
    let streams: Vec<Vec<Vec<u8>>> = names.iter().map(|n| ivf_samples(&std::fs::read(media(n)).expect("run tests/media/vp9/gen.sh"))).collect();
    let all: Vec<Vec<u8>> = streams.iter().flatten().cloned().collect();
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    for (name, samples) in names.iter().zip(&streams) {
        for round in 0..rounds {
            let mut s = samples.clone();
            mutate(&mut rng, &mut s, &all);
            let mut dec = Decoder::new(&[]).unwrap();
            dec.set_fast(round % 4 == 3);
            let mut frames = 0;
            for sample in &s {
                if let Ok(f) = dec.decode(sample, 0.0) {
                    frames += f.len();
                }
            }
            assert!(frames <= s.len() * 8, "{name} round {round}: too many frames");
        }
    }
}
