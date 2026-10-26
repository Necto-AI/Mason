"""Transcribe audio files from the command line — the same decoder the service uses.

    python asr/transcribe.py voice.ogg recording.mp3 more.wav ...

Any format ffmpeg reads is accepted (Ogg/Opus, MP3, M4A, WebM, FLAC, ...), because this is the same code path as
`POST /transcribe`. A WAV must still be 16 kHz mono; a headerless `.pcm`/`.raw` file is read as PCM16 at 16 kHz.
Text goes to stdout (one line per file, or one JSON object with --json); timings and RTF go to stderr.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

from audio import AudioError, decode_audio
from model import ParakeetTdt

HERE = os.path.dirname(os.path.abspath(__file__))
#: The extensions that mean "headerless PCM16" — the one thing a file name can declare and a decoder cannot see.
RAW_EXTENSIONS = (".pcm", ".raw", ".s16", ".s16le", ".sw")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Transcribe audio files with Parakeet TDT v3 (16 kHz mono internally)")
    parser.add_argument("files", nargs="+", help="audio files (any format ffmpeg reads; see the module docstring)")
    parser.add_argument("--model-dir", default=os.path.join(HERE, "models"))
    parser.add_argument("--encoder", choices=("fp32", "fp16", "int8"), default="fp16")
    parser.add_argument("--decoder", choices=("fp32", "fp16", "int8"), default="int8")
    parser.add_argument("--cpu", action="store_true", help="force CPUExecutionProvider")
    parser.add_argument("--json", action="store_true", help="print the full result as JSON")
    args = parser.parse_args(argv)

    model = ParakeetTdt(
        args.model_dir,
        encoder_precision=args.encoder,
        decoder_precision=args.decoder,
        prefer_gpu=not args.cpu,
    )
    status = 0
    for path in args.files:
        try:
            with open(path, "rb") as handle:
                # Nothing declares a file's type on a command line, so the extension is the declaration: a `.pcm`/`.raw`
                # name is the only way to say "these bytes are samples", and everything else is sniffed and, if it is a
                # container, decoded by ffmpeg.
                content_type = "application/octet-stream" if path.lower().endswith(RAW_EXTENSIONS) else None
                wav = decode_audio(handle.read(), content_type=content_type)
        except OSError as error:
            print(f"{path}: {error}", file=sys.stderr)
            status = 1
            continue
        except AudioError as error:
            print(f"{path}: {error}", file=sys.stderr)
            status = 1
            continue

        t0 = time.perf_counter()
        result = model.transcribe(wav)
        wall = time.perf_counter() - t0
        if args.json:
            print(
                json.dumps(
                    {
                        "file": path,
                        "text": result.text,
                        "words": result.words,
                        "durationMs": round(result.duration_s * 1000),
                        "elapsedMs": round(result.elapsed_s * 1000),
                        "rtf": round(result.rtf, 4),
                    },
                    ensure_ascii=False,
                )
            )
        else:
            print(result.text)
        print(
            f"{path}: {result.duration_s:.1f}s audio, {wall:.2f}s wall, rtf {result.rtf:.3f}",
            file=sys.stderr,
        )
    return status


if __name__ == "__main__":
    raise SystemExit(main())
