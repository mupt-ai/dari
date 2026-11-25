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
constexpr auto desc = matmul2d_descriptor(BM, BN, BK, false, true, false,
                                          matmul2d_descriptor::mode::multiply_accumulate);
matmul2d<desc, execution_simdgroups<4>> op;
threadgroup half cache[BN][BK];
threadgroup float tmp[BM][BN];
auto dst = tensor(&tmp[0][0], extents<int, BN, BM>{}, array<int, 2>{1, BN});
auto lhs =
    tensor(const_cast<device half *>(a) + row * K, extents<int, BK, BM>{}, array<int, 2>{1, K});
auto rhs = tensor(&cache[0][0], extents<int, BK, BN>{}, array<int, 2>{1, BK});
auto accum = op.template get_destination_cooperative_tensor<decltype(lhs), decltype(rhs), float>();
#pragma unroll
for (ushort i = 0; i < accum.get_capacity(); i++)
    accum[i] = 0;
for (uint kk = 0; kk < K; kk += BK) {
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (uint it = thread_id; it < BN * BK / 8; it += 128) {
        uint tile_row = it / (BK / 8), tile_col = it % (BK / 8) * 8,
             off = ((expert * N + col + tile_row) * K + kk + tile_col);
        uint word = b[off / 8];
        const device half *table = lut + (expert * 256 + sc[off / 16]) * 8;
        for (uint j = 0; j < 8; j++) {
            uint code = (word >> (4 * j)) & 15;
            half h = table[code & 7];
            cache[tile_row][tile_col + j] = (code & 8) ? -h : h;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    auto part = tensor(const_cast<device half *>(a) + row * K + kk, extents<int, BK, BM>{},
                       array<int, 2>{1, K});
    op.run(part, rhs, accum);
}
accum.store(dst);
threadgroup_barrier(mem_flags::mem_threadgroup);
for (uint it = thread_id; it < BM * BN / 2; it += 128) {
    uint tile_row = it / (BN / 2), tile_col = it % (BN / 2) * 2;
    if (row + tile_row < stop) {
        float g = float(bfloat(tmp[tile_row][tile_col])),
              u = float(bfloat(tmp[tile_row][tile_col + 1]));
        y[((row + tile_row) * N + col + tile_col) / 2] =
            bfloat((4.f * tanh(g * .25f) / (1.f + exp(-g))) * (25.f * tanh(u / 25.f)));
    }
}
