for (uint j = 0; j < PER; j++) {
    uint it = j * TGS + thread_id;
    if (it < BM * BK / VEC) {
        uint tile_row = it / (BK / VEC), tile_col = it % (BK / VEC) * VEC;
        *((threadgroup bfloat4 *)(A + tile_row * (BK + 8) + tile_col)) =
            *((const device bfloat4 *)(a + sources[j] * K + k + tile_col));
    }
}
