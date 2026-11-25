float raw = float(z[row * z_strides[1] + c]), filtered = 0;
for (int tap = 0; tap < 4; tap++) {
    int i = int(row) + tap - 3;
    float sample = i < 0 ? float(hist[(i + 3) * 2304 + c]) : float(z[i * z_strides[1] + c]);
    filtered = fma(sample, float(fir[4 * c + tap]), filtered);
}
float v = float(bfloat((float(bfloat(filtered)) + raw) * .4472135955f));
if constexpr (SKIP)
    v += float(x[row * x_strides[1] + c]);
saved[row * 2304 + c] = v;
