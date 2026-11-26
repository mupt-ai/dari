// Rank using biased probabilities, break ties by lower expert ID, but normalize the eight winners
// using their original probabilities.

uint row = thread_position_in_grid.y, lane = thread_position_in_grid.x;
float probability[4], priority[4];
for (uint j = 0; j < 4; j++) {
    uint expert = j * 32 + lane;
    probability[j] = 1.f / (1.f + exp(-logits[row * 128 + expert]));
    priority[j] = probability[j] + bias[expert];
}
float weights[8];
float total = 0;
for (uint i = 0; i < 8; i++) {
    uint best_local = 0;
    for (uint j = 1; j < 4; j++)
        if (priority[j] > priority[best_local])
            best_local = j;
    float best_priority = simd_max(priority[best_local]);
    uint winner = simd_min(priority[best_local] == best_priority ? 32 * best_local + lane : 128u);
    float unbiased_weight = simd_broadcast(probability[best_local], winner % 32);
    if (lane == winner % 32)
        priority[best_local] = -INFINITY;
    if (lane == 0) {
        ids[row * 8 + i] = winner;
        weights[i] = unbiased_weight;
        total += unbiased_weight;
    }
}
if (lane == 0)
    for (uint i = 0; i < 8; i++)
        coeff[row * 8 + i] = (weights[i] / (total + 1e-20f)) * 8.f;
