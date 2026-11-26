// A layer reads four message slots per token; each slot is a weighted sum of two source channels.

uint pos = thread_position_in_grid.x, channel = pos % D, message_index = (pos / D) % 4,
     token = pos / (4 * D);
uint weight_index = (token * 48 + uint(layer) * 4 + message_index) * 2;
out[pos] = fma(b[token * D + channel], scores[weight_index + 1],
               a[token * D + channel] * scores[weight_index]);
