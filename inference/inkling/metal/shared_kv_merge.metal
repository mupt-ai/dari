// Rescale partition sums to a common maximum before adding them. The attention sink contributes
// weight but no value.

uint head = threadgroup_position_in_grid.y, lane = thread_index_in_simdgroup;
float max_score = float(sinks[head]);
for (uint partition = 0; partition < NP; partition++)
    max_score = max(max_score, ((const device float2 *)stats)[partition * 24 + head].x);
float denominator = exp(float(sinks[head]) - max_score);
float4 weighted_values = 0;
for (uint partition = 0; partition < NP; partition++) {
    uint row = partition * 24 + head;
    float2 partition_stats = ((const device float2 *)stats)[row];
    float rescale = exp(partition_stats.x - max_score);
    denominator += partition_stats.y * rescale;
    weighted_values += rescale * ((const device float4 *)part)[row * 32 + lane];
}
((device bfloat4 *)out)[head * 32 + lane] = bfloat4(weighted_values / denominator);
