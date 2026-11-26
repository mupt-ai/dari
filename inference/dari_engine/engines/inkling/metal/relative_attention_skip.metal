int first = LOCAL ? max(0, (int(tid.x) * BQ + OFF - 1023) / BK) : 0;
for (int skip = 0; skip < first; skip++) {
    loader_k.next();
    loader_v.next();
}
