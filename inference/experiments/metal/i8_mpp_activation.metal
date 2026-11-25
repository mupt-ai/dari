// Use Metal Performance Primitives for the matrix product and fuse the paired gate/up
// activation on the resulting tile.

uint tile = threadgroup_position_in_grid.y, expert = experts[tile];
if (expert >= E)
    return;
uint row = starts[expert] + (tile - base[expert]) * BM, stop = starts[expert + 1];
uint col = threadgroup_position_in_grid.x * BN, group_id = simdgroup_index_in_threadgroup,
     thread_id = thread_position_in_threadgroup.x;
using namespace mpp;
using namespace mpp::tensor_ops;
constexpr auto desc = matmul2d_descriptor(BM, BN, K, false, true, false);
matmul2d<desc, execution_simdgroups<4>> op;
auto lhs =
    tensor(const_cast<device int8_t *>(a) + row * K, extents<int, K, BM>{}, array<int, 2>{1, K});
auto rhs = tensor(const_cast<device int8_t *>(b) + (expert * N + col) * K, extents<int, K, BN>{},
                  array<int, 2>{1, K});
threadgroup int tmp[BM][BN];
auto dst = tensor(&tmp[0][0], extents<int, BN, BM>{}, array<int, 2>{1, BN});
op.run(lhs, rhs, dst);
threadgroup_barrier(mem_flags::mem_threadgroup);
for (uint it = thread_id; it < BM * BN / 2; it += 128) {
    uint tile_row = it / (BN / 2), tile_col = it % (BN / 2) * 2;
    if (row + tile_row < stop) {
        float g = float(bfloat(float(tmp[tile_row][tile_col]) * lscale[row + tile_row] *
                               rscale[expert * N + col + tile_col])),
              u = float(bfloat(float(tmp[tile_row][tile_col + 1]) * lscale[row + tile_row] *
                               rscale[expert * N + col + tile_col + 1]));
        y[((row + tile_row) * N + col + tile_col) / 2] =
            bfloat((4.f * tanh(g * .25f) / (1.f + exp(-g))) * (25.f * tanh(u / 25.f)));
    }
}
