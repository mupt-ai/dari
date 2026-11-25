constexpr uint state_width = 64;
constexpr uint lanes_per_channel = 8;
constexpr uint features_per_lane = state_width / lanes_per_channel;
uint lane = thread_index_in_simdgroup % lanes_per_channel;
uint channel = thread_position_in_grid.x / lanes_per_channel;
uint first_feature = lane * features_per_lane;

// Each channel has adjacent weight rows for the forget and incoming gates.
auto forget_weights = packed_weights + channel * (2 * state_width) + first_feature;
auto incoming_weights = forget_weights + state_width;
float2 logits(0);
for (uint i = 0; i < features_per_lane; ++i) {
    float2 weights = float2(float(forget_weights[i]), float(incoming_weights[i]));
    logits = fma(float(gate_state[first_feature + i]), weights, logits);
}

// Sum the eight contributions. Only the first lane needs the complete logits.
logits += simd_shuffle_down(logits, 4);
logits += simd_shuffle_down(logits, 2);
logits += simd_shuffle_down(logits, 1);
if (lane == 0) {
    float previous = float(hidden[channel * hidden_strides[2]]);
    float incoming = float(message[channel * message_strides[2]]);
    output[channel] = (1.f - tanh(logits.x)) * previous + tanh(logits.y) * incoming;
}
