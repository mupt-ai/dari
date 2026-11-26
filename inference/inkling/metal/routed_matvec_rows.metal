// One expert's rows applied to its R routes. R is a template parameter so every per-route array
// stays in registers. Each lane owns sixteen consecutive inputs, inside one scale group: NVFP4
// (16-value groups of 4-bit weights) or MXFP8 (32-value groups of 8-bit weights).
template <uint R, uint ROWS, uint K, uint N, bool ACT, bool FP8>
METAL_FUNC void routed_rows(const device bfloat *a, const device uchar *weights,
                            const device uchar *group, const device uint *slots, uint row,
                            uint lane, float global, device bfloat *out) {
    uint source[R];
    for (uint r = 0; r < R; r++)
        source[r] = (ACT ? slots[r] / 8 : slots[r]) * K;
    float total[ROWS][R] = {};
    for (uint k = lane * 16; k < K; k += 512) {
        float4 x[R][4];
        for (uint r = 0; r < R; r++) {
            const device bfloat4 *p = (const device bfloat4 *)(a + source[r] + k);
            for (uint q = 0; q < 4; q++)
                x[r][q] = float4(p[q]);
        }
        for (uint j = 0; j < ROWS; j++) {
            float4 v[4];
            float scale;
            if (FP8) {
                uint4 packed = *(const device uint4 *)(weights + j * K + k);
                scale = dequantize_scale<float, 32>(group[j * (K / 32) + k / 32]);
                for (uint q = 0; q < 4; q++)
                    v[q] = float4(Dequantize<8>{}(uchar(packed[q])),
                                  Dequantize<8>{}(uchar(packed[q] >> 8)),
                                  Dequantize<8>{}(uchar(packed[q] >> 16)),
                                  Dequantize<8>{}(uchar(packed[q] >> 24)));
            } else {
                uint2 packed = *(const device uint2 *)(weights + j * (K / 2) + k / 2);
                scale = dequantize_scale<float, 16>(group[j * (K / 16) + k / 16]);
                for (uint q = 0; q < 4; q++) {
                    uint word = q < 2 ? packed.x : packed.y, shift = (q % 2) * 16;
                    v[q] = float4(Dequantize<4>{}(uchar(word >> shift)),
                                  Dequantize<4>{}(uchar(word >> (shift + 4))),
                                  Dequantize<4>{}(uchar(word >> (shift + 8))),
                                  Dequantize<4>{}(uchar(word >> (shift + 12))));
                }
            }
            for (uint r = 0; r < R; r++)
                total[j][r] += scale * (dot(x[r][0], v[0]) + dot(x[r][1], v[1]) +
                                        dot(x[r][2], v[2]) + dot(x[r][3], v[3]));
        }
    }
    for (uint r = 0; r < R; r++) {
        uint dest = slots[r];
        for (uint j = 0; j < ROWS; j += 2) {
            float even = simd_sum(total[j][r]) * global, odd = simd_sum(total[j + 1][r]) * global;
            if (lane != 0)
                continue;
            if (ACT) {
                float g = float(bfloat(even)), u = float(bfloat(odd));
                out[(dest * N + row + j) / 2] =
                    bfloat((4.f * tanh(g * .25f) / (1.f + exp(-g))) * (25.f * tanh(u / 25.f)));
            } else {
                out[dest * N + row + j] = bfloat(even);
                out[dest * N + row + j + 1] = bfloat(odd);
            }
        }
    }
}
