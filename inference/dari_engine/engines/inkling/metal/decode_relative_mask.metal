uint slot = thread_position_in_grid.x, head = thread_position_in_grid.y;
uint distance = uint(offset) - slot;
if (LOCAL)
    distance %= 1024;
mask[head * threads_per_grid.x + slot] = distance < 1024 ? rel[head * 1024 + distance] : T(0);
