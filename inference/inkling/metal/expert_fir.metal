// Stage eight new token rows and three history rows as a single tile so adjacent four-tap filters
// can share their inputs.

uint lane = thread_position_in_threadgroup.x % 32, tile_row = thread_position_in_threadgroup.x / 32;
uint col = threadgroup_position_in_grid.x * 32 + lane;
int first_token = int(threadgroup_position_in_grid.y) * 8;
threadgroup bfloat4 mixed[11][32];
for (uint j = tile_row; j < 11; j += 8) {
    int row = first_token + int(j) - 3;
    bfloat4 v(0);
    if (row < 0) {
        v = ((const device bfloat4 *)prior)[(row + 3) * DV + col];
    } else if (row < L) {
        float4 acc(0);
        for (uint i = 0; i < 8; i++) {
            uint route_index = row * 8 + i;
            acc += float4(((const device bfloat4 *)expert)[inv[route_index] * DV + col]) *
                   coeff[route_index];
        }
        v = bfloat4(acc);
    }
    mixed[j][lane] = v;
}
threadgroup_barrier(mem_flags::mem_threadgroup);
int row = first_token + int(tile_row);
if (row >= L)
    return;
float4 acc(0);
for (uint j = 0; j < 4; j++) {
    float4 weight;
    for (uint c = 0; c < 4; c++)
        weight[c] = float(w[(col * 4 + c) * 4 + j]);
    acc = fma(float4(mixed[tile_row + j][lane]), weight, acc);
}
bfloat4 v = mixed[tile_row + 3][lane];
bfloat4 y = bfloat4((float4(bfloat4(acc)) + float4(v)) * .4472135955f);
((device bfloat4 *)out)[row * DV + col] =
    bfloat4(float4(y) + ((const device float4 *)res)[row * DV + col]);
if (row >= L - 3)
    ((device bfloat4 *)history)[(row - L + 3) * DV + col] = v;
