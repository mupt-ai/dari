if (row + BM <= uint(a_shape[0]))
    al.load_unsafe();
else
    al.load_safe(short2(BK, uint(a_shape[0]) - row));
