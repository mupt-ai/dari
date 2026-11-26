uint output_index = thread_position_in_grid.x;
int token = output_index / D, channel = output_index % D, head = channel / (D / 8);
float acc = 0;
for (int lag = 0; lag < 4; lag++) {
    int src = token - lag;
    float sample =
        src >= 0 ? float(z[src * z_strides[1] + channel]) : float(prior[(src + 3) * D + channel]);
    float weight = float(stat[lag * D + channel]) + float(delta[(token * 8 + head) * 4 + lag]);
    acc = fma(sample, weight, acc);
}
out[output_index] = T((acc + float(z[token * z_strides[1] + channel])) / 3.0f);
