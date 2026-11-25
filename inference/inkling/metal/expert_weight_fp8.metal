QuantizedBlockLoader<bfloat, BN, BK, BK + 8, 1, WM * WN * 32, 32, 8, false>
    bl((const device uchar *)b + (e * N + col) * K, sc + (e * N + col) * (K / 32), K, B, sg, lane);
