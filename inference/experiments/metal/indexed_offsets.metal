// Compute row indirection once per lane, before the inner product walks across the feature
// dimension.

constexpr uint VEC = 4, TGS = WM * WN * 32, PER = (BM * BK / VEC + TGS - 1) / TGS;
uint thread_id = sg * 32 + lane;
uint sources[PER];
for (uint j = 0; j < PER; j++) {
    uint it = j * TGS + thread_id, tile_row = row + it / (BK / VEC);
    sources[j] = tile_row < stop ? (ACT ? hot[tile_row] / 8 : tile_row) : 0;
}
