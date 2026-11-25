// Slots 0–23 are full queries, 24–47 are relative queries, 48–55 are keys, and 56–63 are values.
// Only values use RMS normalization; the other heads are norm-clipped.

int row = thread_position_in_grid.y, head_slot = thread_position_in_grid.x / 32,
    lane = thread_position_in_grid.x % 32;
int head_width = head_slot < 24 || head_slot >= 48 ? 128 : 16;
int head_count = head_slot < 48 ? 24 : 8;
int head_index =
    head_slot < 24
        ? head_slot
        : (head_slot < 48 ? head_slot - 24 : (head_slot < 56 ? head_slot - 48 : head_slot - 56));
const device T *src = head_slot < 24 ? q : (head_slot < 48 ? r : (head_slot < 56 ? k : v));
device T *dst = head_slot < 24 ? qn : (head_slot < 48 ? rn : (head_slot < 56 ? kn : vn));
float values[4], sum = 0;
int output_offset = (row * head_count + head_index) * head_width;
for (int j = 0; j < 4; j++) {
    int channel = j * 32 + lane;
    int stride = head_slot < 24 ? q_strides[1]
                                : (head_slot < 48 ? r_strides[1]
                                                  : (head_slot < 56 ? k_strides[1] : v_strides[1]));
    float x =
        channel < head_width ? float(src[row * stride + head_index * head_width + channel]) : 0;
    if (channel < head_width && head_slot < 48)
        x *= head_slot < 24 ? float(qs[head_index * head_width + channel])
                            : float(rs[head_index * head_width + channel]);
    values[j] = x;
    sum = fma(x, x, sum);
}
sum = simd_sum(sum);
float scale = head_slot >= 56
                  ? rsqrt(sum / 128.f + 1e-6f)
                  : min(1.f, (head_width == 16 ? 8.f : 22.627416998f) / (sqrt(sum) + 1e-6f));
for (int j = 0; j < 4; j++) {
    int channel = j * 32 + lane;
    if (channel < head_width)
        dst[output_offset + channel] = T(values[j] * scale);
}
