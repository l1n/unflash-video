//! Scaling (8.6.3) and inverse transformation (8.6.4) of residual blocks,
//! and adding residuals to predicted samples.

use crate::picture::Sample;

/// levelScale[ ] (8.6.3).
pub const LEVEL_SCALE: [i32; 6] = [40, 45, 51, 57, 64, 72];

/// The magnitudes of the 32-point transform: T[j] for the angle jπ/64
/// (T[0] is the DC basis).
const T: [i8; 33] = [64, 90, 90, 90, 89, 88, 87, 85, 83, 82, 80, 78, 75, 73, 70, 67, 64, 61, 57, 54, 50, 46, 43, 38, 36, 31, 25, 22, 18, 13, 9, 4, 0];

/// transMatrix (8-318 .. 8-321) as `M[frequency][sample]`: the basis
/// function k at sample n is T at the angle k(2n + 1) folded into the
/// first quadrant with the cosine's sign.
pub const DCT: [[i8; 32]; 32] = {
    let mut m = [[0i8; 32]; 32];
    let mut k = 0;
    while k < 32 {
        let mut n = 0;
        while n < 32 {
            let j = (k * (2 * n + 1)) % 128;
            m[k][n] = if k == 0 {
                64
            } else if j <= 32 {
                T[j]
            } else if j <= 64 {
                -T[64 - j]
            } else if j <= 96 {
                -T[j - 64]
            } else {
                T[128 - j]
            };
            n += 1;
        }
        k += 1;
    }
    m
};

/// The 4x4 DST of intra luma blocks (8-316), `[frequency][sample]`.
const DST: [[i32; 4]; 4] = [[29, 55, 74, 84], [74, 74, 0, -74], [84, -29, -74, 55], [55, -84, 74, -29]];

/// The `n`-point inverse DCT (`n` = 4, 8, 16 or 32) of `x`, of which only
/// the first `count` values may be non-zero, into `out`. The even
/// coefficients make the half-size transform (the matrix's even rows are
/// its rows), and the odd ones a part that the matrix's symmetry adds to
/// the first half and subtracts from the mirrored second half, which
/// takes a quarter of the multiplications of the plain matrix product.
fn idct(x: &[i32], n: usize, count: usize, out: &mut [i32]) {
    if n == 4 {
        let (e0, e1) = (64 * (x[0] + x[2]), 64 * (x[0] - x[2]));
        let (o0, o1) = (83 * x[1] + 36 * x[3], 36 * x[1] - 83 * x[3]);
        out[..4].copy_from_slice(&[e0 + o0, e1 + o1, e1 - o1, e0 - o0]);
        return;
    }
    let (half, step) = (n / 2, 32 / n);
    let mut even_x = [0i32; 16];
    for (e, &v) in even_x.iter_mut().zip(x.iter().step_by(2)).take(count.div_ceil(2)) {
        *e = v;
    }
    let mut even = [0i32; 16];
    idct(&even_x[..half], half, count.div_ceil(2), &mut even[..half]);
    let mut odd = [0i32; 16];
    let mut k = 1;
    while k < count {
        let (v, row) = (x[k], &DCT[k * step][..half]);
        for (o, &m) in odd.iter_mut().zip(row) {
            *o += m as i32 * v;
        }
        k += 2;
    }
    for (m, (&e, &o)) in even[..half].iter().zip(&odd).enumerate() {
        out[m] = e + o;
        out[n - 1 - m] = e - o;
    }
}

/// 8.6.4: the inverse transform of the `n`×`n` scaled coefficients in `c`
/// (row-major: `c[y * n + x]` is d[x][y]), whose non-zero values all lie in
/// columns 0..=`max_x` and rows 0..=`max_y`, into residuals (row-major,
/// after the final `bd_shift`, 8-299) in `res`. `c` is used as scratch.
pub fn inverse_transform(c: &mut [i32], n: usize, dst: bool, bd_shift: u32, max_x: usize, max_y: usize, res: &mut [i32]) {
    if max_x == 0 && max_y == 0 && !dst {
        // a DC coefficient alone: the transform is a constant
        let g = ((64 * c[0] + 64) >> 7).clamp(-32768, 32767);
        let v = (64 * g + (1 << (bd_shift - 1))) >> bd_shift;
        res[..n * n].fill(v);
        return;
    }
    let c = &mut c[..n * n];
    let res = &mut res[..n * n];
    let transform = |x: &[i32], count: usize, out: &mut [i32]| {
        if dst {
            for (y, o) in out[..4].iter_mut().enumerate() {
                *o = (0..count).map(|j| DST[j][y] * x[j]).sum();
            }
        } else {
            idct(x, n, count, out);
        }
    };
    // columns: g[x][y] = Clip3(coeffMin, coeffMax, (Σ_j M[j][y] d[x][j] + 64) >> 7),
    // written over the column's coefficients
    let mut col = [0i32; 32];
    let mut out = [0i32; 32];
    for x in 0..=max_x {
        for (j, v) in col[..=max_y].iter_mut().enumerate() {
            *v = c[j * n + x];
        }
        transform(&col[..n], max_y + 1, &mut out[..n]);
        for (y, &s) in out[..n].iter().enumerate() {
            c[y * n + x] = ((s + 64) >> 7).clamp(-32768, 32767);
        }
    }
    // rows: r[x][y] = Σ_j M[j][x] g[j][y], then the bdShift rounding (the
    // columns beyond max_x are still zero coefficients)
    let round = 1 << (bd_shift - 1);
    for (row, r) in c.chunks_exact(n).zip(res.chunks_exact_mut(n)) {
        transform(row, max_x + 1, &mut out[..n]);
        for (r, &s) in r.iter_mut().zip(&out[..n]) {
            *r = (s + round) >> bd_shift;
        }
    }
}

/// Add residuals to the prediction in `dst` (stride `ds`), clipping to
/// the bit depth.
pub fn add_residual<P: Sample>(dst: &mut [P], ds: usize, res: &[i32], n: usize, bit_depth: u32) {
    let max = (1 << bit_depth) - 1;
    for y in 0..n {
        let d = &mut dst[y * ds..y * ds + n];
        let r = &res[y * n..y * n + n];
        for (p, &v) in d.iter_mut().zip(r) {
            *p = P::new((p.get() + v).clamp(0, max));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matrix_matches_the_spec_rows() {
        assert_eq!(DCT[1][..16], [90, 90, 88, 85, 82, 78, 73, 67, 61, 54, 46, 38, 31, 22, 13, 4]);
        assert_eq!(DCT[5][..16], [88, 67, 31, -13, -54, -82, -90, -78, -46, -4, 38, 73, 90, 85, 61, 22]);
        assert_eq!(DCT[13][..16], [73, -31, -90, -22, 78, 67, -38, -90, -13, 82, 61, -46, -88, -4, 85, 54]);
        assert_eq!(DCT[31][..16], [4, -13, 22, -31, 38, -46, 54, -61, 67, -73, 78, -82, 85, -88, 90, -90]);
        assert_eq!(DCT[1][16..], [-4, -13, -22, -31, -38, -46, -54, -61, -67, -73, -78, -82, -85, -88, -90, -90]);
        assert_eq!(DCT[27][16..], [88, -67, 31, 13, -54, 82, -90, 78, -46, 4, 38, -73, 90, -85, 61, -22]);
        assert_eq!(DCT[28][16..], [18, -50, 75, -89, 89, -75, 50, -18, -18, 50, -75, 89, -89, 75, -50, 18]);
        assert_eq!(DCT[29][16..], [-90, 82, -67, 46, -22, -4, 31, -54, 73, -85, 90, -88, 78, -61, 38, -13]);
        assert_eq!(DCT[16][..8], [64, -64, -64, 64, 64, -64, -64, 64]);
    }

    #[test]
    fn butterflies_match_the_matrix_product() {
        let mut seed = 7u32;
        for n in [4, 8, 16, 32] {
            for count in 1..=n {
                let x: Vec<i32> = (0..n)
                    .map(|k| {
                        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                        if k < count {
                            (seed >> 16) as i32 % 65536 - 32768
                        } else {
                            0
                        }
                    })
                    .collect();
                let mut out = vec![0; n];
                idct(&x, n, count, &mut out);
                for (y, &o) in out.iter().enumerate() {
                    let direct: i32 = (0..n).map(|k| DCT[k * (32 / n)][y] as i32 * x[k]).sum();
                    assert_eq!(o, direct, "n {n} count {count} y {y}");
                }
            }
        }
    }

    #[test]
    fn dc_blocks_are_flat() {
        let mut c = vec![0i32; 64];
        c[0] = 100;
        let mut res = vec![0i32; 64];
        inverse_transform(&mut c, 8, false, 12, 0, 0, &mut res);
        let mut c2 = vec![0i32; 64];
        c2[0] = 100;
        c2[1] = 0;
        let mut res2 = vec![0i32; 64];
        // the general path with a (zero) second coefficient gives the same
        inverse_transform(&mut c2, 8, false, 12, 1, 0, &mut res2);
        assert_eq!(res, res2);
        assert!(res.iter().all(|&v| v == res[0]));
    }
}
