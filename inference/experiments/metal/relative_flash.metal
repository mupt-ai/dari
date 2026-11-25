// Accumulate attention block by block: update the running maximum and rescale earlier weights
// before incorporating the next block.

uint thread_id = thread_position_in_threadgroup.x, group_id = thread_id / 32, lane = thread_id % 32;
int baseq = int(threadgroup_position_in_grid.x) * 16, h = threadgroup_position_in_grid.y,
    kv = h / 3;
int len = q_shape[1], keys = k_shape[2], past = keys - len;
threadgroup half Q[16][128], KV[32][128], P[16][32];
threadgroup float S[16][32], PV[16][128], hi[16], den[16], fac[16];
for (uint i = thread_id; i < 16 * 128; i += 128) {
    int r = i / 128, c = i % 128;
    Q[r][c] =
        baseq + r < len ? half(q[(baseq + r) * q_strides[1] + h * q_strides[2] + c]) : half(0);
}
if (thread_id < 16) {
    hi[thread_id] =
        baseq + int(thread_id) < len ? float(sinks[(baseq + thread_id) * sinks_strides[1] + h]) : 0;
    den[thread_id] = 1;
}
float accum[16] = {};
int start = LOCAL ? max(0, (past + baseq - 1023) / 32 * 32) : 0, end = min(keys, past + baseq + 16);
for (int b = start; b < end; b += 32) {
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (uint i = thread_id; i < 32 * 128; i += 128) {
        int r = i / 128, c = i % 128;
        KV[r][c] = b + r < keys ? half(k[kv * k_strides[1] + (b + r) * k_strides[2] + c]) : half(0);
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    simdgroup_float8x8 scores[2];
    for (int j = 0; j < 2; j++)
        scores[j] = make_filled_simdgroup_matrix<float, 8, 8>(0);
    for (int d = 0; d < 128; d += 8) {
        simdgroup_half8x8 a, wt;
        simdgroup_load(a, &Q[(group_id / 2) * 8][d], 128);
        for (int j = 0; j < 2; j++) {
            simdgroup_load(wt, &KV[(group_id % 2) * 16 + j * 8][d], 128, ulong2(0), true);
            simdgroup_multiply_accumulate(scores[j], a, wt, scores[j]);
        }
    }
    for (int j = 0; j < 2; j++)
        simdgroup_store(scores[j], &S[(group_id / 2) * 8][(group_id % 2) * 16 + j * 8], 32);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (int r = group_id; r < 16; r += 4) {
        int distance = past + baseq + r - b - int(lane);
        bool valid =
            baseq + r < len && b + int(lane) < keys && distance >= 0 && (!LOCAL || distance < 1024);
        float s = -INFINITY;
        if (valid) {
            float bias =
                distance < 1024
                    ? float(rel[h * rel_strides[1] + (baseq + r) * rel_strides[2] + distance])
                    : 0;
            s = S[r][lane] * .08838834764831845f + bias;
        }
        float high = max(hi[r], simd_max(s));
        float factor = exp(hi[r] - high);
        float p = exp(s - high);
        float sum = simd_sum(p);
        P[r][lane] = half(p);
        if (lane == 0) {
            den[r] = den[r] * factor + sum;
            fac[r] = factor;
            hi[r] = high;
        }
    }
    for (uint i = thread_id; i < 32 * 128; i += 128) {
        int r = i / 128, c = i % 128;
        KV[r][c] = b + r < keys ? half(v[kv * v_strides[1] + (b + r) * v_strides[2] + c]) : half(0);
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    simdgroup_float8x8 o[8];
    for (int j = 0; j < 8; j++)
        o[j] = make_filled_simdgroup_matrix<float, 8, 8>(0);
    for (int d = 0; d < 32; d += 8) {
        simdgroup_half8x8 a, wt;
        simdgroup_load(a, &P[(group_id / 2) * 8][d], 32);
        for (int j = 0; j < 8; j++) {
            simdgroup_load(wt, &KV[d][(group_id % 2) * 64 + j * 8], 128);
            simdgroup_multiply_accumulate(o[j], a, wt, o[j]);
        }
    }
    for (int j = 0; j < 8; j++)
        simdgroup_store(o[j], &PV[(group_id / 2) * 8][(group_id % 2) * 64 + j * 8], 128);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (int r = 0; r < 16; r++)
        accum[r] = fma(accum[r], fac[r], PV[r][thread_id]);
}
for (int r = 0; r < 16; r++)
    if (baseq + r < len)
        out[((baseq + r) * 24 + h) * 128 + thread_id] = bfloat(accum[r] / den[r]);
