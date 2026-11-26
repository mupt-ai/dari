// Normalize the current row, score it alongside the saved bank rows, then use softmax weights to
// blend them. A final projection may request another normalization.

uint t = thread_position_in_threadgroup.x, row = threadgroup_position_in_grid.y, group_id = t / 32,
     lane = t % 32;
threadgroup float scale, partials[8], scores[N + 1][8], weights[N + 1];
float val[9], square_sum = 0;
for (uint j = 0; j < 9; j++) {
    uint c = t + j * 256;
    /* INPUT */
    float v = float(x[row * x_strides[1] + c]);
    /* END INPUT */

    val[j] = v;
    square_sum = fma(v, v, square_sum);
}
/* INVERSE_RMS */

float dot_products[N + 1] = {};
for (uint j = 0; j < 9; j++) {
    uint c = t + j * 256;
    val[j] *= scale;
    float q = query[c];
    /* SAVE_NORM */
    saved[row * 2304 + c] = val[j];
    /* END SAVE_NORM */

    /* EACH_INPUT */
    dot_products[INPUT_INDEX] =
        fma(INPUT_BUFFER[row * INPUT_BUFFER_strides[1] + c * INPUT_BUFFER_strides[2]], q,
            dot_products[INPUT_INDEX]);
    /* END_INPUT */
    dot_products[N] = fma(val[j], q, dot_products[N]);
}
for (uint i = 0; i <= N; i++) {
    float a = simd_sum(dot_products[i]);
    if (!lane)
        scores[i][group_id] = a;
}
threadgroup_barrier(mem_flags::mem_threadgroup);
if (!t) {
    float hi = -INFINITY;
    for (uint i = 0; i <= N; i++) {
        float a = 0;
        for (uint g = 0; g < 8; g++)
            a += scores[i][g];
        weights[i] = a / 48.f;
        hi = max(hi, weights[i]);
    }
    float den = 0;
    for (uint i = 0; i <= N; i++) {
        weights[i] = exp(weights[i] - hi);
        den += weights[i];
    }
    for (uint i = 0; i <= N; i++)
        weights[i] /= den;
}
threadgroup_barrier(mem_flags::mem_threadgroup);
square_sum = 0;
for (uint j = 0; j < 9; j++) {
    uint c = t + j * 256;
    float a = 0;
    /* EACH_INPUT */
    a = fma(INPUT_BUFFER[row * INPUT_BUFFER_strides[1] + c * INPUT_BUFFER_strides[2]],
            weights[INPUT_INDEX], a);
    /* END_INPUT */
    val[j] = fma(val[j], weights[N], a);
    if constexpr (FINAL)
        square_sum = fma(val[j], val[j], square_sum);
}
if constexpr (FINAL) {
    /* INVERSE_RMS */
}
for (uint j = 0; j < 9; j++) {
    uint c = t + j * 256;
    float v = val[j];
    if constexpr (FINAL)
        v = (v * scale) * float(weight[c]);
    y[row * 2304 + c] = O(v);
}
