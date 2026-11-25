// Accumulate an expert projection in tiles. Contraction stores the result directly; expansion pairs
// neighboring gate and up values before storing the activation.

/* SETUP */
using MMA = mlx::steel::BlockMMA<bfloat, bfloat, BM, BN, BK, WM, WN, false, true, BK + 8, BK + 8>;
/* SCRATCH */
threadgroup bfloat A[BM * (BK + 8)], B[BN * (BK + 8)];
/* END SCRATCH */
MMA mma(sg, lane);
/* INPUT_LOADER */
mlx::steel::BlockLoader<bfloat, BM, BK, BK + 8, 1, WM * WN * 32>
    al(a + /* INPUT_OFFSET */ row * K /* END INPUT_OFFSET */, K, A, sg, lane);
/* END INPUT_LOADER */
/* WEIGHT_LOADER */
QuantizedBlockLoader<bfloat, BN, BK, BK + 8, 1, WM * WN * 32, 16, 4, true>
    bl((const device uchar *)b + (e * N + col) * (K / 2), sc + (e * N + col) * (K / 16), K, B, sg,
       lane, gs + e);
/* END WEIGHT_LOADER */
/* ROUTE_OFFSETS */
/* REDUCTION_LOOP */
// Reuse the two threadgroup panels. Finish reading the previous panels before loading; wait for
// both new panels before matrix multiplication.

for (uint k = 0; k < K; k += BK) {
    threadgroup_barrier(mem_flags::mem_threadgroup);
    /* INPUT_LOAD */
    al.load_unsafe();
    /* END INPUT_LOAD */

    /* WEIGHT_LOAD */
    bl.load_unsafe();
    /* END WEIGHT_LOAD */
    threadgroup_barrier(mem_flags::mem_threadgroup);
    mma.mma(A, B);
    /* NEXT_INPUT */
    al.next();
    /* END NEXT_INPUT */

    /* NEXT_WEIGHT */
    bl.next();
    /* END NEXT_WEIGHT */
}
/* END REDUCTION_LOOP */
if constexpr (!ACT) {
    /* STORE_TILE */
    mma.store_result_safe(y + row * N + col, N, short2(BN, min(uint(BM), stop - row)));
    /* END STORE_TILE */
    return;
}
for (short i = 0; i < MMA::TM; i++)
    for (short j = 0; j < MMA::TN; j++) {
        uint rr = row + mma.sm + i * MMA::TM_stride, cc = col + mma.sn + j * MMA::TN_stride;
        if (rr < stop) {
            auto frag = mma.Ctile.frag_at(i, j);
            float g = float(bfloat(frag[0])), u = float(bfloat(frag[1]));
            y[(rr * N + cc) / 2] =
                bfloat((4.f * tanh(g * .25f) / (1.f + exp(-g))) * (25.f * tanh(u / 25.f)));
        }
    }
