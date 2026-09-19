// Pass C: one workgroup per row. Prefix-scans L, V and the eight mask bits
// across the row in workgroup memory, then writes each window position's
// row-window sums, and the row-window maxima of the onset ages, to `rowwin`.
// `{{E}}` = elements per thread = ceil(width / 256).

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> geo: array<u32>;
@group(0) @binding(2) var<storage, read> inputs: array<u32>;
@group(0) @binding(3) var<storage, read> pixout: array<u32>;
@group(0) @binding(4) var<storage, read_write> rowwin: array<u32>;
@group(0) @binding(5) var<storage, read_write> rowtot: array<f32>;

const E: u32 = {{E}};

var<workgroup> tl: array<f32, 256>;
var<workgroup> tv: array<f32, 256>;
var<workgroup> t01: array<u32, 256>;
var<workgroup> t23: array<u32, 256>;
var<workgroup> t45: array<u32, 256>;
var<workgroup> t67: array<u32, 256>;
var<workgroup> nl: array<f32, 128>;
var<workgroup> nv: array<f32, 128>;
var<workgroup> n01: array<u32, 128>;
var<workgroup> n23: array<u32, 128>;
var<workgroup> n45: array<u32, 128>;
var<workgroup> n67: array<u32, 128>;
var<workgroup> cg: array<u32, 256>;
var<workgroup> cr: array<u32, 256>;

fn pack01(m: u32) -> u32 {
    return (m & 1u) | (((m >> 1u) & 1u) << 16u);
}
fn pack23(m: u32) -> u32 {
    return ((m >> 2u) & 1u) | (((m >> 3u) & 1u) << 16u);
}
fn pack45(m: u32) -> u32 {
    return ((m >> 4u) & 1u) | (((m >> 5u) & 1u) << 16u);
}
fn pack67(m: u32) -> u32 {
    return ((m >> 6u) & 1u) | (((m >> 7u) & 1u) << 16u);
}

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
    let y = wid.x;
    let w = params.width;
    let n = params.npix;
    let t = lid.x;
    let ngx = geo[GEO_NGX];
    let ww = geo[GEO_WW];

    // 1. this thread's chunk: inclusive local prefixes and chunk maxima
    var pl: array<f32, E>;
    var pv: array<f32, E>;
    var p01: array<u32, E>;
    var p23: array<u32, E>;
    var p45: array<u32, E>;
    var p67: array<u32, E>;
    var sl = 0.0;
    var sv = 0.0;
    var s01 = 0u;
    var s23 = 0u;
    var s45 = 0u;
    var s67 = 0u;
    var mg = 0u;
    var mr = 0u;
    for (var e = 0u; e < E; e = e + 1u) {
        let x = t * E + e;
        if (x < w) {
            let idx = y * w + x;
            sl = sl + bitcast<f32>(inputs[idx]);
            sv = sv + bitcast<f32>(inputs[n + idx]);
            let m = pixout[idx];
            s01 = s01 + pack01(m);
            s23 = s23 + pack23(m);
            s45 = s45 + pack45(m);
            s67 = s67 + pack67(m);
            mg = max(mg, pixout[n + idx]);
            mr = max(mr, pixout[2u * n + idx]);
        }
        pl[e] = sl;
        pv[e] = sv;
        p01[e] = s01;
        p23[e] = s23;
        p45[e] = s45;
        p67[e] = s67;
    }
    tl[t] = sl;
    tv[t] = sv;
    t01[t] = s01;
    t23[t] = s23;
    t45[t] = s45;
    t67[t] = s67;
    cg[t] = mg;
    cr[t] = mr;
    workgroupBarrier();

    // 2. inclusive scan of the thread totals (Hillis-Steele)
    for (var off = 1u; off < 256u; off = off << 1u) {
        var al = 0.0;
        var av = 0.0;
        var a01 = 0u;
        var a23 = 0u;
        var a45 = 0u;
        var a67 = 0u;
        if (t >= off) {
            al = tl[t - off];
            av = tv[t - off];
            a01 = t01[t - off];
            a23 = t23[t - off];
            a45 = t45[t - off];
            a67 = t67[t - off];
        }
        workgroupBarrier();
        if (t >= off) {
            tl[t] = tl[t] + al;
            tv[t] = tv[t] + av;
            t01[t] = t01[t] + a01;
            t23[t] = t23[t] + a23;
            t45[t] = t45[t] + a45;
            t67[t] = t67[t] + a67;
        }
        workgroupBarrier();
    }

    // 3. exclusive prefix of this thread, and the prefixes at the window edges
    var xl = 0.0;
    var xv = 0.0;
    var x01 = 0u;
    var x23 = 0u;
    var x45 = 0u;
    var x67 = 0u;
    if (t > 0u) {
        xl = tl[t - 1u];
        xv = tv[t - 1u];
        x01 = t01[t - 1u];
        x23 = t23[t - 1u];
        x45 = t45[t - 1u];
        x67 = t67[t - 1u];
    }
    for (var gi = 0u; gi < ngx; gi = gi + 1u) {
        let gx = geo[GEO_GXS + gi];
        for (var side = 0u; side < 2u; side = side + 1u) {
            let p = gx + side * ww;     // prefix position: sum of elements [0, p)
            let slot = 2u * gi + side;
            if (p == 0u) {
                if (t == 0u) {
                    nl[slot] = 0.0;
                    nv[slot] = 0.0;
                    n01[slot] = 0u;
                    n23[slot] = 0u;
                    n45[slot] = 0u;
                    n67[slot] = 0u;
                }
            } else {
                let q = p - 1u;          // last element inside the prefix
                if (q >= t * E && q < (t + 1u) * E) {
                    let e = q - t * E;
                    nl[slot] = xl + pl[e];
                    nv[slot] = xv + pv[e];
                    n01[slot] = x01 + p01[e];
                    n23[slot] = x23 + p23[e];
                    n45[slot] = x45 + p45[e];
                    n67[slot] = x67 + p67[e];
                }
            }
        }
    }
    if (t == 255u) {
        rowtot[y] = tl[255u];
    }
    workgroupBarrier();

    // 4. one thread per window position: sums and onset maxima
    if (t < ngx) {
        let gx = geo[GEO_GXS + t];
        let a = 2u * t;
        let b = a + 1u;
        let m01 = n01[b] - n01[a];
        let m23 = n23[b] - n23[a];
        let m45 = n45[b] - n45[a];
        let m67 = n67[b] - n67[a];
        var og = 0u;
        var orr = 0u;
        let x0 = gx;
        let x1 = gx + ww;
        let c0 = x0 / E;
        let c1 = (x1 - 1u) / E;
        for (var c = c0; c <= c1; c = c + 1u) {
            let cs = c * E;
            let ce = cs + E;
            if (cs >= x0 && ce <= x1) {
                og = max(og, cg[c]);
                orr = max(orr, cr[c]);
            } else {
                for (var x = max(cs, x0); x < min(ce, x1); x = x + 1u) {
                    let idx = y * w + x;
                    og = max(og, pixout[n + idx]);
                    orr = max(orr, pixout[2u * n + idx]);
                }
            }
        }
        let base = (y * ngx + t) * CELL_WORDS;
        rowwin[base + 0u] = bitcast<u32>(nl[b] - nl[a]);
        rowwin[base + 1u] = bitcast<u32>(nv[b] - nv[a]);
        rowwin[base + 2u] = m01 & 0xffffu;
        rowwin[base + 3u] = m01 >> 16u;
        rowwin[base + 4u] = m23 & 0xffffu;
        rowwin[base + 5u] = m23 >> 16u;
        rowwin[base + 6u] = m45 & 0xffffu;
        rowwin[base + 7u] = m45 >> 16u;
        rowwin[base + 8u] = m67 & 0xffffu;
        rowwin[base + 9u] = m67 >> 16u;
        rowwin[base + 10u] = og;
        rowwin[base + 11u] = orr;
    }
}
