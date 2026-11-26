// Precompute each lane’s source addresses once; the same route rows are reused for every reduction
// tile.

constexpr uint THREADS = WM * WN * 32;
constexpr uint VECTORS = BM * (BK / 8), STRIPES = (VECTORS + THREADS - 1) / THREADS;
uint route_offset[STRIPES];
uint tid = sg * 32 + lane;
if constexpr (ACT) {
    for (uint stripe = 0; stripe < STRIPES; stripe++) {
        uint j = tid + stripe * THREADS, rr = j / (BK / 8), cc = 8 * (j % (BK / 8));
        route_offset[stripe] = (j < VECTORS && row + rr < stop ? hot[row + rr] / 8 : 0) * K + cc;
    }
}
