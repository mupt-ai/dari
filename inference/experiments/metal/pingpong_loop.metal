// Alternate scratch panels each iteration. The experiment swaps the order of loading the next
// panel and multiplying the current one.

auto abase = al.dst;
auto bbase = bl.dst;
al.load_unsafe();
bl.load_unsafe();
for (uint k = 0; k < K; k += BK) {
    uint cur = (k / BK) % 2, next = 1 - cur;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    /* FIRST */
    /* SECOND */
}
