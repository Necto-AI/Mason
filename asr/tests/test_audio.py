"""Unit tests for the audio decoder: WAV parsing, raw PCM16, and the loud rejections."""

from __future__ import annotations

import struct
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from audio import AudioError, decode_audio, looks_like_wav, pcm16_to_float32  # noqa: E402


def wav_body(
    payload: bytes,
    *,
    fmt: int = 1,
    channels: int = 1,
    rate: int = 16_000,
    bits: int = 16,
    before_data: bytes = b"",
) -> bytes:
    block_align = channels * bits // 8
    fmt_chunk = struct.pack("<HHIIHH", fmt, channels, rate, rate * block_align, block_align, bits)
    chunks = b"fmt " + struct.pack("<I", len(fmt_chunk)) + fmt_chunk + before_data
    chunks += b"data" + struct.pack("<I", len(payload)) + payload
    return b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks


def pcm16(*samples: int) -> bytes:
    return np.asarray(samples, dtype="<i2").tobytes()


class Pcm16Test(unittest.TestCase):
    def test_scales_to_unit_floats(self) -> None:
        decoded = pcm16_to_float32(pcm16(0, 16_384, -32_768))
        self.assertTrue(np.allclose(decoded, [0.0, 0.5, -1.0]))

    def test_rejects_empty_and_odd_bodies(self) -> None:
        with self.assertRaises(AudioError):
            pcm16_to_float32(b"")
        with self.assertRaises(AudioError):
            pcm16_to_float32(b"\x00")


class WavTest(unittest.TestCase):
    def test_decodes_pcm16_wav(self) -> None:
        body = wav_body(pcm16(0, 32_767, -32_768))
        self.assertTrue(looks_like_wav(body))
        self.assertTrue(np.allclose(decode_audio(body), [0.0, 32_767 / 32_768, -1.0]))

    def test_decodes_float32_wav(self) -> None:
        samples = np.asarray([0.25, -0.5], dtype="<f4")
        self.assertTrue(np.allclose(decode_audio(wav_body(samples.tobytes(), fmt=3, bits=32)), samples))

    def test_decodes_wave_format_extensible(self) -> None:
        guid = struct.pack("<H", 1) + b"\x00" * 14  # the real format tag leads the SubFormat GUID
        fmt_chunk = struct.pack("<HHIIHHH", 0xFFFE, 1, 16_000, 32_000, 2, 16, 22)
        fmt_chunk += struct.pack("<HI", 16, 0) + guid  # validBits, channelMask, SubFormat
        payload = pcm16(16_384)
        chunks = b"fmt " + struct.pack("<I", len(fmt_chunk)) + fmt_chunk
        chunks += b"data" + struct.pack("<I", len(payload)) + payload
        body = b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks
        self.assertTrue(np.allclose(decode_audio(body), [0.5]))

    def test_skips_unknown_chunks(self) -> None:
        listing = b"LIST" + struct.pack("<I", 4) + b"INFO"
        body = wav_body(pcm16(1000), before_data=listing)
        self.assertEqual(decode_audio(body).shape, (1,))

    def test_rejects_wrong_sample_rate(self) -> None:
        with self.assertRaisesRegex(AudioError, "44100 Hz"):
            decode_audio(wav_body(pcm16(1), rate=44_100))

    def test_rejects_stereo(self) -> None:
        with self.assertRaisesRegex(AudioError, "2 channels"):
            decode_audio(wav_body(pcm16(1, 2), channels=2))

    def test_rejects_unsupported_sample_format(self) -> None:
        with self.assertRaisesRegex(AudioError, "unsupported WAV samples"):
            decode_audio(wav_body(bytes(4), bits=8))

    def test_rejects_missing_chunks(self) -> None:
        with self.assertRaisesRegex(AudioError, "missing its fmt or data chunk"):
            decode_audio(b"RIFF" + struct.pack("<I", 4) + b"WAVE")


class DetectionTest(unittest.TestCase):
    def test_raw_pcm_is_not_a_wav(self) -> None:
        self.assertFalse(looks_like_wav(pcm16(1, 2, 3)))
        self.assertTrue(np.allclose(decode_audio(pcm16(16_384)), [0.5]))
