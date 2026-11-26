// The cache may include earlier tokens: offset queries by KL - QL when computing causal lags.
using namespace mlx::steel;
using AccumType = float;
constexpr int BD = 128, BV = 128, WN = /* WARP_COLS */, WM = /* WARP_ROWS */;
constexpr bool do_causal = true, has_sinks = true;
const int QL = q_shape[1], KL = k_shape[2], OFF = KL - QL;
auto tid = threadgroup_position_in_grid;
auto simd_group_id = simdgroup_index_in_threadgroup;
auto simd_lane_id = thread_index_in_simdgroup;
auto Q = q + tid.y * q_strides[2] + tid.x * BQ * q_strides[1];
auto K = k + (tid.y / 3) * k_strides[1];
auto V = v + (tid.y / 3) * v_strides[1];
auto O = out + (tid.x * BQ * 24 + tid.y) * 128;
