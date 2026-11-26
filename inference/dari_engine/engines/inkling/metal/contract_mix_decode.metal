uint lane = thread_index_in_simdgroup, route = simdgroup_index_in_threadgroup,
     row = threadgroup_position_in_grid.x * ROWS, expert = ids[route];
float dot_products[ROWS] = {};
for (uint k = lane * V; k < K; k += 32 * V) {
    float a[V];
    load_vector<bfloat, float, V>(x + route * K + k, a);
    for (uint r = 0; r < ROWS; r++) {
        uint p = ((expert * D + row + r) * K + k);
        dot_products[r] += qdot<float, V, 4>(((const device uchar *)w) + p / 2, a,
                                             dequantize_scale<float, 16>(s[p / 16]));
    }
}
threadgroup bfloat partial[8][ROWS];
for (uint r = 0; r < ROWS; r++) {
    float v = simd_sum(dot_products[r]);
    if (lane == 0)
        partial[route][r] = bfloat(v * (g[expert] / 2688.f));
}
threadgroup_barrier(mem_flags::mem_threadgroup);
if (route == 0 && lane < ROWS) {
    uint channel = row + lane;
    float a = 0;
    for (uint j = 0; j < 8; j++)
        a = fma(float(partial[j][lane]), coeff[j], a);
    bfloat v = bfloat(a);
    float z = 0;
    for (uint j = 0; j < 3; j++)
        z = fma(float(prior[j * D + channel]), float(weight[channel * 4 + j]), z);
    z = fma(float(v), float(weight[channel * 4 + 3]), z);
    bfloat h = bfloat((float(bfloat(z)) + float(v)) * .4472135955f);
    out[channel] = bfloat(res[channel] + float(h));
    hist[channel] = prior[D + channel];
    hist[D + channel] = prior[2 * D + channel];
    hist[2 * D + channel] = v;
}
