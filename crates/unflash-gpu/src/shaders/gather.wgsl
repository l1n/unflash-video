// Pass D: one workgroup per window position sums its rows' window values
// into one grid cell of the output; workgroup 0 also totals the frame's
// luminance and copies (then clears) the moved-pixel count.

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> geo: array<u32>;
@group(0) @binding(2) var<storage, read> rowwin: array<u32>;
@group(0) @binding(3) var<storage, read> rowtot: array<f32>;
@group(0) @binding(4) var<storage, read_write> globals: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> out: array<u32>;

var<workgroup> rl: array<f32, 256>;
var<workgroup> rv: array<f32, 256>;
var<workgroup> rc: array<array<u32, 8>, 256>;
var<workgroup> rog: array<u32, 256>;
var<workgroup> ror: array<u32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
    let cell = wid.x;
    let t = lid.x;
    let ngx = geo[GEO_NGX];
    let wh = geo[GEO_WH];
    let gi = cell % ngx;
    let gj = cell / ngx;
    let gy = geo[GEO_GYS + gj];

    var sl = 0.0;
    var sv = 0.0;
    var cnt: array<u32, 8>;
    for (var k = 0u; k < 8u; k = k + 1u) {
        cnt[k] = 0u;
    }
    var og = 0u;
    var orr = 0u;
    for (var r = t; r < wh; r = r + 256u) {
        let base = ((gy + r) * ngx + gi) * CELL_WORDS;
        sl = sl + bitcast<f32>(rowwin[base]);
        sv = sv + bitcast<f32>(rowwin[base + 1u]);
        for (var k = 0u; k < 8u; k = k + 1u) {
            cnt[k] = cnt[k] + rowwin[base + 2u + k];
        }
        og = max(og, rowwin[base + 10u]);
        orr = max(orr, rowwin[base + 11u]);
    }
    rl[t] = sl;
    rv[t] = sv;
    for (var k = 0u; k < 8u; k = k + 1u) {
        rc[t][k] = cnt[k];
    }
    rog[t] = og;
    ror[t] = orr;
    workgroupBarrier();
    for (var off = 128u; off > 0u; off = off >> 1u) {
        if (t < off) {
            rl[t] = rl[t] + rl[t + off];
            rv[t] = rv[t] + rv[t + off];
            for (var k = 0u; k < 8u; k = k + 1u) {
                rc[t][k] = rc[t][k] + rc[t + off][k];
            }
            rog[t] = max(rog[t], rog[t + off]);
            ror[t] = max(ror[t], ror[t + off]);
        }
        workgroupBarrier();
    }
    if (t == 0u) {
        let base = OUT_HEADER + cell * CELL_WORDS;
        out[base] = bitcast<u32>(rl[0]);
        out[base + 1u] = bitcast<u32>(rv[0]);
        for (var k = 0u; k < 8u; k = k + 1u) {
            out[base + 2u + k] = rc[0][k];
        }
        out[base + 10u] = rog[0];
        out[base + 11u] = ror[0];
    }

    if (cell == 0u) {
        // whole-frame luminance total and the moved-pixel count
        workgroupBarrier();
        var s = 0.0;
        for (var y = t; y < params.height; y = y + 256u) {
            s = s + rowtot[y];
        }
        rl[t] = s;
        workgroupBarrier();
        for (var off = 128u; off > 0u; off = off >> 1u) {
            if (t < off) {
                rl[t] = rl[t] + rl[t + off];
            }
            workgroupBarrier();
        }
        if (t == 0u) {
            out[0] = bitcast<u32>(rl[0]);
            out[1] = atomicLoad(&globals[0]);
            atomicStore(&globals[0], 0u);
            out[2] = params.now;
            out[3] = params.mode;
        }
    }
}
