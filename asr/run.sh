#!/usr/bin/env bash
# Runs a command with the library paths the ASR venv needs on NixOS:
#   * libstdc++.so.6 / libz.so.1 for numpy and onnxruntime,
#   * CUDA 13 + cuDNN 9 for onnxruntime-gpu's CUDAExecutionProvider (ORT 1.31 ships no bundled CUDA).
#
#   asr/run.sh                          # serves the ASR service with asr/.venv
#   asr/run.sh asr/.venv/bin/python asr/transcribe.py recording.wav
#   ASR_NO_CUDA=1 asr/run.sh ...        # skip the CUDA libs (CPU-only box, or no nix)
#
# Off NixOS, install the CUDA 13 / cuDNN 9 runtime yourself and set LD_LIBRARY_PATH before calling python.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

libs=""
if command -v nix >/dev/null 2>&1; then
	if [ "${ASR_NO_CUDA:-}" != "1" ]; then
		# cudaPackages carry the CUDA EULA; scope the unfree allowance to these evaluations.
		cuda="$(NIXPKGS_ALLOW_UNFREE=1 nix build --impure --no-link --print-out-paths \
			--expr 'with import <nixpkgs> {}; [ (lib.getLib cudaPackages.cudnn) (lib.getLib cudaPackages.libcublas) (lib.getLib cudaPackages.libcurand) (lib.getLib cudaPackages.cuda_cudart) ]' \
			2>/dev/null | sed 's:$:/lib:' | paste -sd: - || true)"
		if [ -d /run/opengl-driver/lib ]; then
			cuda="${cuda:+$cuda:}/run/opengl-driver/lib"  # libcuda.so.1 from the NixOS driver
		fi
		if [ -n "$cuda" ]; then
			libs="$cuda"
		else
			echo "asr/run.sh: no CUDA 13/cuDNN 9 resolved (unfree nixpkgs?); onnxruntime will fall back to the CPU" >&2
		fi
	fi
	base="$(nix eval --impure --raw \
		--expr 'with import <nixpkgs> {}; lib.makeLibraryPath [ zlib stdenv.cc.cc.lib ]' 2>/dev/null || true)"
	if [ -n "$base" ]; then
		libs="${libs:+$libs:}$base"
	else
		echo "asr/run.sh: no nix libstdc++/zlib resolved; if 'import onnxruntime' fails, see asr/README.md" >&2
	fi
fi
if [ -n "$libs" ]; then
	export LD_LIBRARY_PATH="$libs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

if [ "$#" -eq 0 ]; then
	exec "$here/.venv/bin/python" "$here/server.py"
fi
exec "$@"
