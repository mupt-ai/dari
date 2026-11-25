threadgroup bfloat palette[256];
for (uint ii = sg * 32 + lane; ii < 256; ii += WM * WN * 32)
    palette[ii] = sc[e * 256 + ii];
threadgroup_barrier(mem_flags::mem_threadgroup);
