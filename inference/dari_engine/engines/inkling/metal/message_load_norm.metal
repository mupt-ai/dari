float2 values[channels_per_thread]; // (hidden state, reconstructed message)
float2 squares = 0;
for (uint j = 0; j < channels_per_thread; ++j) {
    uint channel = thread_id + j * threads_per_token;
    float message = fma(b[channel], weight_b, a[channel] * weight_a);
    values[j] = float2(state[channel], message);
    squares = fma(values[j], values[j], squares);
}

threadgroup float2 partials[groups_per_token];
float2 scale = inverse_rms(squares, partials, thread_id);
auto gate_row = output + row * (2 * hidden_width);
for (uint j = 0; j < channels_per_thread; ++j) {
    uint channel = thread_id + j * threads_per_token;
    gate_row[channel] = T(values[j].x * scale.x);
    gate_row[hidden_width + channel] = T(values[j].y * scale.y);
}
