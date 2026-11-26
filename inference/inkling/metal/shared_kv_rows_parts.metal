// Consecutive query rows, as in verification. Row r sits at position length - L + r and sees keys
// up to it: a global layer's whole chronological cache, or a local layer's last 1024 positions,
// read from the ring of earlier keys and the block's own new rows. A threadgroup owns one KV head
// and the key blocks congruent to its partition; it stages four blocks of keys and values in
// threadgroup memory, and each SIMD group (one per row) scores the three query heads sharing
// that KV head.
// A lane holds four channels of all eight keys in a block; one transposing reduction leaves lane
// l with the score of key (l >> 2) & 7, so the softmax advances eight keys at a time.

uint lane = thread_index_in_simdgroup, row = simdgroup_index_in_threadgroup,
     tid = thread_index_in_threadgroup, shard = threadgroup_position_in_grid.x,
     group = threadgroup_position_in_grid.y;
// FULL rows (a draft block) see every key, without a relative bias.
uint length = extent[0], position = FULL ? length - 1 : length - L + row, component = lane * 4,
     first = length - L, lo = LOCAL && first > 1023 ? first - 1023 : 0;
float4 query[3], value[3];
float peak[3], weight[3];
uint bias_row[3];
for (uint s = 0; s < 3; s++) {
    uint head = group * 3 + s;
    query[s] = float4(((const device bfloat4 *)q)[(row * 24 + head) * 32 + lane]) *
               .08838834764831845f;
    bias_row[s] = head * rel_strides[1] + row * rel_strides[2];
    value[s] = 0;
    peak[s] = -INFINITY;
    weight[s] = 0;
}
uint slot = (lane >> 2) & 7;
bool upper16 = (lane & 16) != 0, upper8 = (lane & 8) != 0, upper4 = (lane & 4) != 0;
threadgroup uint4 staged_keys[32 * 16], staged_values[32 * 16];
const device uint4 *key_words = (const device uint4 *)(k + group * k_strides[1]);
const device uint4 *value_words = (const device uint4 *)(v + group * v_strides[1]);
const device uint4 *new_keys = (const device uint4 *)(nk + group * L * 128);
const device uint4 *new_values = (const device uint4 *)(nv + group * L * 128);
uint blocks = (length - lo + 7) / 8;
for (uint batch = shard; batch < blocks; batch += 4 * PARTS) {
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (uint c = tid; c < 32 * 16; c += 32 * L) {
        uint staged = c / 16;
        uint key = min(lo + (batch + staged / 8 * PARTS) * 8 + staged % 8, length - 1);
        if (LOCAL && key >= first) {
            staged_keys[c] = new_keys[(key - first) * 16 + c % 16];
            staged_values[c] = new_values[(key - first) * 16 + c % 16];
        } else {
            uint at = LOCAL ? key % 1024 : key;
            staged_keys[c] = key_words[at * (k_strides[2] / 8) + c % 16];
            staged_values[c] = value_words[at * (v_strides[2] / 8) + c % 16];
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (uint sub = 0; sub < 4; sub++) {
        uint start = lo + (batch + sub * PARTS) * 8;
        if (start > position || (LOCAL && start + 1031 < position))
            continue;
        const threadgroup bfloat4 *keys = (const threadgroup bfloat4 *)staged_keys + sub * 8 * 32;
        const threadgroup bfloat4 *values =
            (const threadgroup bfloat4 *)staged_values + sub * 8 * 32;
        float dots[3][8];
        for (uint t = 0; t < 8; t++) {
            float4 key = float4(keys[t * 32 + lane]);
            for (uint s = 0; s < 3; s++)
                dots[s][t] = dot(query[s], key);
        }
        uint index = start + slot, distance = position - index;
        bool live = index <= position && (!LOCAL || distance < 1024);
        float prob[3];
        for (uint s = 0; s < 3; s++) {
            // Halve the eight partial dots across lane bits 4, 3 and 2, then finish each sum
            // across lane bits 0 and 1.
            float four[4], two[2];
            for (uint j = 0; j < 4; j++) {
                float keep = upper16 ? dots[s][j + 4] : dots[s][j];
                float give = upper16 ? dots[s][j] : dots[s][j + 4];
                four[j] = keep + simd_shuffle_xor(give, 16);
            }
            for (uint j = 0; j < 2; j++) {
                float keep = upper8 ? four[j + 2] : four[j];
                float give = upper8 ? four[j] : four[j + 2];
                two[j] = keep + simd_shuffle_xor(give, 8);
            }
            float score = (upper4 ? two[1] : two[0]) + simd_shuffle_xor(upper4 ? two[0] : two[1], 4);
            score += simd_shuffle_xor(score, 1);
            score += simd_shuffle_xor(score, 2);
            float bias =
                !FULL && live && distance < 1024 ? float(rel[bias_row[s] + distance]) : 0.f;
            score = live ? score + bias : -INFINITY;
            float top = max(score, simd_shuffle_xor(score, 4));
            top = max(top, simd_shuffle_xor(top, 8));
            top = max(top, simd_shuffle_xor(top, 16));
            float next = max(peak[s], top);
            float prior = exp(peak[s] - next), p = exp(score - next);
            float total = p + simd_shuffle_xor(p, 4);
            total += simd_shuffle_xor(total, 8);
            total += simd_shuffle_xor(total, 16);
            weight[s] = fma(weight[s], prior, total);
            peak[s] = next;
            value[s] *= prior;
            prob[s] = p;
        }
        for (uint t = 0; t < 8; t++) {
            float4 val = float4(values[t * 32 + lane]);
            for (uint s = 0; s < 3; s++)
                value[s] = fma(float4(simd_shuffle(prob[s], ushort(t * 4))), val, value[s]);
        }
    }
}
for (uint s = 0; s < 3; s++) {
    uint at = ((row * 24 + group * 3 + s) * PARTS + shard);
    ((device float4 *)part)[at * 32 + lane] = value[s];
    if (lane == 0)
        ((device float2 *)stats)[at] = float2(peak[s], weight[s]);
}
