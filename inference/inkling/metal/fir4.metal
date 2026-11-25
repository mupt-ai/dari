uint output_index = thread_position_in_grid.x;
int token = output_index / D, channel = output_index % D;
float accum = 0;
for (int j = 0; j < 4; j++) {
    int row = token + j - 3;
    float sample =
        row >= 0 ? float(z[row * z_strides[1] + channel]) : float(prior[(row + 3) * D + channel]);
    accum = fma(sample, float(w[channel * 4 + j]), accum);
}
out[output_index] = T((float(T(accum)) + float(z[token * z_strides[1] + channel])) * 0.4472135955f);
