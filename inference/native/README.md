# Native MLX dispatch experiment (not used by the server)

This replaces the graph construction for all four message gates of the twelve core layers on passes two and three (96 calls per decode step). The Python loader, attention, convolution, routing, cache and decode scheduler are unchanged. This is a bounded experiment, **not** a native port of the whole decoder. The extension uses the same arrays, dtypes and MLX primitives as the Python gates, through MLX's nanobind domain. No weight copies or new Metal kernels.

From `inference/`, with the project venv active and CMake installed:

```sh
uv pip install nanobind==3.1.0
P=$(python -c 'import sysconfig; print(sysconfig.get_path("purelib"))')
cmake -S native -B build/native -DCMAKE_BUILD_TYPE=Release \
  -DPython_EXECUTABLE="$(which python)" -Dnanobind_DIR="$P/nanobind/cmake" \
  -DMLX_DIR="$P/mlx/share/cmake/MLX"
cmake --build build/native -j4
PYTHONPATH=.:build/native HF_HUB_OFFLINE=1 python -m benchmarks.compare_native
```

Stop other model runners first. Each arm uses the same resident checkpoint, resets KV state, and runs greedy for 256 tokens. The script warms both implementations, times decode after the first token, synchronizes Metal, and requires exact output token agreement. On this M4 Pro, the warmed Python / native / native / Python run measured **31.99 / 28.69 / 30.81 / 31.16 tokens/s**. A graph-construction-only microbenchmark (not evaluating the GPU graph) was roughly 6.8 us per Python gate and 4.7–5.4 us per native gate with weight arguments prebound. This is not a reproducible end-to-end gain and does not establish a bound on a full native loop. No GPU timeline was analyzed; `xctrace` is unavailable in the selected command line tools installation.
