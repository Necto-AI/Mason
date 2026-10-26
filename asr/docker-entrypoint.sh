#!/bin/sh
# Boot the ASR service, fetching the ONNX weights once if the model volume is empty.
#
# The image carries no model (~1.3 GB of weights are a download, not code), so `ASR_MODEL_DIR` is a mounted volume and
# the first boot fills it. Two refusals, both deliberate: a volume that is empty and a fetch that fails are reasons to
# exit non-zero, because a service that answers 200 with no model behind it is worse than a container that is down.
set -eu

model_dir="${ASR_MODEL_DIR:-/models}"
encoder="${ASR_ENCODER:-fp16}"
decoder="${ASR_DECODER:-int8}"
# The file `model.py` opens first, so it is the one that says whether this volume holds a usable model.
marker="encoder-model.${encoder}.onnx"

mkdir -p "$model_dir"

if [ ! -f "$model_dir/$marker" ]; then
	echo "[asr] $model_dir holds no $marker: fetching the ONNX export from Hugging Face once" \
		"(~1.3 GB; this is the only outbound request this container ever makes)"
	if ! python /srv/asr/fetch_models.py --dest "$model_dir" --encoder "$encoder" --decoder "$decoder" \
		${ASR_MODEL_BASE_URL:+--base-url "$ASR_MODEL_BASE_URL"}; then
		echo "[asr] could not fetch the model into $model_dir; the URL that failed is named above." >&2
		echo "[asr] seed the volume instead: copy an existing asr/models/ into it, or set ASR_MODEL_BASE_URL to a" >&2
		echo "[asr] mirror (deploy/README.md, \"The transcription service\"). Refusing to serve without a model." >&2
		exit 1
	fi
	echo "[asr] model fetched into $model_dir"
fi

# CPU, because the image has no CUDA runtime and no driver to talk to (asr/Dockerfile says why), and 0.0.0.0 because
# the container's own loopback is not reachable from the relay. `"$@"` is how a caller asks for another precision.
exec python /srv/asr/server.py --host 0.0.0.0 --port 8100 --cpu --model-dir "$model_dir" "$@"
