// Read eight indices per lane and expand them with the expert-local BF16 palette instead of
// unpacking individual FP4 weights.

uint thread_id = sg * 32 + lane;
for (uint it = thread_id; it < BN * BK / 8; it += WM * WN * 32) {
    uint tile_row = it / (BK / 8), tile_col = it % (BK / 8) * 8,
         at = (e * N + col + tile_row) * K + k + tile_col;
    uchar4 aa = ((const device uchar4 *)b)[at / 4], bb = ((const device uchar4 *)b)[at / 4 + 1];
    for (uint j = 0; j < 4; j++) {
        B[tile_row * (BK + 8) + tile_col + j] = palette[aa[j]];
        B[tile_row * (BK + 8) + tile_col + 4 + j] = palette[bb[j]];
    }
}
