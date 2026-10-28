# syntax=docker/dockerfile:1
#
# mason's own speech-to-text: the Parakeet TDT 0.6b v3 ONNX service in this directory, packaged for the stack.
#
# Three decisions are worth their lines:
#
#   * **ffmpeg is the point of the image.** The service decodes WAV and declared PCM16 by itself and everything else
#     through ffmpeg — Ogg/Opus, which is what a phone records a voice note in, plus MP3, M4A, WebM, FLAC. Without it
#     the Ogg bytes a Telegram voice note arrives as were read as if they were PCM16 samples and the transcript came
#     back empty, which is the failure this service answers with an error instead.
#   * **CPU onnxruntime, not the GPU build.** `requirements.txt` pins `onnxruntime-gpu` for a workstation with a card;
#     this image has no driver and no use for one, and the GPU wheel would add a CUDA runtime to sit unused while the
#     provider fell back to CPU anyway. Measured on CPU: rtf 0.07, so a 15 s voice note is about a second.
#   * **No model in the image.** The weights are ~1.3 GB and they are a download, not code: `ASR_MODEL_DIR` is a
#     volume, `docker-entrypoint.sh` fills it once on first boot, and refuses to serve if it cannot.
FROM docker.io/library/python:3.12-slim

# One apt package, and the one binary this image exists for. `slim` is enough for everything else: numpy and
# onnxruntime are wheels, so there is no toolchain to install and nothing to compile.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The pins the host's venv carries, with the one difference that matters here: `onnxruntime`, not `-gpu`.
RUN pip install --no-cache-dir "numpy==2.5.4" "onnxruntime==1.31.0"

WORKDIR /srv/asr
# The service and the decoder, not the tests and not the CLI: an image is what runs, and these four files are it.
COPY audio.py model.py server.py fetch_models.py ./
COPY docker-entrypoint.sh /usr/local/bin/mason-asr
# Set here as well as in git, because an image built from a tar of the directory (or from a checkout that lost the
# mode) would otherwise exec a file that is not executable, and the failure reads as a missing entrypoint.
RUN chmod 0755 /usr/local/bin/mason-asr

# PYTHONUNBUFFERED: the service logs its boot progress to stderr and `compose logs` is where an operator reads it.
# ASR_MODEL_DIR: the mount point of the model volume (deploy/compose.yaml), not a path in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    ASR_MODEL_DIR=/models

EXPOSE 8100
ENTRYPOINT ["/usr/local/bin/mason-asr"]
