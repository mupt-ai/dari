uint col = thread_position_in_grid.x, row = thread_position_in_grid.y,
     head = thread_position_in_grid.z;
int query_position = int(row) + params[0], width = params[1], tile = params[2];
int distance = params[3] + query_position - (params[4] + int(col) - 1);
uint mask_index = (head * tile + row) * width + col;
if (col == 0)
    mask[mask_index] = sinks[query_position * 24 + head];
else if (distance < 0 || (LOCAL && distance >= 1024))
    mask[mask_index] = T(-INFINITY);
else if (distance >= 1024)
    mask[mask_index] = T(0);
else
    mask[mask_index] = rel[(query_position * 24 + head) * 1024 + distance];
