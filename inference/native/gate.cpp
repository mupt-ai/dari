#include <nanobind/nanobind.h>
#include <mlx/mlx.h>

namespace mx = mlx::core;
using mx::array;

// Same pretrained weights, same primitives, no host read or synchronization.
array gate(array h, array m, array down, array forget, array message) {
    auto x = mx::concatenate({mx::fast::rms_norm(h, {}, 1e-6f),
                              mx::fast::rms_norm(m, {}, 1e-6f)}, -1);
    auto z = mx::astype(mx::matmul(mx::astype(x, down.dtype()), mx::transpose(down)), mx::float32);
    auto f = mx::tanh(mx::matmul(z, mx::transpose(forget)));
    auto g = mx::tanh(mx::matmul(z, mx::transpose(message)));
    return (array(1.f) - f) * h + g * m;
}
NB_MODULE(_native, m) { m.def("gate", &gate); }
