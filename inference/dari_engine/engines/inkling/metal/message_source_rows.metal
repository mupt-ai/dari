uint row = threadgroup_position_in_grid.y;
uint thread_id = thread_position_in_threadgroup.x;
auto a = source_a + row * source_a_strides[1];
auto b = source_b + row * source_b_strides[1];
auto state = hidden + row * hidden_strides[1];
uint score_index = 2 * (row * messages_per_token + slot);
float weight_a = scores[score_index];
float weight_b = scores[score_index + 1];
