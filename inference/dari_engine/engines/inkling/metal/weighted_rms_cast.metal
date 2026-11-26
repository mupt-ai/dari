// A 256-thread group owns one 2,304-channel token. Reduce nine squared values per thread, then
// apply the learned channel weight.

uint row = threadgroup_position_in_grid.y, thread_id = thread_position_in_threadgroup.x;
uint offset = row * x_strides[1];
float values[9], square_sum = 0;
for (uint j = 0; j < 9; j++) {
    uint channel = j * 256 + thread_id;
    values[j] = float(x[offset + channel * x_strides[2]]);
    square_sum = fma(values[j], values[j], square_sum);
}
square_sum = simd_sum(square_sum);
threadgroup float partials[8];
if (thread_id % 32 == 0)
    partials[thread_id / 32] = square_sum;
threadgroup_barrier(mem_flags::mem_threadgroup);
if (thread_id < 32) {
    float sum = thread_id < 8 ? partials[thread_id] : 0;
    sum = simd_sum(sum);
    if (thread_id == 0)
        partials[0] = rsqrt(sum / 2304.f + 1e-6f);
}
threadgroup_barrier(mem_flags::mem_threadgroup);
for (uint j = 0; j < 9; j++) {
    uint channel = j * 256 + thread_id;
    out[row * 2304 + channel] = T((values[j] * partials[0]) * float(w[channel]));
}
