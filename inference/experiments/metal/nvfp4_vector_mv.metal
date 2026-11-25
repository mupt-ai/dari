// Vectorized packed matvec: share the selected expert and input row across lanes, then reduce
// partial dot products.

uint group = thread_position_in_grid.x / 32, lane = thread_position_in_grid.x % 32;
uint row = (group * ROWS) % N, e = ids[group * ROWS / N];
float acc[ROWS] = {};
for (uint block = lane; block < K / 16; block += 32) {
    float vals[16];
    for (uint j = 0; j < 16; j++)
        vals[j] = float(x[block * 16 + j]);
    for (uint r = 0; r < ROWS; r++) {
        uint src = (e * N + row + r) * (K / 16) + block;
        uint2 words = ((const device uint2 *)w)[src];
        float part = 0;
        for (uint j = 0; j < 16; j++) {
            uint nib = (words[j / 8] >> (4 * (j % 8))) & 15;
            // Half representation of E2M1 divided by 16384.
            half small = as_type<half>(ushort(((nib & 7) << 9) | ((nib & 8) << 12)));
            part = fma(vals[j], float(small), part);
        }
        acc[r] = fma(part, lut[sc[src]], acc[r]);
    }
}
for (uint r = 0; r < ROWS; r++) {
    float total = simd_sum(acc[r]);
    if (lane == 0)
        y[group * ROWS + r] = bfloat(total * (gs[e] * (16384.0f / 2688.0f)));
}
