uint expert = threadgroup_position_in_grid.y, token = thread_index_in_simdgroup, slot = 8;
if (token < L) {
    for (uint j = 0; j < 8; j++)
        if (ids[token * 8 + j] == expert)
            slot = j;
}
uint active = slot != 8;
uint rank = simd_prefix_exclusive_sum(active);
uint count = simd_sum(active);
if (active)
    slots[expert * L + rank] = token * 8 + slot;
if (token == 0)
    counts[expert] = count;
