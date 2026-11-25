// One SIMD group accumulates one selected expert output row, decoding eight packed weights per
// word.

uint row = thread_position_in_grid.x / 32;
uint lane = thread_position_in_grid.x % 32;
uint r = row % N, e = ids[row / N];
constexpr float table[8] = {0, .5, 1, 1.5, 2, 3, 4, 6};
float acc = 0;
for (uint j = lane; j < K / 8; j += 32) {
    uint word = w[(e * N + r) * (K / 8) + j];
    float scale = lut[sc[(e * N + r) * (K / 16) + j / 2]];
    float dot = 0;
    for (uint i = 0; i < 8; i++) {
        uint c = (word >> (4 * i)) & 15;
        dot = fma(float(x[j * 8 + i]), (c & 8) ? -table[c & 7] : table[c & 7], dot);
    }
    acc = fma(dot, scale, acc);
}
float sum = simd_sum(acc);
if (lane == 0)
    y[row] = bfloat(sum * (gs[e] / 2688.0f));
