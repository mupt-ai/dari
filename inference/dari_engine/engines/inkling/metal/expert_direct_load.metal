// Expansion gathers original token rows in route order. Contraction already has sorted input and
// needs only a bounded final tile.

if constexpr (ACT) {
    uint tid = sg * 32 + lane;
    for (uint j = tid; j < BM * (BK / 8); j += WM * WN * 32) {
        uint rr = j / (BK / 8), cc = 8 * (j % (BK / 8));
        ((threadgroup uint4 *)(A + rr * (BK + 8)))[cc / 8] =
            /* READ_VECTOR */
            (row + rr < stop) ? *(const device uint4 *)(a + (hot[row + rr] / 8) * K + k + cc)
                              : uint4(0)
            /* END READ_VECTOR */
            ;
    }
} else if (row + BM <= uint(a_shape[0]))
    al.load_unsafe();
else
    al.load_safe(short2(BK, uint(a_shape[0]) - row));
