# asr/ — Parakeet TDT v3 dictation service

A standalone speech-to-text mini-service: for the web client's dictation button, and for the Telegram relay's voice
notes. Its own process, port (`8788` on a workstation, `8100` in the container), virtualenv and dependency tree — it
imports nothing from the agent stack, and the agent stack imports nothing from it. The only contract is JSON over HTTP.

```
browser mic ──(16 kHz mono WAV)───┐
phone voice ──(Ogg/Opus 48 kHz)───┴──▶ POST /transcribe ──▶ text ──▶ composer textarea / a chat message
                                       WAV and declared PCM16 in-process;
                                       everything else through ffmpeg → 16 kHz mono
```

Model: `nvidia/parakeet-tdt-0.6b-v3` (multilingual, 25 European languages), run as three ONNX graphs
(featurizer → encoder → greedy TDT decoder) on `onnxruntime`. No NeMo, no PyTorch: the export
`ysdede/parakeet-tdt-0.6b-v3-onnx` carries everything.

## Layout

| file | what |
| --- | --- |
| `model.py` | ONNX inference pipeline + greedy TDT decoder. The docstring is the tensor contract. |
| `audio.py` | request body → float32 mono @ 16 kHz. WAV and declared PCM16 in-process, everything else through `ffmpeg`; a body nothing can decode is an `AudioError` naming it, never a zero-sample decode. |
| `server.py` | the HTTP service (`/health`, `/transcribe`) and its CLI entrypoint. |
| `transcribe.py` | command-line transcription of audio files (same code path as the service). |
| `fetch_models.py` | downloads the ONNX export from Hugging Face into `models/`. |
| `Dockerfile` | the CPU image: slim Python, `ffmpeg` from apt, `onnxruntime` (not `-gpu`), and no model inside it. |
| `docker-entrypoint.sh` | fills the model volume on the first boot (once), then serves on `0.0.0.0:8100 --cpu`. |
| `tests/` | `unittest` suite: decode loop, audio decoding (WAV, Ogg/Opus, multipart, junk), endpoint contract. |

## Setup

```sh
python3 -m venv asr/.venv
asr/.venv/bin/pip install -r asr/requirements.txt
asr/.venv/bin/python asr/fetch_models.py            # fp16 encoder + int8 decoder (~1.3 GB)
```

Precisions: `--encoder fp16|fp32|int8` (default `fp16`; int8 encoder ~0.65 GB for low-VRAM boxes),
`--decoder int8|fp16|fp32` (default `int8`). `fp32` also fetches the sidecar `encoder-model.onnx.data`.

**NixOS:** the venv needs two things it cannot see on its own — `libstdc++.so.6`/`libz.so.1` for
numpy/onnxruntime, and a CUDA 13 + cuDNN 9 runtime for `onnxruntime-gpu` (ORT 1.31 bundles neither).
`asr/run.sh` resolves both from the local nixpkgs (`cudaPackages`, marked unfree for that one evaluation)
and prepends them to `LD_LIBRARY_PATH`; the first run downloads the CUDA libs into the store (~1 GB). Use
`ASR_NO_CUDA=1 asr/run.sh …` on a CPU-only box. Off NixOS, install the CUDA 13/cuDNN 9 runtime yourself
and export `LD_LIBRARY_PATH` before running the venv's python.

## Run

```sh
asr/run.sh asr/.venv/bin/python asr/server.py                 # 127.0.0.1:8788, fp16/int8
asr/run.sh asr/.venv/bin/python asr/server.py --host 0.0.0.0  # reachable from phone/laptop on the LAN
asr/run.sh asr/.venv/bin/python asr/server.py --cpu           # force CPUExecutionProvider
```

`ASR_HOST` / `ASR_PORT` override the bind. Model load takes ~5–15 s (the encoder is 1.2 GB) — the service
binds after that, so a client that connects early simply fails to reach it, nothing half-serves.

CLI:

```sh
asr/run.sh asr/.venv/bin/python asr/transcribe.py voice.ogg recording.mp3 --json   # any format ffmpeg reads
asr/run.sh asr/.venv/bin/python asr/transcribe.py recording.pcm                    # headerless PCM16 at 16 kHz
```

## In the stack

`asr/Dockerfile` packages this directory as `mason-asr`, and `deploy/compose.yaml` runs it on the stack's internal
network, with the weights on a named volume (`${MASON_STACK:-mason}-asr-models`) and no published port:

```
relay ──▶ http://mason-asr:8100/transcribe ──▶ {text, words, durationMs, elapsedMs, rtf, model}
```

The image carries no model. `ASR_MODEL_DIR` (default `/models`) is the volume; if it holds no
`encoder-model.<precision>.onnx` the entrypoint runs `fetch_models.py` once and says so, and a fetch that fails names
the URL it could not reach and exits non-zero — a service that answers `200` with no model behind it is worse than one
that is down. Seeding the volume from an existing `asr/models/` is the offline route (`deploy/README.md`, "The
transcription service").

`ASR_ENCODER` / `ASR_DECODER` pick the precision (default `fp16` / `int8`), and `ASR_MODEL_BASE_URL` points the fetch at
a mirror. Whatever those name has to be in the volume: the entrypoint fetches the pair the environment asks for.

## API

`GET /health` →

```json
{"status":"ok","model":"parakeet-tdt-0.6b-v3","encoder":"fp16","decoder":"int8",
 "provider":"CUDAExecutionProvider","sampleRate":16000,"uptimeMs":1234}
```

`POST /transcribe` — body: anything ffmpeg reads (Ogg/Opus, MP3, M4A/MP4, WebM, FLAC, AMR, ...), WAV (PCM16 or
float32, 16 kHz mono), or headerless PCM16 declared as `application/octet-stream` / `audio/pcm`. A
`multipart/form-data` body with one `file` part is unwrapped, so a relay that posts a form is the same contract.
Response:

```json
{"text":"hello world","words":[{"text":"hello","startMs":0,"endMs":160}],
 "durationMs":1200,"elapsedMs":180,"rtf":0.15,"model":"parakeet-tdt-0.6b-v3"}
```

Errors are `{"error": "..."}` with 400 (undecodable/wrong rate/too short), 413 (over the upload cap) or 500.
A 400 for a body nothing could decode names the container it looked like (`could not decode the Ogg: ...`) — an
undecodable request is never answered with an empty transcript. The ffmpeg path is bounded by the request's upload cap
(64 MB by default, checked before the body is read), a 30 s decode timeout, and a 15-minute cut on the decoded output,
so a compressed file cannot expand into a gigabyte of samples.
CORS is open (`Access-Control-Allow-Origin: *`): the client is served from another port. No auth — bind to
`127.0.0.1` unless you mean to serve the LAN; in the stack the network is the authentication and nothing is published.

## Tests

```sh
npm run test:asr                          # hermetic: fake joiner, synthetic WAVs, endpoint contract
ASR_MODELS=asr/models npm run test:asr    # + real-graph silence/fixture checks
ASR_TEST_WAV=recording.wav ASR_MODELS=asr/models npm run test:asr   # + a fixture transcript (sidecar .txt)
```

`test:asr` goes through `asr/run.sh` so the venv is usable on NixOS; add `ASR_NO_CUDA=1` to skip the CUDA
libs when testing on a CPU-only box.

The decode tests are half in-process and half against `ffmpeg`: the Ogg/Opus fixture is encoded while the suite runs
(no binary blob in git) and those tests skip with a message when `ffmpeg` is not on `PATH`. The image installs it.

## Notes

- **v1 is batch, not streaming.** The decoder keeps its LSTM state explicit so a `WS /stream` endpoint
  (PCM chunks in, `partial`/`final` out) can drive the same loop chunk-by-chunk later.
- Word timings come from the TDT duration prediction: a token's span starts on the frame that emitted it
  (80 ms per encoder frame) and ends after its predicted step, clamped to the last frame.
- Speed (5.6 s utterance, fp16 encoder / int8 decoder): ~0.06 RTF on a Zen 4 CPU, ~0.016 RTF on an RTX 3050
  once warm. Startup is ~3 s of model load plus a one-second silence pass — the service pays CUDA's
  context/kernel init there so the first dictation does not.
- VRAM: fp16 encoder ≈ 1.5 GB resident (fits a 4 GB card), fp32 ≈ 2.8 GB. int8 encoders are CPU-oriented;
  the CUDA provider executes quantized graphs largely on CPU.
