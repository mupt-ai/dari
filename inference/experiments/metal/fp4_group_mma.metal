// Decode each packed weight through its scale lookup and stage it with the input tile before
// the SIMD-group matrix products.

uint tile = threadgroup_position_in_grid.y, col = threadgroup_position_in_grid.x * BN;
uint thread_id = thread_position_in_threadgroup.x, group_id = thread_id / 32;
uint e = experts[tile];
if (e >= 128)
    return;
uint row = offsets[e] + (tile - base[e]) * BM;
uint stop = offsets[e + 1];
threadgroup half a[BM][BK + 8], b[BN][BK + 8];
threadgroup float out[BM][BN];
simdgroup_float8x8 accum[BM / 16][BN / 16];
for (uint i = 0; i < BM / 16; i++)
    for (uint j = 0; j < BN / 16; j++)
        accum[i][j] = make_filled_simdgroup_matrix<float, 8, 8>(0);

for (uint kk = 0; kk < K; kk += BK) {
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (uint it = thread_id; it < BM * BK / 4; it += 128) {
        uint tile_row = it / (BK / 4), tile_col = it % (BK / 4) * 4;
        half4 av(0);
        if (row + tile_row < stop)
            av = half4(((const device bfloat4 *)x)[((row + tile_row) * K + kk + tile_col) / 4]);
        *((threadgroup half4 *)&a[tile_row][tile_col]) = av;
    }
    for (uint it = thread_id; it < BN * BK / 8; it += 128) {
        uint tile_row = it / (BK / 8), tile_col = it % (BK / 8) * 8;
        uint off = ((((e * (N / BN) + (col / BN)) * (K / BK) + kk / BK) * BN + tile_row) * BK +
                    tile_col),
             word = w[off / 8];
        const device half *table = lut + (e * 256 + sc[off / 16]) * 8;
        for (uint j = 0; j < 8; j++) {
            uint n = (word >> (4 * j)) & 15;
            half decoded = table[n & 7];
            b[tile_row][tile_col + j] = (n & 8) ? -decoded : decoded;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (uint k = 0; k < BK; k += 8) {
        simdgroup_half8x8 av[BM / 16], bv[BN / 16];
        for (uint i = 0; i < BM / 16; i++)
            simdgroup_load(av[i], &a[(group_id / 2) * (BM / 2) + i * 8][k], BK + 8);
        for (uint j = 0; j < BN / 16; j++)
            simdgroup_load(bv[j], &b[(group_id % 2) * (BN / 2) + j * 8][k], BK + 8, ulong2(0),
                           true);
        for (uint i = 0; i < BM / 16; i++)
            for (uint j = 0; j < BN / 16; j++)
                simdgroup_multiply_accumulate(accum[i][j], av[i], bv[j], accum[i][j]);
    }
}
for (uint i = 0; i < BM / 16; i++)
    for (uint j = 0; j < BN / 16; j++)
        simdgroup_store(accum[i][j],
                        &out[(group_id / 2) * (BM / 2) + i * 8][(group_id % 2) * (BN / 2) + j * 8],
                        BN);
threadgroup_barrier(mem_flags::mem_threadgroup);
for (uint it = thread_id; it < BM * BN; it += 128)
    if (row + it / BN < stop)
        y[(row + it / BN) * N + col + it % BN] = bfloat(out[it / BN][it % BN]);
