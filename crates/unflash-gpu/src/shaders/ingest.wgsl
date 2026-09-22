// Pass A: source texture -> linear luminance L, red value V, saturation flag,
// into this frame's slice of the inputs buffer, as pictures arrive. The
// moved-pixel count and the pattern mask are the batch's business (moved.wgsl
// and the clear before the pattern pass).
//
// The source may be any size: each analysis pixel takes the area average of
// the source box it covers (weights are the fractional overlaps), in sRGB
// code space, then rounds to an 8-bit code and linearises through the same
// table the CPU uses. A source already at analysis resolution copies through
// exactly.

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> geo: array<u32>;
@group(0) @binding(2) var<storage, read> lut: array<f32>;
@group(0) @binding(3) var src: texture_2d<f32>;
@group(0) @binding(4) var<storage, read_write> inputs: array<u32>;
@group(0) @binding(5) var<storage, read_write> rgba: array<u32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let aw = geo[GEO_AW];
    let ah = geo[GEO_AH];
    let x = gid.x;
    let y = gid.y;
    if (x < aw && y < ah) {
        let sw = geo[GEO_SRC_W];
        let sh = geo[GEO_SRC_H];
        let n = params.npix;
        var c: vec3<f32>;
        if (sw == aw && sh == ah) {
            c = textureLoad(src, vec2<u32>(x, y), 0).rgb;
        } else {
            let fx0 = f32(x) * f32(sw) / f32(aw);
            let fx1 = f32(x + 1u) * f32(sw) / f32(aw);
            let fy0 = f32(y) * f32(sh) / f32(ah);
            let fy1 = f32(y + 1u) * f32(sh) / f32(ah);
            let ix0 = u32(floor(fx0));
            let ix1 = min(sw, u32(ceil(fx1)));
            let iy0 = u32(floor(fy0));
            let iy1 = min(sh, u32(ceil(fy1)));
            var acc = vec3<f32>(0.0, 0.0, 0.0);
            var wsum = 0.0;
            for (var sy = iy0; sy < iy1; sy = sy + 1u) {
                let wy = min(fy1, f32(sy + 1u)) - max(fy0, f32(sy));
                for (var sx = ix0; sx < ix1; sx = sx + 1u) {
                    let wx = min(fx1, f32(sx + 1u)) - max(fx0, f32(sx));
                    let w = wx * wy;
                    acc = acc + textureLoad(src, vec2<u32>(sx, sy), 0).rgb * w;
                    wsum = wsum + w;
                }
            }
            c = acc / max(wsum, 1e-9);
        }
        if (params.src_bgr != 0u) {
            c = c.bgr;
        }
        let code = clamp(vec3<i32>(round(c * 255.0)), vec3<i32>(0), vec3<i32>(255));
        let r = lut[u32(code.r)];
        let g = lut[u32(code.g)];
        let b = lut[u32(code.b)];
        let l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        let total = r + g + b;
        let sat = total > 1e-5 && r >= params.red_saturation * total;
        let v = max(r - g - b, 0.0) * 320.0;
        let i = y * aw + x;
        rgba[i] = u32(code.r) | (u32(code.g) << 8u) | (u32(code.b) << 16u) | 0xff000000u;
        inputs[i] = bitcast<u32>(l);
        inputs[n + i] = bitcast<u32>(v);
        inputs[2u * n + i] = u32(sat);
    }
}
