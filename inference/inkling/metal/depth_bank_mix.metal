// One threadgroup mixes the residual bank for a single token and query. Compute dot products first,
// share the softmax weights, then blend the same rows.

uint row = threadgroup_position_in_grid.y, q = threadgroup_position_in_grid.z;
uint thread_id = thread_position_in_threadgroup.x, lane = thread_id % 32, group_id = thread_id / 32;
float score[N] = {};
for (uint channel = thread_id; channel < D; channel += 256) {
    float query_value = queries[q * D + channel];

    /* EACH_INPUT */
    score[INPUT_INDEX] = fma(INPUT_BUFFER[row * D + channel], query_value, score[INPUT_INDEX]);
    /* END_INPUT */
}
threadgroup float parts[N][8];
threadgroup float scale[N];
for (int i = 0; i < N; i++) {
    float s = simd_sum(score[i]);
    if (lane == 0)
        parts[i][group_id] = s;
}
threadgroup_barrier(mem_flags::mem_threadgroup);
if (thread_id == 0) {
    float hi = -INFINITY;
    for (int i = 0; i < N; i++) {
        float s = 0;
        for (int j = 0; j < 8; j++)
            s += parts[i][j];
        scale[i] = s / 48.0f;
        hi = max(hi, scale[i]);
    }
    float total = 0;
    for (int i = 0; i < N; i++) {
        scale[i] = exp(scale[i] - hi);
        total += scale[i];
    }
    for (int i = 0; i < N; i++)
        scale[i] /= total;
}
threadgroup_barrier(mem_flags::mem_threadgroup);
for (uint channel = thread_id; channel < D; channel += 256) {
    float acc = 0;

    /* EACH_INPUT */
    acc = fma(INPUT_BUFFER[row * D + channel], scale[INPUT_INDEX], acc);
    /* END_INPUT */

    out[(row * Q + q) * D + channel] = acc;
}
