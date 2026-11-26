"""Paged append for chronological global KV."""

import mlx.core as mx


def append(previous, k, v, offset):
    end = offset + k.shape[2]
    cap = 0 if previous is None else previous[0].shape[2]
    # Never double a big global cache: after 4k the spare capacity per visit is
    # bounded by 4095 tokens, irrespective of total request length.
    page = min(4096, max(256, cap))
    new_cap = ((end + page - 1) // page) * page if end > cap else cap

    def put(old, new):
        if old is None:
            # Keep the cache head-major even if the projections are token-major.
            return (
                mx.contiguous(new)
                if new_cap == end
                else mx.pad(new, [(0, 0), (0, 0), (0, new_cap - end), (0, 0)])
            )
        if cap < new_cap:
            old = mx.pad(old, [(0, 0), (0, 0), (0, new_cap - cap), (0, 0)])
        old[:, :, offset:end] = new
        return old

    buf = tuple(
        put(old, new) for old, new in zip(previous or (None, None), (k, v), strict=True)
    )
    return buf[0][:, :, :end], buf[1][:, :, :end], buf
