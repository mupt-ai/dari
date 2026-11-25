// Each (expert, block) owns a contiguous output span. Count earlier matching lanes and SIMD groups
// to preserve the original route order.

uint thread_id = thread_position_in_threadgroup.x, block = threadgroup_position_in_grid.x,
     expert = threadgroup_position_in_grid.y;
uint bucket = expert * B + block;
if (counts[bucket] == 0)
    return;
uint route = block * 256 + thread_id, matches = route < N && ids[route] == expert;
uint lane_rank = simd_prefix_exclusive_sum(matches);
threadgroup uint group_counts[8];
if (thread_id % 32 == 31)
    group_counts[thread_id / 32] = lane_rank + matches;
threadgroup_barrier(mem_flags::mem_threadgroup);
if (matches) {
    uint destination = ends[bucket] - counts[bucket] + lane_rank;
    for (uint j = 0; j < thread_id / 32; j++)
        destination += group_counts[j];
    order[destination] = route;
    inverse[route] = destination;
    sorted_ids[destination] = expert;
}
