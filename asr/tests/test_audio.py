"""Unit tests for the audio decoder: WAV parsing, raw PCM16, the ffmpeg path, and the loud rejections."""

from __future__ import annotations

import functools
import shutil
import struct
import subprocess
import sys
import unittest
import unittest.mock
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import audio  # noqa: E402
from audio import AudioError, decode_audio, describe_format, looks_like_wav, pcm16_to_float32  # noqa: E402

FFMPEG = shutil.which("ffmpeg")
requires_ffmpeg = unittest.skipUnless(
    FFMPEG is not None,
    "ffmpeg is not installed: only WAV and declared PCM16 can be decoded without it",
)

BOUNDARY = "mason-asr-test"


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


@functools.lru_cache(maxsize=None)
def ogg_opus(seconds: float) -> bytes:
    """A real Ogg/Opus body — the container a phone records a voice note in — encoded by ffmpeg as the test runs.

    Generated rather than committed: a binary fixture in git is a blob nobody reviews, and what is under test is this
    service's invocation of ffmpeg, not ffmpeg's conformance. Called only under `requires_ffmpeg`.
    """
    completed = subprocess.run(
        [
            FFMPEG,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:sample_rate=48000:duration={seconds}",
            "-ac",
            "1",
            "-c:a",
            "libopus",
            "-b:a",
            "16k",
            "-f",
            "ogg",
            "pipe:1",
        ],
        capture_output=True,
        stdin=subprocess.DEVNULL,  # nothing in the suite waits on a terminal: `-nostdin` and a closed stdin both
        check=True,
        timeout=60,
    )
    return completed.stdout


def multipart(audio_bytes: bytes, *, content_type: str = "audio/ogg", filename: str = "voice-u41.ogg") -> bytes:
    """The envelope the Telegram relay posts: one `file` part, the audio's own type on the part."""
    return (
        f"--{BOUNDARY}\r\n".encode()
        + f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode()
        + f"Content-Type: {content_type}\r\n\r\n".encode()
        + audio_bytes
        + f"\r\n--{BOUNDARY}--\r\n".encode()
    )


FORM_TYPE = f"multipart/form-data; boundary={BOUNDARY}"


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

    def test_a_wav_is_a_wav_whatever_the_request_declares(self) -> None:
        # the relay posts Ogg and the browser posts WAV; neither needs to be believed about the other
        body = wav_body(pcm16(16_384))
        self.assertTrue(np.allclose(decode_audio(body, content_type="application/octet-stream"), [0.5]))


class Pcm16DeclarationTest(unittest.TestCase):
    """Headerless PCM16 is read in-process, and only when the request says that is what it is."""

    def test_declared_pcm16_takes_the_fast_path(self) -> None:
        self.assertTrue(np.allclose(decode_audio(pcm16(16_384), content_type="application/octet-stream"), [0.5]))
        self.assertTrue(np.allclose(decode_audio(pcm16(16_384), content_type="audio/pcm"), [0.5]))

    def test_pcm16_with_no_declaration_is_not_guessed_at(self) -> None:
        # a whole number of samples is not evidence of samples: that guess is what turned a voice note into silence
        with self.assertRaises(AudioError):
            decode_audio(pcm16(16_384))

    def test_a_declared_body_is_believed_even_when_it_starts_like_a_frame(self) -> None:
        # 0xFF 0xFF is -1 as PCM16 and also the first two bytes of an MPEG frame sync: the declaration is the tiebreak
        self.assertTrue(np.allclose(decode_audio(pcm16(-1, -1, -1), content_type="application/octet-stream"), [-1 / 32768]))


class FormatTest(unittest.TestCase):
    def test_names_the_containers_a_phone_or_a_desktop_sends(self) -> None:
        self.assertEqual(describe_format(b"OggS" + bytes(40)), "Ogg")
        self.assertEqual(describe_format(b"fLaC" + bytes(40)), "FLAC")
        self.assertEqual(describe_format(b"ID3" + bytes(40)), "MP3")
        self.assertEqual(describe_format(bytes(4) + b"ftypM4A " + bytes(32)), "MP4/M4A")
        self.assertEqual(describe_format(b"\x1a\x45\xdf\xa3" + bytes(40)), "WebM/Matroska")
        self.assertEqual(describe_format(pcm16(1, 2)), "unrecognised")


class FfmpegTest(unittest.TestCase):
    """Everything that is not WAV or declared PCM16 is ffmpeg's, and a body it cannot read is an error."""

    @requires_ffmpeg
    def test_decodes_ogg_opus_to_sixteen_kilohertz_mono(self) -> None:
        body = ogg_opus(1.0)
        self.assertEqual(describe_format(body), "Ogg")
        decoded = decode_audio(body, content_type="audio/ogg")
        self.assertEqual(decoded.dtype, np.float32)
        # one second of 48 kHz Opus as 16 kHz mono: 16 000 samples, less whatever the encoder's priming trims
        self.assertAlmostEqual(decoded.size / 16_000, 1.0, delta=0.05)
        self.assertGreater(float(np.abs(decoded).max()), 0.01)  # a 440 Hz sine, not silence

    @requires_ffmpeg
    def test_a_container_decodes_whatever_the_request_calls_it(self) -> None:
        # the relay sends audio/ogg, but a form part typed application/octet-stream must not change the bytes' meaning
        decoded = decode_audio(ogg_opus(0.5), content_type="application/octet-stream")
        self.assertAlmostEqual(decoded.size / 16_000, 0.5, delta=0.05)

    @requires_ffmpeg
    def test_unwraps_a_multipart_form(self) -> None:
        decoded = decode_audio(multipart(ogg_opus(0.5)), content_type=FORM_TYPE)
        self.assertAlmostEqual(decoded.size / 16_000, 0.5, delta=0.05)

    @requires_ffmpeg
    def test_a_form_with_no_audio_part_is_an_error(self) -> None:
        with self.assertRaisesRegex(AudioError, "multipart"):
            decode_audio(b"--x--\r\n", content_type="multipart/form-data; boundary=x")

    @requires_ffmpeg
    def test_a_container_ffmpeg_cannot_read_names_that_container(self) -> None:
        with self.assertRaisesRegex(AudioError, "Ogg"):
            decode_audio(b"OggS" + bytes(40), content_type="audio/ogg")

    def test_garbage_is_refused_rather_than_transcribed_as_silence(self) -> None:
        with self.assertRaises(AudioError) as caught:
            decode_audio(b"this is not audio, and it is not PCM16 either" * 40)
        self.assertIn("unrecognised audio", str(caught.exception))

    @requires_ffmpeg
    def test_an_empty_body_is_an_error(self) -> None:
        with self.assertRaisesRegex(AudioError, "empty audio body"):
            decode_audio(b"")

    @requires_ffmpeg
    def test_the_output_is_cut_at_the_duration_bound(self) -> None:
        # 2 s of speech, a 0.5 s bound: compressed input is cheap and decoded samples are not, so the bound is the
        # one that keeps a long upload from becoming a gigabyte of float32
        with unittest.mock.patch.object(audio, "FFMPEG_MAX_SECONDS", 0.5):
            decoded = decode_audio(ogg_opus(2.0), content_type="audio/ogg")
        self.assertAlmostEqual(decoded.size / 16_000, 0.5, delta=0.05)


class DetectionTest(unittest.TestCase):
    def test_raw_pcm_is_not_a_wav(self) -> None:
        self.assertFalse(looks_like_wav(pcm16(1, 2, 3)))
        self.assertTrue(np.allclose(decode_audio(pcm16(16_384), content_type="application/octet-stream"), [0.5]))


if __name__ == "__main__":
    unittest.main()
