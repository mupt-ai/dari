// One SIMD group owns a head: 24 query, 24 relative-query, 8 key, then 8 value heads. Only the key
// and value paths need the causal filter.

uint row = thread_position_in_grid.y, head_slot = thread_position_in_grid.x / 32,
     lane = thread_index_in_simdgroup;
uint head_width = head_slot < 24 || head_slot >= 48 ? 128 : 16,
     head_index = head_slot < 24
                      ? head_slot
                      : (head_slot < 48 ? head_slot - 24
                                        : (head_slot < 56 ? head_slot - 48 : head_slot - 56));
uint stride = head_slot < 24 ? q_strides[1]
                             : (head_slot < 48 ? r_strides[1]
                                               : (head_slot < 56 ? k_strides[1] : v_strides[1]));
const device T *data = head_slot < 24 ? q : (head_slot < 48 ? r : (head_slot < 56 ? k : v));
device T *dest = head_slot < 24 ? qn : (head_slot < 48 ? rn : (head_slot < 56 ? kn : vn));
float values[4], square_sum = 0;
for (uint j = 0; j < 4; j++) {
    uint channel = 32 * j + lane, head_offset = head_index * head_width + channel;
    float a = 0;
    if (channel < head_width) {
        a = float(data[row * stride + head_offset]);
        if (head_slot < 48)
            a *= float(head_slot < 24 ? qs[head_offset] : rs[head_offset]);
        else {
            const device T *prior = head_slot < 56 ? kp : vp;
            float acc = 0;
            for (uint t = 0; t < 4; t++) {
                int src = int(row + t) - 3;
                float z = src < 0 ? float(prior[(src + 3) * 1024 + head_offset])
                                  : float(data[src * stride + head_offset]);
                acc = fma(z,
                          head_slot < 56 ? float(kw[4 * head_offset + t])
                                         : float(vw[4 * head_offset + t]),
                          acc);
            }
            a = float(T((float(T(acc)) + a) * 0.4472135955f));
        }
    }
    values[j] = a;
    square_sum = fma(a, a, square_sum);
}
square_sum = simd_sum(square_sum);
float scale = head_slot >= 56
                  ? rsqrt(square_sum / 128.f + 1e-6f)
                  : min(1.f, (head_width == 16 ? 8.f : 22.627416998f) / (sqrt(square_sum) + 1e-6f));
for (uint j = 0; j < 4; j++) {
    uint channel = 32 * j + lane;
    if (channel < head_width)
        dest[(row * (head_slot < 48 ? 24 : 8) + head_index) * head_width + channel] =
            T(values[j] * scale);
}
