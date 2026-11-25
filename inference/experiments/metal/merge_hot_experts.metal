// Copy the matching offloaded expert row when it fits in the hot bucket. Fall through to the
// GPU result for all other routes.

uint pos = thread_position_in_grid.x, row = pos / D, c = pos % D, e = idx[row],
     off = row - starts[e];
/* EACH_INPUT */
if (hot[INPUT_INDEX] == e && off < CAP) {
    out[pos] = bfloat(INPUT_BUFFER[off * D + c]);
    return;
}
/* END_INPUT */
out[pos] = gpu[pos];
