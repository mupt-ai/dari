// Adjacent matrix columns give the forget and incoming logits for one channel. Blend the hidden
// state and message while both logits are still in registers.

uint row = threadgroup_position_in_grid.y * BM, col = threadgroup_position_in_grid.x * BN;
uint group_id = simdgroup_index_in_threadgroup, lane = thread_index_in_simdgroup;
constexpr int BK = 32;
using MMA = mlx::steel::BlockMMA<bfloat, float, BM, BN, BK, WM, WN, false, true, BK + 8, BK + 8>;
threadgroup bfloat A[BM * (BK + 8)], B[BN * (BK + 8)];
MMA mma(group_id, lane);
mlx::steel::BlockLoader<bfloat, BM, BK, BK + 8, 1, WM * WN * 32> al(z + row * 64, 64, A, group_id,
                                                                    lane);
mlx::steel::BlockLoader<bfloat, BN, BK, BK + 8, 1, WM * WN * 32> bl(w + col * 64, 64, B, group_id,
                                                                    lane);
for (short k = 0; k < 64; k += BK) {
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (row + BM <= L)
        al.load_unsafe();
    else
        al.load_safe(short2(BK, L - row));
    bl.load_unsafe();
    threadgroup_barrier(mem_flags::mem_threadgroup);
    mma.mma(A, B);
    al.next();
    bl.next();
}
for (short i = 0; i < MMA::TM; i++)
    for (short j = 0; j < MMA::TN; j++) {
        uint token = row + mma.sm + i * MMA::TM_stride,
             channel = (col + mma.sn + j * MMA::TN_stride) / 2;
        if (token < L) {
            auto pair = mma.Ctile.frag_at(i, j);
            uint score_index = (token * 48 + slot) * 2;
            float message = fma(b[token * b_strides[1] + channel], s[score_index + 1],
                                a[token * a_strides[1] + channel] * s[score_index]);
            y[token * 2304 + channel] =
                (1.f - tanh(pair[0])) * v[token * v_strides[1] + channel] + tanh(pair[1]) * message;
        }
    }
