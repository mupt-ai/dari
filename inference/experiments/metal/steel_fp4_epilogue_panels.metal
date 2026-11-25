// Use prepacked weight panels in tile order, then apply the gate immediately after the dot
// products.

uint tile_id = threadgroup_position_in_grid.y * (N / BN) + threadgroup_position_in_grid.x,
     rb = tile_id / (ORDER * (N / BN));
uint t = rb * ORDER + tile_id % ORDER;
if (t >= NT)
    return;
uint e = experts[t];
if (e >= E)
    return;
uint row = starts[e] + (t - base[e]) * BM, stop = starts[e + 1],
     col = ((tile_id / ORDER) % (N / BN)) * BN;
uint group_id = simdgroup_index_in_threadgroup, lane = thread_index_in_simdgroup;
using MMA = mlx::steel::BlockMMA<bfloat, bfloat, BM, BN, BK, WM, WN, false, true, BK + 8, BK + 8>;
threadgroup bfloat A[BM * (BK + 8)], B[BN * (BK + 8)];
MMA mma(group_id, lane);
mlx::steel::BlockLoader<bfloat, BM, BK, BK + 8, 1, WM * WN * 32> al(a + row * K, K, A, group_id,
                                                                    lane);
for (uint k = 0; k < K; k += BK) {
    uint off = ((e * N + col) * K + k * BN);
    QuantizedBlockLoader<bfloat, BN, BK, BK + 8, 1, WM * WN * 32, 16, 4, true> bl(
        (const device uchar *)b + off / 2, sc + off / 16, BK, B, group_id, lane, gs + e);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    al.load_unsafe();
    bl.load_unsafe();
    threadgroup_barrier(mem_flags::mem_threadgroup);
    mma.mma(A, B);
    al.next();
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
