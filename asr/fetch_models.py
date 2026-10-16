"""Fetch the Parakeet TDT v3 ONNX export from Hugging Face into a local model directory.

Produces exactly the layout `model.py` loads:

    models/nemo128.onnx
    models/encoder-model.<encoder>.onnx    (+ encoder-model.onnx.data for fp32)
    models/decoder_joint-model.<decoder>.onnx
    models/vocab.txt

Uses urllib only (no extra dependency), streams through a `.part` file, and skips files whose size already
matches the remote one — rerun to repair or resume a partial fetch.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_REPO = "ysdede/parakeet-tdt-0.6b-v3-onnx"
DEFAULT_BASE_URL = f"https://huggingface.co/{DEFAULT_REPO}/resolve/main"
PRECISIONS = ("fp32", "fp16", "int8")
USER_AGENT = "personal-durable-agent-asr/0.1"


def files_for(encoder: str, decoder: str) -> list[str]:
    encoder_file = "encoder-model.onnx" if encoder == "fp32" else f"encoder-model.{encoder}.onnx"
    files = [
        "nemo128.onnx",
        encoder_file,
        "decoder_joint-model.onnx" if decoder == "fp32" else f"decoder_joint-model.{decoder}.onnx",
        "vocab.txt",
    ]
    if encoder == "fp32":
        files.insert(2, "encoder-model.onnx.data")  # fp32 keeps its weights beside the graph
    return files


def remote_size(url: str) -> int | None:
    request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        length = response.headers.get("Content-Length")
        return int(length) if length is not None else None


def download(url: str, dest: str, *, force: bool = False) -> None:
    expected = remote_size(url)
    if not force and os.path.exists(dest) and expected is not None and os.path.getsize(dest) == expected:
        print(f"  ok    {os.path.basename(dest)} ({_mb(expected)}, already present)")
        return

    part = f"{dest}.part"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=60) as response, open(part, "wb") as sink:
        done = 0
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            sink.write(chunk)
            done += len(chunk)
            elapsed = time.monotonic() - started
            rate = done / elapsed / 1e6 if elapsed > 0 else 0.0
            total = f" / {_mb(expected)}" if expected is not None else ""
            print(f"\r  get   {os.path.basename(dest)}  {_mb(done)}{total}  {rate:.0f} MB/s", end="", flush=True)
    print()

    actual = os.path.getsize(part)
    if expected is not None and actual != expected:
        raise RuntimeError(f"{dest}: downloaded {actual} bytes, expected {expected} — rerun to retry")
    os.replace(part, dest)


def _mb(size: int) -> str:
    return f"{size / 1e6:.1f} MB"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Download the parakeet-tdt-0.6b-v3 ONNX export")
    parser.add_argument("--dest", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "models"))
    parser.add_argument("--encoder", choices=PRECISIONS, default="fp16", help="encoder precision (fp16 for GPU)")
    parser.add_argument("--decoder", choices=PRECISIONS, default="int8", help="joiner/decoder precision")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Hugging Face resolve base (for mirrors)")
    parser.add_argument("--force", action="store_true", help="re-download files that already match")
    args = parser.parse_args(argv)

    os.makedirs(args.dest, exist_ok=True)
    print(f"models -> {args.dest}  (encoder {args.encoder}, decoder {args.decoder})")
    for name in files_for(args.encoder, args.decoder):
        try:
            download(f"{args.base_url}/{name}", os.path.join(args.dest, name), force=args.force)
        except urllib.error.HTTPError as error:
            print(f"  fail  {name}: HTTP {error.code} {error.reason}", file=sys.stderr)
            return 1
        except urllib.error.URLError as error:
            print(f"  fail  {name}: {error.reason}", file=sys.stderr)
            return 1
    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
