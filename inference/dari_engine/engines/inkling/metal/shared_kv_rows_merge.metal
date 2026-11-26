// Rescale each row's partition sums to a common maximum before adding them. The attention sink
// contributes weight but no value; a partition holding none of a row's keys contributes nothing.

uint head = threadgroup_position_in_grid.y, query_row = threadgroup_position_in_grid.z,
     lane = thread_index_in_simdgroup, first = (query_row * 24 + head) * PARTS;
float sink = float(sinks[query_row * 24 + head]), max_score = sink;
for (uint p = 0; p < PARTS; p++)
    max_score = max(max_score, ((const device float2 *)stats)[first + p].x);
float denominator = exp(sink - max_score);
float4 weighted_values = 0;
for (uint p = 0; p < PARTS; p++) {
    float2 partition_stats = ((const device float2 *)stats)[first + p];
    if (partition_stats.x == -INFINITY)
        continue;
    float rescale = exp(partition_stats.x - max_score);
    denominator += partition_stats.y * rescale;
    weighted_values += rescale * ((const device float4 *)part)[(first + p) * 32 + lane];
}
((device bfloat4 *)out)[(query_row * 24 + head) * 32 + lane] = bfloat4(weighted_values / denominator);
