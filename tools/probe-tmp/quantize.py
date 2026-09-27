import sys, os
from onnxruntime.quantization import quantize_dynamic, QuantType
src, dst, mode = sys.argv[1], sys.argv[2], sys.argv[3]
ops = {"mm8": ["MatMul"], "mmgemm8": ["MatMul", "Gemm"], "lstm8": ["MatMul", "Gemm", "LSTM"]}[mode]
quantize_dynamic(src, dst, op_types_to_quantize=ops, weight_type=QuantType.QInt8, per_channel=False)
print("wrote", dst, round(os.path.getsize(dst)/1e6, 1), "MB")
