// A group handles up to eight routes for one expert. Pad missing input rows with zero but never
// write them back.

uint expert = threadgroup_position_in_grid.z, row = threadgroup_position_in_grid.y * 8,
     route_count = counts[expert];
if (row >= route_count)
    return;
uint col = threadgroup_position_in_grid.x * 32, lane = thread_index_in_simdgroup,
     group_id = simdgroup_index_in_threadgroup, thread_id = thread_position_in_threadgroup.x;
using MMA = mlx::steel::BlockMMA<bfloat, bfloat, 8, 32, 32, 1, 2, false, true, 40, 40>;
threadgroup bfloat A[8 * 40], B[32 * 40];
MMA mma(group_id, lane);
QuantizedBlockLoader<bfloat, 32, 32, 40, 1, 64, (FP8 ? 32 : 16), (FP8 ? 8 : 4), !FP8>
    bl((const device uchar *)w + (expert * N + col) * (K / (FP8 ? 1 : 2)),
       sc + (expert * N + col) * (K / (FP8 ? 32 : 16)), K, B, group_id, lane,
       FP8 ? nullptr : gs + expert);
uint r = row + thread_id / 8, off = thread_id % 8 * 4,
     slot = r < route_count ? slots[expert * L + r] : 0;
for (uint k = 0; k < K; k += 32) {
    threadgroup_barrier(mem_flags::mem_threadgroup);
    *((threadgroup bfloat4 *)(A + (thread_id / 8) * 40 + off)) =
        r < route_count ? *((const device bfloat4 *)(a + (ACT ? slot / 8 : slot) * K + k + off))
                        : bfloat4(0);
    bl.load_unsafe();
    threadgroup_barrier(mem_flags::mem_threadgroup);
    mma.mma(A, B);
    bl.next();
}
for (short i = 0; i < MMA::TM; i++)
    for (short j = 0; j < MMA::TN; j++) {
        uint result_row = row + mma.sm + i * MMA::TM_stride,
             result_col = col + mma.sn + j * MMA::TN_stride;
        if (result_row < route_count) {
            uint dest = slots[expert * L + result_row];
            auto frag = mma.Ctile.frag_at(i, j);
            if constexpr (ACT) {
                float g = float(bfloat(frag[0])), u = float(bfloat(frag[1]));
                out[(dest * N + result_col) / 2] =
                    bfloat((4.f * tanh(g * .25f) / (1.f + exp(-g))) * (25.f * tanh(u / 25.f)));
            } else {
                out[dest * N + result_col] = bfloat(frag[0]);
                out[dest * N + result_col + 1] = bfloat(frag[1]);
            }
        }
    }
