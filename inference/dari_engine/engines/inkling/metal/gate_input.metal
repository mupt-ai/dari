// Normalize the hidden state and message separately. Each lane visits every 256th channel; the
// first SIMD group combines the eight partial sums.

int row = threadgroup_position_in_grid.y, thread_id = thread_position_in_threadgroup.x;
float hidden_squares = 0, message_squares = 0;
for (int channel = thread_id; channel < 2304; channel += 256) {
    float hidden_value = v[row * v_strides[1] + channel],
          message_value = m[row * m_strides[1] + channel];
    hidden_squares = fma(hidden_value, hidden_value, hidden_squares);
    message_squares = fma(message_value, message_value, message_squares);
}
hidden_squares = simd_sum(hidden_squares);
message_squares = simd_sum(message_squares);
threadgroup float2 parts[8];
if (thread_id % 32 == 0)
    parts[thread_id / 32] = float2(hidden_squares, message_squares);
threadgroup_barrier(mem_flags::mem_threadgroup);
if (thread_id < 32) {
    float2 total = thread_id < 8 ? parts[thread_id] : float2(0);
    total = simd_sum(total);
    if (thread_id == 0)
        parts[0] = rsqrt(total / 2304.f + 1e-6f);
}
threadgroup_barrier(mem_flags::mem_threadgroup);
float2 scale = parts[0];
for (int channel = thread_id; channel < 2304; channel += 256) {
    out[row * 4608 + channel] = T(float(v[row * v_strides[1] + channel]) * scale.x);
    out[row * 4608 + 2304 + channel] = T(float(m[row * m_strides[1] + channel]) * scale.y);
}
