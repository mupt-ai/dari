auto forget = forget_logits + row * forget_logits_strides[1];
auto incoming = message_logits + row * message_logits_strides[1];
float blend[channels_per_thread];
float squares = 0;
for (uint j = 0; j < channels_per_thread; ++j) {
    uint channel = thread_id + j * threads_per_token;
    float message = fma(b[channel], weight_b, a[channel] * weight_a);
    blend[j] = (1.f - tanh(forget[channel])) * state[channel] + tanh(incoming[channel]) * message;
    squares = fma(blend[j], blend[j], squares);
}

threadgroup float partials[groups_per_token];
float scale = inverse_rms(squares, partials, thread_id);
for (uint j = 0; j < channels_per_thread; ++j) {
    uint channel = thread_id + j * threads_per_token;
    output[row * hidden_width + channel] = T((blend[j] * scale) * float(norm_weight[channel]));
}
