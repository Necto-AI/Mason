# asr/ — Parakeet TDT v3 dictation service

A standalone speech-to-text mini-service for the web client's dictation button. Its own process, port
(`8788`), virtualenv and dependency tree — it imports nothing from the agent stack, and the agent stack
imports nothing from it. The only contract is JSON over HTTP.

```
browser mic ──(16 kHz PCM16 WAV)──▶ POST /transcribe ──▶ text ──▶ composer textarea
```

Model: `nvidia/parakeet-tdt-0.6b-v3` (multilingual, 25 European languages), run as three ONNX graphs
(featurizer → encoder → greedy TDT decoder) on `onnxruntime`. No NeMo, no PyTorch: the export
`ysdede/parakeet-tdt-0.6b-v3-onnx` carries everything.

## Layout

| file | what |
| --- | --- |
| `model.py` | ONNX inference pipeline + greedy TDT decoder. The docstring is the tensor contract. |
| `audio.py` | request body → float32 mono @ 16 kHz. Rejects anything else loudly. |
| `server.py` | the HTTP service (`/health`, `/transcribe`) and its CLI entrypoint. |
| `transcribe.py` | command-line transcription of WAV files (same code path as the service). |
| `fetch_models.py` | downloads the ONNX export from Hugging Face into `models/`. |
| `tests/` | `unittest` suite: decode loop, audio decoding, endpoint contract. |

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
ffmpeg -i recording.mp3 -ar 16000 -ac 1 recording.wav     # the service only takes 16 kHz mono
asr/run.sh asr/.venv/bin/python asr/transcribe.py recording.wav --json
```

## API

`GET /health` →

```json
{"status":"ok","model":"parakeet-tdt-0.6b-v3","encoder":"fp16","decoder":"int8",
 "provider":"CUDAExecutionProvider","sampleRate":16000,"uptimeMs":1234}
```

`POST /transcribe` — body: WAV (PCM16 or float32, 16 kHz mono) or headerless PCM16; response:

```json
{"text":"hello world","words":[{"text":"hello","startMs":0,"endMs":160}],
 "durationMs":1200,"elapsedMs":180,"rtf":0.15,"model":"parakeet-tdt-0.6b-v3"}
```

Errors are `{"error": "..."}` with 400 (undecodable/wrong rate/too short), 413 (over the upload cap) or 500.
CORS is open (`Access-Control-Allow-Origin: *`): the client is served from another port. No auth — bind to
`127.0.0.1` unless you mean to serve the LAN.

## Tests

```sh
npm run test:asr                          # hermetic: fake joiner, synthetic WAVs, endpoint contract
ASR_MODELS=asr/models npm run test:asr    # + real-graph silence/fixture checks
ASR_TEST_WAV=recording.wav ASR_MODELS=asr/models npm run test:asr   # + a fixture transcript (sidecar .txt)
```

`test:asr` goes through `asr/run.sh` so the venv is usable on NixOS; add `ASR_NO_CUDA=1` to skip the CUDA
libs when testing on a CPU-only box.

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
