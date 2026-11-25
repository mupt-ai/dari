// Load and dequantize a weight tile into shared memory, multiply it against the input tile,
// then apply the gate before storing.

uint tile = threadgroup_position_in_grid.y, expert = experts[tile];
if (expert >= E)
    return;
uint row = starts[expert] + (tile - base[expert]) * BM, stop = starts[expert + 1],
     col = threadgroup_position_in_grid.x * BN;
uint group_id = simdgroup_index_in_threadgroup, lane = thread_index_in_simdgroup;
using MMA = mlx::steel::BlockMMA<bfloat, bfloat, BM, BN, BK, WM, WN, false, true, BK + 8, BK + 8>;
threadgroup bfloat A[BM * (BK + 8)], B[BN * (BK + 8)];
MMA mma(group_id, lane);
mlx::steel::BlockLoader<bfloat, BM, BK, BK + 8, 1, WM * WN * 32> al(a + row * K, K, A, group_id,
                                                                    lane);
QuantizedBlockLoader<bfloat, BN, BK, BK + 8, 1, WM * WN * 32, 16, 4, true>
    bl((const device uchar *)b + (expert * N + col) * (K / 2), sc + (expert * N + col) * (K / 16),
       K, B, group_id, lane, gs + expert);
for (uint k = 0; k < K; k += BK) {
    threadgroup_barrier(mem_flags::mem_threadgroup);
    al.load_unsafe();
    bl.load_unsafe();
    threadgroup_barrier(mem_flags::mem_threadgroup);
    mma.mma(A, B);
    al.next();
    bl.next();
}
for (short i = 0; i < MMA::TM; i++)
    for (short j = 0; j < MMA::TN; j++) {
        uint tile_row = row + mma.sm + i * MMA::TM_stride,
             tile_col = col + mma.sn + j * MMA::TN_stride;
        if (tile_row < stop) {
            auto frag = mma.Ctile.frag_at(i, j);
            float g = float(bfloat(frag[0])), u = float(bfloat(frag[1]));
            y[(tile_row * N + tile_col) / 2] =
                bfloat((4.f * tanh(g * .25f) / (1.f + exp(-g))) * (25.f * tanh(u / 25.f)));
        }
    }
