"""Audio input for the ASR service: whatever a phone or a browser sent, as float32 mono @ 16 kHz.

Exactly one sample rate for the whole path: the parakeet mel frontend is calibrated to 16 kHz, so input that is not
16 kHz mono is resampled and downmixed on the way in and is never handed to the model as it arrived.

Four ways in, and the order is the point:

  * **WAV (RIFF)** — PCM16 or IEEE-float32, 16 kHz, mono — parsed in-process. Anything else in a WAV is rejected
    loudly (44100 Hz, two channels, 8-bit samples): resampling a WAV is the client's job, and the message says so.
  * **A container ffmpeg can name** — Ogg (what a phone records a voice note in), MP3, M4A/MP4, WebM, FLAC, AMR,
    anything else ffmpeg demuxes — decoded by `ffmpeg` into 16 kHz mono s16le on stdout, whatever the request called
    it. `application/octet-stream` on an Ogg body is a client being vague, not a claim about samples.
  * **Headerless PCM16** little-endian, 16 kHz, mono — in-process, and only when the request declares it
    (`PCM16_CONTENT_TYPES`), because bytes that say nothing about themselves are not evidence of PCM16. Reading
    them as samples anyway is what turned a Telegram voice note into an empty transcript.
  * **A `multipart/form-data` body** — unwrapped here, so a relay that posts a form and one that posts the file's
    bytes reach the same decoder. The part's own type is what decides, never the envelope's.

A body nothing can decode is an `AudioError` naming what it looked like. It is never a zero-length decode, and it is
never an empty transcript.
"""

from __future__ import annotations

import shutil
import subprocess
from email import policy as email_policy
from email.parser import BytesParser

import numpy as np

SAMPLE_RATE = 16_000

#: The content types that say "these bytes are PCM16 samples rather than a container". Deliberately narrow: a type
#: that names a container (`audio/ogg`, `audio/mpeg`, `audio/wav`, `video/mp4`) is not in here, and neither is an
#: absent one, so the default for a body nobody described is ffmpeg's judgement rather than a guess at samples.
PCM16_CONTENT_TYPES = frozenset(
    {
        "application/octet-stream",
        "audio/pcm",
        "audio/l16",
        "audio/raw",
        "audio/x-pcm",
        "audio/x-raw",
    }
)

#: The decoder for everything else. Present in the image (`asr/Dockerfile` installs it); a host without it can still
#: serve WAV and declared PCM16, and says which of the two it is missing when it cannot.
FFMPEG = "ffmpeg"

#: How long ffmpeg may chew on one body before the request is refused. Decoding runs hundreds of times faster than
#: realtime, so this is only ever reached by a pathological file — and the bound has to exist, because a subprocess
#: outlives the request that started it.
FFMPEG_TIMEOUT_S = 30.0

#: The most audio one body is worth: 15 minutes of speech, 28.8 MB of samples. The upload cap bounds the *bytes in*,
#: and compressed speech is around a kilobyte a second, so a body at the cap could be eight hours long and a gigabyte
#: of samples once decoded. ffmpeg stops writing at this point and the transcript is of the first fifteen minutes.
FFMPEG_MAX_SECONDS = 15 * 60

#: What a form field holding the audio is called, after the one thing every transcription client has in common.
_AUDIO_PART_NAMES = frozenset({"file", "audio", "data", "recording", "media"})


class AudioError(ValueError):
    """The body is not decodable as 16 kHz mono audio; the message is safe to show a client."""


def looks_like_wav(body: bytes) -> bool:
    return len(body) >= 12 and body[0:4] == b"RIFF" and body[8:12] == b"WAVE"


def describe_format(body: bytes) -> str:
    """What the body looks like, in the few words a failure message needs.

    Only the container is named, never the codec inside it: an Ogg file from a phone is Opus and one from a desktop
    may be Vorbis, and a message whose point is "this did not decode" gains nothing from being wrong about which.
    """
    head = body[:12]
    if head.startswith(b"OggS"):
        return "Ogg"
    if head.startswith(b"fLaC"):
        return "FLAC"
    if head.startswith(b"ID3"):
        return "MP3"
    if head.startswith(b"caff"):
        return "CAF"
    if head.startswith(b"#!AMR"):
        return "AMR"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "WebM/Matroska"
    if head.startswith(b"\x30\x26\xb2\x75"):
        return "ASF/WMA"
    if head.startswith(b"wvpk"):
        return "WavPack"
    if head.startswith(b"FORM") and head[8:12] == b"AIFF":
        return "AIFF"
    if head[4:8] == b"ftyp":
        return "MP4/M4A"
    # Deliberately absent: the two-byte MPEG frame sync (0xFF 0xE0). It is not a signature — a PCM16 body whose first
    # sample is negative starts that way — and the choice it would force is between believing a client that declared
    # `application/octet-stream` and believing a guess. An MP3 with no ID3 tag is either declared as what it is
    # (`audio/mpeg`, which goes to ffmpeg regardless) or it is a client that described its own body wrongly.
    return "unrecognised"


def decode_audio(body: bytes, *, content_type: str | None = None) -> np.ndarray:
    """Decode a request body to float32 mono samples at 16 kHz, in [-1, 1].

    `content_type` is the request's `Content-Type`, and it decides exactly one thing: whether a body that carries no
    signature of its own is headerless PCM16. A WAV is a WAV whatever the request said, and a container we can name
    goes to ffmpeg whatever the request said.
    """
    if _media_type(content_type) == "multipart/form-data":
        body, content_type = _unwrap_multipart(body, content_type or "")
    if looks_like_wav(body):
        return _parse_wav(body)
    if describe_format(body) != "unrecognised":
        return ffmpeg_to_float32(body, content_type=content_type)
    if _media_type(content_type) in PCM16_CONTENT_TYPES:
        return pcm16_to_float32(body)
    return ffmpeg_to_float32(body, content_type=content_type)


def pcm16_to_float32(body: bytes) -> np.ndarray:
    if len(body) == 0:
        raise AudioError("empty audio body")
    if len(body) % 2 != 0:
        raise AudioError(f"PCM16 body has an odd length ({len(body)} bytes)")
    samples = np.frombuffer(body, dtype="<i2").astype(np.float32)
    return samples / 32768.0


def ffmpeg_to_float32(body: bytes, *, content_type: str | None = None) -> np.ndarray:
    """Decode anything ffmpeg reads into float32 mono @ 16 kHz, or raise `AudioError` naming what it looked like."""
    if len(body) == 0:
        raise AudioError("empty audio body")
    label = _label(body, content_type)
    executable = shutil.which(FFMPEG)
    if executable is None:
        raise AudioError(
            f"cannot decode the {label}: ffmpeg is not installed, so only WAV and declared PCM16 can be read"
        )
    argv = [
        executable,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",  # the body goes in on stdin: nothing is written to disk, so nothing has to be cleaned up
        "-map",
        "0:a:0",  # the first audio stream; a video note or a video file is still speech in track 0:a:0
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-t",
        str(FFMPEG_MAX_SECONDS),
        "pipe:1",
    ]
    try:
        completed = subprocess.run(
            argv,
            input=body,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=FFMPEG_TIMEOUT_S,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise AudioError(f"decoding the {label} took longer than {FFMPEG_TIMEOUT_S:.0f}s") from None
    if completed.returncode != 0:
        raise AudioError(f"could not decode the {label}: {_last_line(completed.stderr)}")
    samples = np.frombuffer(completed.stdout, dtype="<i2").astype(np.float32) / 32768.0
    if samples.size == 0:
        # ffmpeg was happy and produced nothing: an Ogg with no audio stream, an empty stream, a body of pure junk it
        # guessed at. Either way there are no samples, and a transcript of no samples is the empty answer this whole
        # path exists to refuse.
        raise AudioError(f"the {label} decoded to no audio")
    return samples


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


def _media_type(content_type: str | None) -> str:
    """The type without its parameters, lowercased: `Multipart/Form-Data; boundary=x` -> `multipart/form-data`."""
    return (content_type or "").split(";", 1)[0].strip().lower()


def _label(body: bytes, content_type: str | None) -> str:
    """What to call the body in a message: its container, its declared type, or plainly that we cannot tell."""
    named = describe_format(body)
    if named != "unrecognised":
        return named
    declared = _media_type(content_type)
    if declared not in ("", "application/octet-stream"):
        return f"{declared} body"
    return "unrecognised audio"


def _last_line(stderr: bytes) -> str:
    """ffmpeg's last line of complaint, which is the one that names the problem, cut to something a client can read."""
    lines = [line.strip() for line in stderr.decode("utf-8", "replace").splitlines() if line.strip()]
    return (lines[-1] if lines else "ffmpeg refused the body")[:300]


def _unwrap_multipart(body: bytes, content_type: str) -> tuple[bytes, str | None]:
    """The audio part of a `multipart/form-data` body, and the type that part declared for itself.

    A relay that speaks a form is not a second contract: the same bytes are in there, one parsing step further out.
    The part's own `Content-Type` comes back with its bytes, because `application/octet-stream` on the envelope must
    not decide anything about samples the envelope never held.
    """
    envelope = b"Content-Type: " + content_type.encode("latin-1", "replace") + b"\r\nMIME-Version: 1.0\r\n\r\n"
    try:
        message = BytesParser(policy=email_policy.default).parsebytes(envelope + body)
        parts = [part for part in message.iter_parts() if not part.is_multipart()] if message.is_multipart() else []
    except Exception:  # noqa: BLE001 — the parser raises one class per flavour of malformed; all are the client's fault
        parts = []
    if not parts:
        raise AudioError(f"multipart body could not be parsed ({content_type})")
    chosen = (
        next((part for part in parts if part.get_filename() is not None), None)
        or next(
            (part for part in parts if part.get_param("name", header="content-disposition") in _AUDIO_PART_NAMES),
            None,
        )
        or next((part for part in parts if part.get_content_maintype() != "text"), None)
        or parts[0]
    )
    payload = chosen.get_payload(decode=True)
    if not isinstance(payload, bytes) or not payload:
        raise AudioError("multipart body's audio part is empty")
    return payload, chosen.get_content_type()
