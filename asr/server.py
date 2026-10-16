"""Standalone ASR HTTP service: POST /transcribe, GET /health.

Deliberately isolated from the durable agent: its own process, port, virtualenv and dependency tree. The
only interface is the JSON-over-HTTP contract below, so the agent stack can be replaced without touching
this service (and vice versa).

    POST /transcribe   body: WAV or PCM16 (16 kHz mono)   ->  {text, words, durationMs, elapsedMs, rtf, model}
    GET  /health                                            ->  {status, model, provider, ...}

Built on the standard library's threaded HTTP server: two endpoints, one GPU, no async needed. Streaming
(v2) will add a WebSocket endpoint in front of the same explicit decoder state, not rewrite this one.

Run:  python asr/server.py --help    (see README for the venv, models and NixOS notes)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import onnxruntime as ort

from audio import SAMPLE_RATE, AudioError, decode_audio
from model import ParakeetTdt

MODEL_ID = "parakeet-tdt-0.6b-v3"
DEFAULT_PORT = 8788
DEFAULT_MAX_UPLOAD_MB = 64
MIN_SAMPLES = SAMPLE_RATE // 10  # 100 ms — below this the featurizer has nothing to chew on
HERE = os.path.dirname(os.path.abspath(__file__))


class AsrServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    parakeet: ParakeetTdt
    meta: dict
    inference_lock: threading.Lock
    max_upload_bytes: int
    started_at: float


class Handler(BaseHTTPRequestHandler):
    server: AsrServer  # narrow the base type for the type checker and readers
    protocol_version = "HTTP/1.1"  # keep-alive; every response carries Content-Length
    timeout = 60

    # -- plumbing ---------------------------------------------------------------

    def _start(self) -> None:
        self._t0 = time.perf_counter()

    def _respond(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
        elapsed = (time.perf_counter() - self._t0) * 1000 if hasattr(self, "_t0") else 0.0
        print(
            f"[asr] {self.address_string()} {self.command} {self.path} -> {status} {elapsed:.0f}ms",
            file=sys.stderr,
            flush=True,
        )

    def log_message(self, fmt: str, *args: object) -> None:  # the one-line log above replaces the default
        pass

    # -- routes -----------------------------------------------------------------

    def do_OPTIONS(self) -> None:  # CORS preflight: the browser client lives on another port
        self._start()
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        self._start()
        if urlparse(self.path).path != "/health":
            self._respond(404, {"error": f"unknown path {self.path}"})
            return
        meta = self.server.meta
        self._respond(
            200,
            {
                "status": "ok",
                "model": MODEL_ID,
                "encoder": meta["encoder"],
                "decoder": meta["decoder"],
                "provider": meta["provider"],
                "sampleRate": SAMPLE_RATE,
                "uptimeMs": round((time.monotonic() - self.server.started_at) * 1000),
            },
        )

    def do_POST(self) -> None:
        self._start()
        if urlparse(self.path).path != "/transcribe":
            self.close_connection = True  # a refused POST's body goes unread
            self._respond(404, {"error": f"unknown path {self.path}"})
            return
        try:
            body = self._read_body()
        except _HttpError as error:
            self._respond(error.status, {"error": error.message})
            return

        try:
            wav = decode_audio(body)
            if wav.size < MIN_SAMPLES:
                raise AudioError(f"audio too short: {wav.size / SAMPLE_RATE:.3f}s < 0.1s")
        except AudioError as error:
            self._respond(400, {"error": str(error)})
            return

        try:
            with self.server.inference_lock:  # one GPU: serialize, don't thrash
                result = self.server.parakeet.transcribe(wav)
        except Exception:  # noqa: BLE001 — anything here is a bug; log it and keep the service alive
            traceback.print_exc()
            self._respond(500, {"error": "internal error during transcription"})
            return

        self._respond(
            200,
            {
                "text": result.text,
                "words": result.words,
                "durationMs": round(result.duration_s * 1000),
                "elapsedMs": round(result.elapsed_s * 1000),
                "rtf": round(result.rtf, 4),
                "model": MODEL_ID,
            },
        )

    def _read_body(self) -> bytes:
        # Every failure here leaves the body unread: close the connection rather than parse it as a request.
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            self.close_connection = True
            raise _HttpError(411, "Content-Length is required")
        try:
            length = int(length_header)
        except ValueError:
            self.close_connection = True
            raise _HttpError(400, "Content-Length is not an integer") from None
        if length <= 0:
            self.close_connection = True
            raise _HttpError(400, "empty body")
        if length > self.server.max_upload_bytes:
            self.close_connection = True
            raise _HttpError(413, f"body of {length} bytes exceeds the {self.server.max_upload_bytes} byte limit")
        return self.rfile.read(length)


class _HttpError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def load_model(args: argparse.Namespace) -> tuple[ParakeetTdt, dict]:
    prefer_gpu = not args.cpu
    model = ParakeetTdt(
        args.model_dir,
        encoder_precision=args.encoder,
        decoder_precision=args.decoder,
        prefer_gpu=prefer_gpu,
    )
    meta = {
        "encoder": args.encoder,
        "decoder": args.decoder,
        "provider": model.providers[0] if model.providers else "unknown",
    }
    return model, meta


def create_server(
    model: ParakeetTdt,
    *,
    host: str,
    port: int,
    meta: dict,
    max_upload_mb: int = DEFAULT_MAX_UPLOAD_MB,
) -> AsrServer:
    server = AsrServer((host, port), Handler)
    server.parakeet = model
    server.meta = meta
    server.inference_lock = threading.Lock()
    server.max_upload_bytes = max_upload_mb * 1024 * 1024
    server.started_at = time.monotonic()
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Parakeet TDT ASR service")
    parser.add_argument("--host", default=os.environ.get("ASR_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("ASR_PORT", DEFAULT_PORT)))
    parser.add_argument("--model-dir", default=os.path.join(HERE, "models"))
    parser.add_argument("--encoder", choices=("fp32", "fp16", "int8"), default="fp16")
    parser.add_argument("--decoder", choices=("fp32", "fp16", "int8"), default="int8")
    parser.add_argument("--cpu", action="store_true", help="force CPUExecutionProvider")
    parser.add_argument("--max-upload-mb", type=int, default=DEFAULT_MAX_UPLOAD_MB)
    args = parser.parse_args(argv)

    print(f"[asr] onnxruntime {ort.__version__}, available providers: {ort.get_available_providers()}", file=sys.stderr)
    print(f"[asr] loading {MODEL_ID} from {args.model_dir} ({args.encoder}/{args.decoder})…", file=sys.stderr)
    t0 = time.perf_counter()
    model, meta = load_model(args)
    print(f"[asr] model loaded in {time.perf_counter() - t0:.1f}s on {meta['provider']}", file=sys.stderr)
    warm = model.warm_up()
    print(f"[asr] warm-up pass {warm * 1000:.0f}ms", file=sys.stderr)

    server = create_server(model, host=args.host, port=args.port, meta=meta, max_upload_mb=args.max_upload_mb)
    print(f"[asr] listening on http://{args.host}:{server.server_address[1]}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[asr] shutting down", file=sys.stderr)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
