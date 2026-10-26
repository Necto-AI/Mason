"""Endpoint contract tests: /health and /transcribe against a fake model — no ONNX graphs required.

Pins the JSON shape the web client codes against, the CORS headers a cross-port browser fetch needs, and the
error paths (bad audio, oversized body, unknown path, a model that throws).
"""

from __future__ import annotations

import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from model import AsrResult  # noqa: E402
from server import create_server  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_audio import FORM_TYPE, multipart, ogg_opus, pcm16, requires_ffmpeg, wav_body  # noqa: E402

META = {"encoder": "fp16", "decoder": "int8", "provider": "CPUExecutionProvider"}


class FakeParakeet:
    def __init__(self) -> None:
        self.calls: list[np.ndarray] = []
        self.fail = False

    def transcribe(self, wav: np.ndarray) -> AsrResult:
        if self.fail:
            raise RuntimeError("boom")
        self.calls.append(wav)
        duration = wav.shape[0] / 16_000
        return AsrResult(
            text="hello world",
            words=[{"text": "hello", "startMs": 0, "endMs": 80}, {"text": "world", "startMs": 80, "endMs": 240}],
            tokens=["\u2581hello"],
            token_ids=[1],
            duration_s=duration,
            elapsed_s=0.05,
            rtf=0.5,
        )


class ServerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.model = FakeParakeet()
        self.server = create_server(self.model, host="127.0.0.1", port=0, meta=META, max_upload_mb=1)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def get(self, path: str) -> tuple[int, dict, dict]:
        try:
            with urllib.request.urlopen(self.base + path, timeout=10) as response:
                return response.status, json.loads(response.read()), dict(response.headers)
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read()), dict(error.headers)

    def post(self, path: str, body: bytes, content_type: str = "audio/wav") -> tuple[int, dict, dict]:
        request = urllib.request.Request(self.base + path, data=body, method="POST", headers={"Content-Type": content_type})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read()), dict(response.headers)
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read()), dict(error.headers)

    def test_health_reports_the_model_and_provider(self) -> None:
        status, payload, headers = self.get("/health")
        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["model"], "parakeet-tdt-0.6b-v3")
        self.assertEqual(payload["provider"], "CPUExecutionProvider")
        self.assertEqual(payload["sampleRate"], 16_000)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")

    def test_transcribe_returns_text_words_and_timings(self) -> None:
        status, payload, headers = self.post("/transcribe", wav_body(pcm16(*([1000] * 1600))))
        self.assertEqual(status, 200)
        self.assertEqual(payload["text"], "hello world")
        self.assertEqual(payload["words"][1], {"text": "world", "startMs": 80, "endMs": 240})
        self.assertEqual(payload["durationMs"], 100)
        self.assertEqual(payload["model"], "parakeet-tdt-0.6b-v3")
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        # The handler hands the model float32 in [-1, 1] at 16 kHz.
        self.assertEqual(self.model.calls[0].dtype, np.float32)
        self.assertAlmostEqual(float(self.model.calls[0][0]), 1000 / 32768, places=5)

    def test_transcribe_accepts_headerless_pcm16(self) -> None:
        status, payload, _ = self.post("/transcribe", pcm16(*([500] * 1600)), content_type="application/octet-stream")
        self.assertEqual(status, 200)
        self.assertEqual(payload["text"], "hello world")

    def test_rejects_undecodable_audio(self) -> None:
        status, payload, _ = self.post("/transcribe", b"not audio at all")
        self.assertEqual(status, 400)
        self.assertIn("error", payload)
        # The failure this whole path exists to refuse: bytes nobody could decode must not come back as a 200 with an
        # empty transcript. Nothing was transcribed, so the model was never asked.
        self.assertEqual(self.model.calls, [])

    @requires_ffmpeg
    def test_transcribe_accepts_a_multipart_ogg_voice_note(self) -> None:
        # what the Telegram relay posts: a form, one `file` part, Ogg/Opus inside — the format a phone records in
        status, payload, _ = self.post("/transcribe", multipart(ogg_opus(0.5)), content_type=FORM_TYPE)
        self.assertEqual(status, 200)
        self.assertEqual(payload["text"], "hello world")
        self.assertAlmostEqual(self.model.calls[0].size / 16_000, 0.5, delta=0.05)

    def test_rejects_audio_below_the_minimum_length(self) -> None:
        status, payload, _ = self.post("/transcribe", wav_body(pcm16(1, 2, 3)))
        self.assertEqual(status, 400)
        self.assertIn("too short", payload["error"])

    def test_rejects_oversized_bodies(self) -> None:
        self.server.max_upload_bytes = 100
        status, payload, _ = self.post("/transcribe", pcm16(*([1] * 2000)))
        self.assertEqual(status, 413)
        self.assertIn("exceeds", payload["error"])

    def test_unknown_paths_are_404(self) -> None:
        status, payload, _ = self.get("/nope")
        self.assertEqual(status, 404)
        self.assertIn("unknown path", payload["error"])
        status, _, _ = self.post("/health", pcm16(*([1] * 2000)))
        self.assertEqual(status, 404)

    def test_preflight_is_answered(self) -> None:
        request = urllib.request.Request(self.base + "/transcribe", method="OPTIONS")
        with urllib.request.urlopen(request, timeout=10) as response:
            self.assertEqual(response.status, 204)
            self.assertIn("POST", response.headers["Access-Control-Allow-Methods"])
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")

    def test_a_throwing_model_is_500_and_the_service_survives(self) -> None:
        self.model.fail = True
        status, payload, _ = self.post("/transcribe", wav_body(pcm16(*([1] * 2000))))
        self.assertEqual(status, 500)
        self.assertIn("internal error", payload["error"])
        self.model.fail = False
        status, payload, _ = self.post("/transcribe", wav_body(pcm16(*([1] * 2000))))
        self.assertEqual(status, 200)
        self.assertEqual(payload["text"], "hello world")


if __name__ == "__main__":
    unittest.main()
