float part = simd_sum(square_sum);
if (!lane)
    partials[group_id] = part;
threadgroup_barrier(mem_flags::mem_threadgroup);
if (!group_id) {
    float h = simd_sum(lane < 8 ? partials[lane] : 0.f);
    if (!lane)
        scale = rsqrt(h / 2304.f + 1e-6f);
}
threadgroup_barrier(mem_flags::mem_threadgroup);
