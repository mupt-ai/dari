// The y grid is padded. Reject unused tiles before indexing the expert row bounds.
uint t = threadgroup_position_in_grid.y, e = experts[t];
if (e >= E)
    return;
uint row = starts[e] + (t - base[e]) * BM, stop = starts[e + 1],
     col = threadgroup_position_in_grid.x * BN;
for (uint j = 0; j < HOT; j++)
    if (hot[j] == e && row - starts[e] < CAP)
        return;
uint sg = simdgroup_index_in_threadgroup, lane = thread_index_in_simdgroup;
