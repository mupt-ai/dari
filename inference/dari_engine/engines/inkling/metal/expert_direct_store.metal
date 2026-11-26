// Undo the route sort at store time so the next stage can read token-major output.

for (short i = 0; i < MMA::TM; i++)
    for (short j = 0; j < MMA::TN; j++) {
        uint rr = row + mma.sm + i * MMA::TM_stride, cc = col + mma.sn + j * MMA::TN_stride;
        if (rr < stop) {
            auto v = mma.Ctile.frag_at(i, j);
            *((device bfloat2 *)(y + hot[rr] * N + cc)) = bfloat2(bfloat(v[0]), bfloat(v[1]));
        }
    }
