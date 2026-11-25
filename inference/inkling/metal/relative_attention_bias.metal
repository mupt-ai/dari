if (LOCAL || (kb + 1) * BK > int(tid.x) * BQ + OFF - 1024) {
    using ST = decltype(Stile);
    for (short i = 0; i < ST::kTileRows; i++)
        for (short j = 0; j < ST::kTileCols; j++)
            for (short z = 0; z < 2; z++) {
                int query_row = int(tid.x) * BQ + tm + sm + i * 8,
                    key_lag = query_row + OFF - (kb * BK + sn + j * 8 + z);
                if (uint(key_lag) < 1024 && query_row < QL)
                    Stile.frag_at(i, j)[z] +=
                        M_LOG2E_F *
                        float(rel[query_row * rel_strides[2] + tid.y * rel_strides[1] + key_lag]);
                else if (LOCAL)
                    Stile.frag_at(i, j)[z] = Limits<float>::finite_min;
            }
}
