if (k + BK < K) {
    al.next();
    bl.next();
    al.dst = abase + next * BM * (BK + 8);
    bl.dst = bbase + next * BN * (BK + 8);
    al.load_unsafe();
    bl.load_unsafe();
}
