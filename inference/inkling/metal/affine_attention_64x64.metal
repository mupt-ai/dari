// Reuse the pinned MLX affine decoder; choose a wider output tile for large prompt projections.
constexpr int BM = 64, BN = 64, BK = 32;
threadgroup bfloat A[BM * (BK + 8)], B[BN * (BK + 8)];
qmm_t_impl<bfloat, 64, 4, ALIGNED, bfloat, BM, BK, BN>(w, s, b, x, y, A, B, K, N, M, K,
                                                       threadgroup_position_in_grid,
                                                       thread_index_in_threadgroup,
                                                       simdgroup_index_in_threadgroup,
                                                       thread_index_in_simdgroup);
