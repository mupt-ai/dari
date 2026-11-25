// Compare the cost of reading packed panels against the ordinary expert projection while
// retaining the fused activation.

uint tile = threadgroup_position_in_grid.y, expert = experts[tile];
if (expert >= E)
    return;
uint row = starts[expert] + (tile - base[expert]) * BM, stop = starts[expert + 1];
uint col = threadgroup_position_in_grid.x * BN, group_id = simdgroup_index_in_threadgroup,
     thread_id = thread_position_in_threadgroup.x;
simdgroup_float8x8 acc[BM / 16][BN / 16];
for (uint i = 0; i < BM / 16; i++)
    for (uint j = 0; j < BN / 16; j++)
        acc[i][j] = make_filled_simdgroup_matrix<float, 8, 8>(0);
for (uint k = 0; k < K; k += 8) {
    simdgroup_half8x8 av[BM / 16], bv[BN / 16];
    for (uint i = 0; i < BM / 16; i++)
        simdgroup_load(av[i], a + (row + (group_id / 2) * (BM / 2) + i * 8) * K + k, K);
    for (uint j = 0; j < BN / 16; j++)
        simdgroup_load(bv[j],
                       b + (((expert * (N / BN) + col / BN) * (K / 8) + k / 8) * BN +
                            ((group_id % 2) * (BN / 2) + j * 8)) *
                               8,
                       8);
    for (uint i = 0; i < BM / 16; i++)
        for (uint j = 0; j < BN / 16; j++)
            simdgroup_multiply_accumulate(acc[i][j], av[i], bv[j], acc[i][j]);
}
threadgroup float tmp[BM][BN];
for (uint i = 0; i < BM / 16; i++)
    for (uint j = 0; j < BN / 16; j++)
        simdgroup_store(acc[i][j],
                        &tmp[(group_id / 2) * (BM / 2) + i * 8][(group_id % 2) * (BN / 2) + j * 8],
                        BN);
threadgroup_barrier(mem_flags::mem_threadgroup);
for (uint it = thread_id; it < BM * BN / 2; it += 128) {
    uint tile_row = it / (BN / 2), tile_col = it % (BN / 2) * 2;
    if (row + tile_row < stop) {
        float g = float(bfloat(tmp[tile_row][tile_col])),
              u = float(bfloat(tmp[tile_row][tile_col + 1]));
        y[((row + tile_row) * N + col + tile_col) / 2] =
            bfloat((4.f * tanh(g * .25f) / (1.f + exp(-g))) * (25.f * tanh(u / 25.f)));
    }
}
