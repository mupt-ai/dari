// Split selected tails so an extra small tile replaces mostly unused matrix rows.

uint count = stop - starts[e], full = count / BM, rem = count % BM, j = t - base[e];
uint mid = (rem > 32 && rem <= 48) ? 32 : ((rem > 16 && rem <= 24) ? 16 : 0);
if (mid && j >= full) {
    row = starts[e] + full * BM;
    if (j == full)
        stop = row + mid;
    else
        row += mid;
}
