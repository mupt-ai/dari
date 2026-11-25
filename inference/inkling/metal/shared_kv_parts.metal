// Three query heads share a KV head. Stream over a block of keys, keeping each head’s running
// maximum, weight sum, and weighted values instead of its attention matrix.

uint lane = thread_index_in_simdgroup, group_id = simdgroup_index_in_threadgroup,
     kv_head = threadgroup_position_in_grid.y, partition = threadgroup_position_in_grid.x;
uint start = partition * BLOCK, length = k_shape[2];
float4 query[3], weighted_values[3];
float max_score[3], weight_sum[3];
for (uint query_index = 0; query_index < 3; query_index++) {
    query[query_index] =
        float4(((const device bfloat4 *)q)[(kv_head * 3 + query_index) * 32 + lane]) *
        .08838834764831845f;
    weighted_values[query_index] = 0;
    max_score[query_index] = -INFINITY;
    weight_sum[query_index] = 0;
}
for (uint key_index = start + group_id; key_index < min(length, start + BLOCK); key_index += 8) {
    float4 key = float4(
        ((const device bfloat4 *)(k + kv_head * k_strides[1] + key_index * k_strides[2]))[lane]);
    float4 val = float4(
        ((const device bfloat4 *)(v + kv_head * v_strides[1] + key_index * v_strides[2]))[lane]);
    for (uint query_index = 0; query_index < 3; query_index++) {
        uint lag = length - 1 - key_index;
        float score =
            simd_sum(dot(query[query_index], key)) +
            (lag < 1024 ? float(rel[(kv_head * 3 + query_index) * rel_strides[1] + lag]) : 0.f);
        float new_max = max(max_score[query_index], score),
              previous_scale = exp(max_score[query_index] - new_max), weight = exp(score - new_max);
        weighted_values[query_index] =
            fma(val, weight, weighted_values[query_index] * previous_scale);
        weight_sum[query_index] = fma(weight_sum[query_index], previous_scale, weight);
        max_score[query_index] = new_max;
    }
}
threadgroup float4 subtotal[8][32];
threadgroup float2 norm[8];
for (uint query_index = 0; query_index < 3; query_index++) {
    threadgroup_barrier(mem_flags::mem_threadgroup);
    subtotal[group_id][lane] = weighted_values[query_index];
    if (lane == 0)
        norm[group_id] = float2(max_score[query_index], weight_sum[query_index]);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (group_id == 0) {
        float new_max = -INFINITY;
        for (uint i = 0; i < 8; i++)
            new_max = max(new_max, norm[i].x);
        float4 merged_values = 0;
        float denominator = 0;
        for (uint i = 0; i < 8; i++) {
            float weight = exp(norm[i].x - new_max);
            merged_values += weight * subtotal[i][lane];
            denominator += weight * norm[i].y;
        }
        uint row = partition * 24 + kv_head * 3 + query_index;
        ((device float4 *)part)[row * 32 + lane] = merged_values;
        if (lane == 0)
            ((device float2 *)stats)[row] = float2(new_max, denominator);
    }
}
