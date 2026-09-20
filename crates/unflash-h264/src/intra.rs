//! Intra prediction (8.3). The caller gathers the neighbouring samples and
//! their availability; unavailable samples must be filled with 128 so an
//! unlikely mode on a broken stream still produces a picture.

#[inline(always)]
fn clip(v: i32) -> u8 {
    v.clamp(0, 255) as u8
}

/// Neighbouring samples of a block: `above[x]` is p[x, -1], `left[y]` is
/// p[-1, y], `corner` is p[-1, -1].
pub struct Edges<'a> {
    pub above: &'a [u8],
    pub left: &'a [u8],
    pub corner: u8,
    pub avail_above: bool,
    pub avail_left: bool,
    pub avail_corner: bool,
}

/// 8.3.1.2: Intra_4x4 prediction; `above` has 8 samples (the caller
/// substitutes p[3,-1] for a missing above-right).
pub fn pred4x4(mode: u32, e: &Edges, out: &mut [u8; 16]) {
    let a = |x: i32| -> i32 { e.above[x as usize] as i32 };
    let l = |y: i32| -> i32 { e.left[y as usize] as i32 };
    let c = e.corner as i32;
    // p[x,-1] for x = -1..7 and p[-1,y] for y = -1..3 through one accessor
    let p = |x: i32, y: i32| -> i32 {
        if y < 0 {
            if x < 0 {
                c
            } else {
                a(x)
            }
        } else {
            l(y)
        }
    };
    for y in 0..4i32 {
        for x in 0..4i32 {
            let v = match mode {
                0 => p(x, -1),
                1 => p(-1, y),
                2 => {
                    if e.avail_above && e.avail_left {
                        (a(0) + a(1) + a(2) + a(3) + l(0) + l(1) + l(2) + l(3) + 4) >> 3
                    } else if e.avail_left {
                        (l(0) + l(1) + l(2) + l(3) + 2) >> 2
                    } else if e.avail_above {
                        (a(0) + a(1) + a(2) + a(3) + 2) >> 2
                    } else {
                        128
                    }
                }
                3 => {
                    if x == 3 && y == 3 {
                        (a(6) + 3 * a(7) + 2) >> 2
                    } else {
                        (a(x + y) + 2 * a(x + y + 1) + a(x + y + 2) + 2) >> 2
                    }
                }
                4 => {
                    if x > y {
                        (p(x - y - 2, -1) + 2 * p(x - y - 1, -1) + p(x - y, -1) + 2) >> 2
                    } else if x < y {
                        (p(-1, y - x - 2) + 2 * p(-1, y - x - 1) + p(-1, y - x) + 2) >> 2
                    } else {
                        (p(0, -1) + 2 * p(-1, -1) + p(-1, 0) + 2) >> 2
                    }
                }
                5 => {
                    let z = 2 * x - y;
                    if z >= 0 && z % 2 == 0 {
                        (p(x - (y >> 1) - 1, -1) + p(x - (y >> 1), -1) + 1) >> 1
                    } else if z >= 0 {
                        (p(x - (y >> 1) - 2, -1) + 2 * p(x - (y >> 1) - 1, -1) + p(x - (y >> 1), -1) + 2) >> 2
                    } else if z == -1 {
                        (p(-1, 0) + 2 * p(-1, -1) + p(0, -1) + 2) >> 2
                    } else {
                        (p(-1, y - 1) + 2 * p(-1, y - 2) + p(-1, y - 3) + 2) >> 2
                    }
                }
                6 => {
                    let z = 2 * y - x;
                    if z >= 0 && z % 2 == 0 {
                        (p(-1, y - (x >> 1) - 1) + p(-1, y - (x >> 1)) + 1) >> 1
                    } else if z >= 0 {
                        (p(-1, y - (x >> 1) - 2) + 2 * p(-1, y - (x >> 1) - 1) + p(-1, y - (x >> 1)) + 2) >> 2
                    } else if z == -1 {
                        (p(-1, 0) + 2 * p(-1, -1) + p(0, -1) + 2) >> 2
                    } else {
                        (p(x - 1, -1) + 2 * p(x - 2, -1) + p(x - 3, -1) + 2) >> 2
                    }
                }
                7 => {
                    if y % 2 == 0 {
                        (a(x + (y >> 1)) + a(x + (y >> 1) + 1) + 1) >> 1
                    } else {
                        (a(x + (y >> 1)) + 2 * a(x + (y >> 1) + 1) + a(x + (y >> 1) + 2) + 2) >> 2
                    }
                }
                _ => {
                    let z = x + 2 * y;
                    if z < 5 && z % 2 == 0 {
                        (l(y + (x >> 1)) + l(y + (x >> 1) + 1) + 1) >> 1
                    } else if z < 5 {
                        (l(y + (x >> 1)) + 2 * l(y + (x >> 1) + 1) + l(y + (x >> 1) + 2) + 2) >> 2
                    } else if z == 5 {
                        (l(2) + 3 * l(3) + 2) >> 2
                    } else {
                        l(3)
                    }
                }
            };
            out[(y * 4 + x) as usize] = clip(v);
        }
    }
}

/// 8.3.2.2: Intra_8x8 prediction with the reference sample filtering.
/// `above` has 16 samples (above-right substituted by the caller).
pub fn pred8x8(mode: u32, e: &Edges, out: &mut [u8; 64]) {
    // 8.3.2.2.1 filtering
    let a: Vec<i32> = e.above.iter().map(|&v| v as i32).collect();
    let l: Vec<i32> = e.left.iter().map(|&v| v as i32).collect();
    let c = e.corner as i32;
    let mut fa = [0i32; 16];
    let mut fl = [0i32; 8];
    let mut fc = c;
    if e.avail_above {
        fa[0] = if e.avail_corner { (c + 2 * a[0] + a[1] + 2) >> 2 } else { (3 * a[0] + a[1] + 2) >> 2 };
        for x in 1..15 {
            fa[x] = (a[x - 1] + 2 * a[x] + a[x + 1] + 2) >> 2;
        }
        fa[15] = (a[14] + 3 * a[15] + 2) >> 2;
    }
    if e.avail_corner {
        fc = if e.avail_above && e.avail_left {
            (a[0] + 2 * c + l[0] + 2) >> 2
        } else if e.avail_above {
            (3 * c + a[0] + 2) >> 2
        } else if e.avail_left {
            (3 * c + l[0] + 2) >> 2
        } else {
            c
        };
    }
    if e.avail_left {
        fl[0] = if e.avail_corner { (c + 2 * l[0] + l[1] + 2) >> 2 } else { (3 * l[0] + l[1] + 2) >> 2 };
        for y in 1..7 {
            fl[y] = (l[y - 1] + 2 * l[y] + l[y + 1] + 2) >> 2;
        }
        fl[7] = (l[6] + 3 * l[7] + 2) >> 2;
    }
    let a = |x: i32| -> i32 { fa[x as usize] };
    let l = |y: i32| -> i32 { fl[y as usize] };
    let p = |x: i32, y: i32| -> i32 {
        if y < 0 {
            if x < 0 {
                fc
            } else {
                a(x)
            }
        } else {
            l(y)
        }
    };
    for y in 0..8i32 {
        for x in 0..8i32 {
            let v = match mode {
                0 => a(x),
                1 => l(y),
                2 => {
                    if e.avail_above && e.avail_left {
                        ((0..8).map(a).sum::<i32>() + (0..8).map(l).sum::<i32>() + 8) >> 4
                    } else if e.avail_left {
                        ((0..8).map(l).sum::<i32>() + 4) >> 3
                    } else if e.avail_above {
                        ((0..8).map(a).sum::<i32>() + 4) >> 3
                    } else {
                        128
                    }
                }
                3 => {
                    if x == 7 && y == 7 {
                        (a(14) + 3 * a(15) + 2) >> 2
                    } else {
                        (a(x + y) + 2 * a(x + y + 1) + a(x + y + 2) + 2) >> 2
                    }
                }
                4 => {
                    if x > y {
                        (p(x - y - 2, -1) + 2 * p(x - y - 1, -1) + p(x - y, -1) + 2) >> 2
                    } else if x < y {
                        (p(-1, y - x - 2) + 2 * p(-1, y - x - 1) + p(-1, y - x) + 2) >> 2
                    } else {
                        (p(0, -1) + 2 * p(-1, -1) + p(-1, 0) + 2) >> 2
                    }
                }
                5 => {
                    let z = 2 * x - y;
                    if z >= 0 && z % 2 == 0 {
                        (p(x - (y >> 1) - 1, -1) + p(x - (y >> 1), -1) + 1) >> 1
                    } else if z >= 0 {
                        (p(x - (y >> 1) - 2, -1) + 2 * p(x - (y >> 1) - 1, -1) + p(x - (y >> 1), -1) + 2) >> 2
                    } else if z == -1 {
                        (p(-1, 0) + 2 * p(-1, -1) + p(0, -1) + 2) >> 2
                    } else {
                        (p(-1, y - 2 * x - 1) + 2 * p(-1, y - 2 * x - 2) + p(-1, y - 2 * x - 3) + 2) >> 2
                    }
                }
                6 => {
                    let z = 2 * y - x;
                    if z >= 0 && z % 2 == 0 {
                        (p(-1, y - (x >> 1) - 1) + p(-1, y - (x >> 1)) + 1) >> 1
                    } else if z >= 0 {
                        (p(-1, y - (x >> 1) - 2) + 2 * p(-1, y - (x >> 1) - 1) + p(-1, y - (x >> 1)) + 2) >> 2
                    } else if z == -1 {
                        (p(-1, 0) + 2 * p(-1, -1) + p(0, -1) + 2) >> 2
                    } else {
                        (p(x - 2 * y - 1, -1) + 2 * p(x - 2 * y - 2, -1) + p(x - 2 * y - 3, -1) + 2) >> 2
                    }
                }
                7 => {
                    if y % 2 == 0 {
                        (a(x + (y >> 1)) + a(x + (y >> 1) + 1) + 1) >> 1
                    } else {
                        (a(x + (y >> 1)) + 2 * a(x + (y >> 1) + 1) + a(x + (y >> 1) + 2) + 2) >> 2
                    }
                }
                _ => {
                    let z = x + 2 * y;
                    if z < 13 && z % 2 == 0 {
                        (l(y + (x >> 1)) + l(y + (x >> 1) + 1) + 1) >> 1
                    } else if z < 13 {
                        (l(y + (x >> 1)) + 2 * l(y + (x >> 1) + 1) + l(y + (x >> 1) + 2) + 2) >> 2
                    } else if z == 13 {
                        (l(6) + 3 * l(7) + 2) >> 2
                    } else {
                        l(7)
                    }
                }
            };
            out[(y * 8 + x) as usize] = clip(v);
        }
    }
}

/// 8.3.3: Intra_16x16 prediction (`above` and `left` hold 16 samples).
pub fn pred16x16(mode: u32, e: &Edges, out: &mut [u8; 256]) {
    let a = |x: i32| -> i32 { e.above[x as usize] as i32 };
    let l = |y: i32| -> i32 { e.left[y as usize] as i32 };
    match mode {
        0 => {
            for y in 0..16 {
                for x in 0..16 {
                    out[y * 16 + x] = e.above[x];
                }
            }
        }
        1 => {
            for y in 0..16 {
                for x in 0..16 {
                    out[y * 16 + x] = e.left[y];
                }
            }
        }
        2 => {
            let v = if e.avail_above && e.avail_left {
                ((0..16).map(a).sum::<i32>() + (0..16).map(l).sum::<i32>() + 16) >> 5
            } else if e.avail_left {
                ((0..16).map(l).sum::<i32>() + 8) >> 4
            } else if e.avail_above {
                ((0..16).map(a).sum::<i32>() + 8) >> 4
            } else {
                128
            };
            out.fill(v as u8);
        }
        _ => {
            let c = e.corner as i32;
            let pa = |x: i32| if x < 0 { c } else { a(x) };
            let pl = |y: i32| if y < 0 { c } else { l(y) };
            let mut h = 0;
            let mut v = 0;
            for k in 0..8i32 {
                h += (k + 1) * (pa(8 + k) - pa(6 - k));
                v += (k + 1) * (pl(8 + k) - pl(6 - k));
            }
            let aa = 16 * (l(15) + a(15));
            let b = (5 * h + 32) >> 6;
            let cc = (5 * v + 32) >> 6;
            for y in 0..16i32 {
                for x in 0..16i32 {
                    out[(y * 16 + x) as usize] = clip((aa + b * (x - 7) + cc * (y - 7) + 16) >> 5);
                }
            }
        }
    }
}

/// 8.3.4: chroma prediction of one 8x8 (4:2:0) component; `above` and
/// `left` hold 8 samples.
pub fn pred_chroma(mode: u32, e: &Edges, out: &mut [u8; 64]) {
    let a = |x: i32| -> i32 { e.above[x as usize] as i32 };
    let l = |y: i32| -> i32 { e.left[y as usize] as i32 };
    match mode {
        0 => {
            // DC, per 4x4 chroma block
            for by in 0..2i32 {
                for bx in 0..2i32 {
                    let sa: i32 = (0..4).map(|k| a(bx * 4 + k)).sum();
                    let sl: i32 = (0..4).map(|k| l(by * 4 + k)).sum();
                    let v = if (bx == 0 && by == 0) || (bx > 0 && by > 0) {
                        if e.avail_above && e.avail_left {
                            (sa + sl + 4) >> 3
                        } else if e.avail_left {
                            (sl + 2) >> 2
                        } else if e.avail_above {
                            (sa + 2) >> 2
                        } else {
                            128
                        }
                    } else if bx > 0 {
                        if e.avail_above {
                            (sa + 2) >> 2
                        } else if e.avail_left {
                            (sl + 2) >> 2
                        } else {
                            128
                        }
                    } else if e.avail_left {
                        (sl + 2) >> 2
                    } else if e.avail_above {
                        (sa + 2) >> 2
                    } else {
                        128
                    };
                    for y in 0..4 {
                        for x in 0..4 {
                            out[((by * 4 + y) * 8 + bx * 4 + x) as usize] = v as u8;
                        }
                    }
                }
            }
        }
        1 => {
            for y in 0..8 {
                for x in 0..8 {
                    out[y * 8 + x] = e.left[y];
                }
            }
        }
        2 => {
            for y in 0..8 {
                for x in 0..8 {
                    out[y * 8 + x] = e.above[x];
                }
            }
        }
        _ => {
            let c = e.corner as i32;
            let pa = |x: i32| if x < 0 { c } else { a(x) };
            let pl = |y: i32| if y < 0 { c } else { l(y) };
            let mut h = 0;
            let mut v = 0;
            for k in 0..4i32 {
                h += (k + 1) * (pa(4 + k) - pa(2 - k));
                v += (k + 1) * (pl(4 + k) - pl(2 - k));
            }
            let aa = 16 * (l(7) + a(7));
            let b = (34 * h + 32) >> 6;
            let cc = (34 * v + 32) >> 6;
            for y in 0..8i32 {
                for x in 0..8i32 {
                    out[(y * 8 + x) as usize] = clip((aa + b * (x - 3) + cc * (y - 3) + 16) >> 5);
                }
            }
        }
    }
}
