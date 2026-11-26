constant uint hidden_width = 2304;
constant uint threads_per_token = 256;
constant uint channels_per_thread = hidden_width / threads_per_token;
constant uint simd_width = 32;
constant uint groups_per_token = threads_per_token / simd_width;
constant uint messages_per_token = 48;

// A scalar reduces one row; a float2 reduces two rows independently.
template <typename Sum>
inline Sum inverse_rms(Sum local_squares, threadgroup Sum *partials, uint thread_id) {
    uint lane = thread_id % simd_width;
    uint group = thread_id / simd_width;
    Sum group_sum = simd_sum(local_squares);
    if (lane == 0) {
        partials[group] = group_sum;
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);

    // The first SIMD group combines the eight partial sums, then broadcasts the scale.
    if (group == 0) {
        Sum total = simd_sum(lane < groups_per_token ? partials[lane] : Sum(0));
        if (lane == 0) {
            partials[0] = rsqrt(total / float(hidden_width) + 1e-6f);
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    return partials[0];
}
