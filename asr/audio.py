"""Audio input for the ASR service: WAV containers and headerless PCM16, to float32 mono @ 16 kHz.

Exactly one sample rate for the whole path: the parakeet mel frontend is calibrated to 16 kHz, and the
browser client resamples before upload. Anything else is rejected loudly rather than silently decoded as
garbage. Stereo is rejected too — the client downmixes, so a stereo upload is a bug worth surfacing.

Accepted bodies:
  * WAV (RIFF): PCM16 or IEEE-float32 samples, 16 kHz, mono.
  * Headerless PCM16 little-endian, 16 kHz, mono (convenient for curl and simple clients).
"""

from __future__ import annotations

import numpy as np

SAMPLE_RATE = 16_000


class AudioError(ValueError):
    """The body is not decodable as 16 kHz mono audio; the message is safe to show a client."""


def looks_like_wav(body: bytes) -> bool:
    return len(body) >= 12 and body[0:4] == b"RIFF" and body[8:12] == b"WAVE"


def decode_audio(body: bytes) -> np.ndarray:
    """Decode a request body to float32 mono samples at 16 kHz, in [-1, 1]."""
    if looks_like_wav(body):
        return _parse_wav(body)
    return pcm16_to_float32(body)


def pcm16_to_float32(body: bytes) -> np.ndarray:
    if len(body) == 0:
        raise AudioError("empty audio body")
    if len(body) % 2 != 0:
        raise AudioError(f"PCM16 body has an odd length ({len(body)} bytes)")
    samples = np.frombuffer(body, dtype="<i2").astype(np.float32)
    return samples / 32768.0


def _parse_wav(body: bytes) -> np.ndarray:
    fmt = None
    data = None
    offset = 12
    while offset + 8 <= len(body):
        chunk_id = body[offset : offset + 4]
        size = int.from_bytes(body[offset + 4 : offset + 8], "little")
        chunk = body[offset + 8 : offset + 8 + size]
        if chunk_id == b"fmt ":
            fmt = chunk
        elif chunk_id == b"data":
            data = chunk
        offset += 8 + size + (size % 2)  # chunks are word-aligned
    if fmt is None or data is None:
        raise AudioError("WAV body is missing its fmt or data chunk")
    if len(fmt) < 16:
        raise AudioError("WAV fmt chunk is truncated")

    audio_format, channels, sample_rate, _, _, bits = (
        int.from_bytes(fmt[0:2], "little"),
        int.from_bytes(fmt[2:4], "little"),
        int.from_bytes(fmt[4:8], "little"),
        int.from_bytes(fmt[8:12], "little"),
        int.from_bytes(fmt[12:14], "little"),
        int.from_bytes(fmt[14:16], "little"),
    )
    if audio_format == 0xFFFE and len(fmt) >= 26:  # WAVE_FORMAT_EXTENSIBLE: the real tag leads the GUID
        audio_format = int.from_bytes(fmt[24:26], "little")

    if channels != 1:
        raise AudioError(f"WAV has {channels} channels; the service takes mono (downmix first)")
    if sample_rate != SAMPLE_RATE:
        raise AudioError(f"WAV is {sample_rate} Hz; the service takes {SAMPLE_RATE} Hz (resample first)")
    if audio_format == 1 and bits == 16:
        return pcm16_to_float32(data)
    if audio_format == 3 and bits == 32:
        if len(data) % 4 != 0:
            raise AudioError("float32 WAV data chunk is not a whole number of samples")
        return np.frombuffer(data, dtype="<f4").astype(np.float32)
    raise AudioError(f"unsupported WAV samples: format {audio_format}, {bits} bits (want PCM16 or float32)")
