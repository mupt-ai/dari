// Count routes per expert in threadgroup memory; write one histogram column per input block.

uint thread_id = thread_position_in_threadgroup.x, block = threadgroup_position_in_grid.x;
threadgroup atomic_uint histogram[128];
if (thread_id < 128)
    atomic_store_explicit(histogram + thread_id, 0u, memory_order_relaxed);
threadgroup_barrier(mem_flags::mem_threadgroup);
uint route = block * 256 + thread_id;
if (route < N)
    atomic_fetch_add_explicit(histogram + ids[route], 1u, memory_order_relaxed);
threadgroup_barrier(mem_flags::mem_threadgroup);
if (thread_id < 128)
    counts[thread_id * B + block] =
        atomic_load_explicit(histogram + thread_id, memory_order_relaxed);
