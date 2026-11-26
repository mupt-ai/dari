// Each selected expert's weight rows are read once however many of the (at most L) tokens chose
// it. Grid rows walk the selected experts only; each simdgroup reduces ROWS output channels.

uint expert = experts[threadgroup_position_in_grid.y], routes = counts[expert];
if (routes == 0)
    return;
uint lane = thread_index_in_simdgroup,
     row = (threadgroup_position_in_grid.x * SIMDGROUPS + simdgroup_index_in_threadgroup) * ROWS;
const device uchar *weights = (const device uchar *)w + (expert * N + row) * (FP8 ? K : K / 2);
const device uchar *group = sc + (expert * N + row) * (K / (FP8 ? 32 : 16));
const device uint *routed = slots + expert * L;
float global = FP8 ? 1.f : gs[expert] / 2688.f;
#define ROUTES(R)                                                                                \
    case R:                                                                                      \
        if constexpr (R <= L)                                                                    \
            routed_rows<R, ROWS, K, N, ACT, FP8>(a, weights, group, routed, row, lane, global, out);  \
        break;
switch (routes) {
    ROUTES(1)
    ROUTES(2)
    ROUTES(3)
    ROUTES(4)
    ROUTES(5)
    ROUTES(6)
    ROUTES(7)
    ROUTES(8)
}
