// Split each packed word into eight nibbles. The magnitude and scale choose a palette entry;
// the sign chooses the positive or negative half.

uint p = thread_position_in_grid.x, e = p / WORDS, word = w[p], s = sc[p / 2];
for (uint j = 0; j < 8; j++) {
    uint nib = (word >> (4 * j)) & 15;
    out[p * 8 + j] = map[(e * 256 + s) * 8 + (nib & 7)] | ((nib & 8) << 4);
}
