"""Parakeet TDT 0.6B v3 (multilingual) transcription on ONNX Runtime.

Fully ONNX inference pipeline — the three exported graphs drive everything, no
NeMo / PyTorch at runtime:

    waveforms -> nemo128.onnx (featurizer) -> encoder-model.*.onnx -> greedy TDT decode
                                                             via decoder_joint-model.*.onnx

Tensor contracts (verified against the `ysdede/parakeet-tdt-0.6b-v3-onnx` export):

  featurizer  nemo128.onnx
      in : waveforms      f32 [B, N]        raw mono PCM @ 16 kHz
           waveforms_lens i64 [B]
      out: features       f32 [B, 128, T]   log-mel
           features_lens  i64 [B]

  encoder     encoder-model.{int8,fp16,onnx}
      in : audio_signal   f32 [B, 128, T]
           length         i64 [B]           valid feature frames
      out: outputs        f32 [B, 1024, T'] encoder frames (channel-major)

  joiner      decoder_joint-model.{int8,fp16,onnx}   (decoder prediction net + joint + TDT head)
      in : encoder_outputs f32 [B, 1024, 1]  one frame at a time
           targets         i32 [B, U]        previous token id
           target_length   i32 [B]
           input_states_1  f32 [2, B, 640]   LSTM h  (2 layers x 640)
           input_states_2  f32 [2, B, 640]   LSTM c
      out: outputs         f32 [.., 8198]    = token logits[8193] ++ duration logits[5]
           output_states_1 f32 [2, B, 640]
           output_states_2 f32 [2, B, 640]
           prednet_lengths i32 [B]

  vocab.txt   "<token> <id>" per line (CRLF). blank = <blk>. Word-start marker U+2581 (▁).

The greedy TDT loop updates the LSTM state only on a non-blank emission and advances a
frame by the predicted duration (`step`), otherwise by one on blank / after 10 tokens on a
frame — matching the reference implementation. The decoder keeps its state explicit so the
same loop can later be driven chunk-by-chunk for streaming.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field

import numpy as np
import onnxruntime as ort

SAMPLE_RATE = 16_000
MEL_BINS = 128
ENCODER_DIM = 1024
PRED_HIDDEN = 640
PRED_LAYERS = 2
MAX_TOKENS_PER_STEP = 10
WORD_START = "\u2581"  # ▁
# One encoder frame is `subsampling` (8) mel hops of 10 ms — the reference's TIME_STRIDE.
FRAME_MS = 80.0

# Default ONNX file names per precision, relative to the model dir.
_ENCODER_FILES = {"int8": "encoder-model.int8.onnx", "fp16": "encoder-model.fp16.onnx", "fp32": "encoder-model.onnx"}
_DECODER_FILES = {"int8": "decoder_joint-model.int8.onnx", "fp16": "decoder_joint-model.fp16.onnx", "fp32": "decoder_joint-model.onnx"}
_FEATURIZER_FILE = "nemo128.onnx"
_VOCAB_FILE = "vocab.txt"


@dataclass
class AsrResult:
    text: str
    words: list[dict] = field(default_factory=list)
    tokens: list[str] = field(default_factory=list)
    token_ids: list[int] = field(default_factory=list)
    duration_s: float = 0.0
    elapsed_s: float = 0.0
    rtf: float = 0.0


def _providers(prefer_gpu: bool) -> list[str]:
    avail = set(ort.get_available_providers())
    if prefer_gpu and "CUDAExecutionProvider" in avail:
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


def _load_vocab(path: str) -> tuple[list[str], int]:
    id2token: list[str] = []
    blank_id = -1
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\r\n")
            if not line:
                continue
            token, _, id_str = line.rpartition(" ")
            idx = int(id_str)
            while len(id2token) <= idx:
                id2token.append("")
            id2token[idx] = token
            if token == "<blk>":
                blank_id = idx
    if blank_id < 0:
        raise ValueError(f"no <blk> blank token in {path}")
    return id2token, blank_id


class ParakeetTdt:
    """One loaded Parakeet TDT model: featurizer + encoder + joiner + vocab."""

    def __init__(
        self,
        model_dir: str,
        *,
        encoder_precision: str = "fp16",
        decoder_precision: str = "int8",
        prefer_gpu: bool = True,
    ) -> None:
        self.model_dir = model_dir
        self.id2token, self.blank_id = _load_vocab(os.path.join(model_dir, _VOCAB_FILE))
        self.vocab_size = len(self.id2token)

        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.providers = _providers(prefer_gpu)
        kw = {"sess_options": so, "providers": self.providers}

        self.featurizer = ort.InferenceSession(os.path.join(model_dir, _FEATURIZER_FILE), **kw)
        self.encoder = ort.InferenceSession(os.path.join(model_dir, _ENCODER_FILES[encoder_precision]), **kw)
        self.joiner = ort.InferenceSession(os.path.join(model_dir, _DECODER_FILES[decoder_precision]), **kw)

        # Fail loudly at load if a tensor name drifts from the verified contract.
        self._encoder_inputs = {i.name for i in self.encoder.get_inputs()}
        self._joiner_inputs = {i.name for i in self.joiner.get_inputs()}
        for name in ("audio_signal", "length"):
            if name not in self._encoder_inputs:
                raise ValueError(f"encoder missing input {name!r}; got {sorted(self._encoder_inputs)}")
        for name in ("encoder_outputs", "targets", "target_length", "input_states_1", "input_states_2"):
            if name not in self._joiner_inputs:
                raise ValueError(f"joiner missing input {name!r}; got {sorted(self._joiner_inputs)}")

    # -- pipeline ---------------------------------------------------------------

    def transcribe(self, wav: np.ndarray) -> AsrResult:
        t0 = time.perf_counter()
        wav = np.ascontiguousarray(wav, dtype=np.float32)
        feats, feat_len = self._features(wav)          # [1,128,T], [1]
        enc = self._encode(feats, feat_len)            # [T', 1024]
        ids, frames, steps = self._greedy_tdt(enc)
        elapsed = time.perf_counter() - t0

        tokens = [self.id2token[i] for i in ids]
        duration_s = wav.shape[0] / SAMPLE_RATE
        return AsrResult(
            text=detokenize(tokens),
            words=words_from_tokens(tokens, frames, steps, total_frames=enc.shape[0]),
            tokens=tokens,
            token_ids=ids,
            duration_s=duration_s,
            elapsed_s=elapsed,
            rtf=(elapsed / duration_s) if duration_s > 0 else 0.0,
        )

    def warm_up(self) -> float:
        """Push one second of silence through the graph, returning the seconds it took.

        The first inference pays CUDA context init and kernel selection; a service should pay it at startup,
        not on the user's first dictation (and a broken graph set fails here, loudly, rather than mid-request).
        """
        return self.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32)).elapsed_s

    def _features(self, wav: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        waveforms = wav[None, :]
        waveforms_lens = np.array([wav.shape[0]], dtype=np.int64)
        features, features_lens = self.featurizer.run(
            ["features", "features_lens"],
            {"waveforms": waveforms, "waveforms_lens": waveforms_lens},
        )
        return features.astype(np.float32), features_lens.astype(np.int64)

    def _encode(self, feats: np.ndarray, feat_len: np.ndarray) -> np.ndarray:
        outputs, = self.encoder.run(["outputs"], {"audio_signal": feats, "length": feat_len})
        # outputs: [1, 1024, T'] -> [T', 1024] (time-major, one 1024-dim frame per row)
        return np.ascontiguousarray(outputs[0].transpose(1, 0))

    def _greedy_tdt(self, enc: np.ndarray) -> tuple[list[int], list[int], list[int]]:
        """Greedy TDT decode over encoder frames.

        Returns the emitted token ids plus, per token, the frame it was emitted on and the predicted
        duration step — enough to reconstruct word timings. The LSTM state is kept explicit so the same
        loop can be driven chunk-by-chunk for streaming later.
        """
        enc_t, dim = enc.shape
        if dim != ENCODER_DIM:
            raise ValueError(f"encoder frame dim {dim} != {ENCODER_DIM}")

        state_shape = (PRED_LAYERS, 1, PRED_HIDDEN)
        h = np.zeros(state_shape, dtype=np.float32)  # LSTM h
        c = np.zeros(state_shape, dtype=np.float32)  # LSTM c

        ids: list[int] = []
        frames: list[int] = []
        steps: list[int] = []
        blank = self.blank_id
        vocab = self.vocab_size
        t = 0
        emitted = 0

        while t < enc_t:
            frame = enc[t].reshape(1, ENCODER_DIM, 1).astype(np.float32)
            prev = ids[-1] if ids else blank
            feeds = {
                "encoder_outputs": frame,
                "targets": np.array([[prev]], dtype=np.int32),
                "target_length": np.array([1], dtype=np.int32),
                "input_states_1": h,
                "input_states_2": c,
            }
            logits, new_h, new_c = self.joiner.run(
                ["outputs", "output_states_1", "output_states_2"], feeds
            )

            flat = np.asarray(logits).reshape(-1)
            token_logits = flat[:vocab]
            dur_logits = flat[vocab:]

            max_id = int(np.argmax(token_logits))
            step = int(np.argmax(dur_logits)) if dur_logits.size else 0

            if max_id != blank:
                ids.append(max_id)
                frames.append(t)
                steps.append(step)
                # State advances only on a non-blank emission (matches the reference).
                h, c = new_h, new_c
                emitted += 1

            # Frame advancement: TDT duration wins; else step by one on blank / token cap;
            # otherwise stay on the frame to emit more tokens (multi-token frames).
            if step > 0:
                t += step
                emitted = 0
            elif max_id == blank or emitted >= MAX_TOKENS_PER_STEP:
                t += 1
                emitted = 0

        return ids, frames, steps


def detokenize(tokens: list[str]) -> str:
    """SentencePiece-style detokenization: join subwords, ▁ -> space, collapse runs."""
    parts = [
        tok
        for tok in tokens
        if tok and not (tok.startswith("<") and tok.endswith(">"))
    ]
    text = "".join(parts).replace(WORD_START, " ")
    return " ".join(text.split())


def _is_special(tok: str) -> bool:
    return tok.startswith("<") and tok.endswith(">")


def words_from_tokens(
    tokens: list[str],
    frames: list[int],
    steps: list[int],
    *,
    total_frames: int,
) -> list[dict]:
    """Fold emitted tokens into words with millisecond spans (the reference's timestamp model).

    A token opens a word when it starts with ▁ (or is the first token); the word ends where the token's
    predicted duration puts it, clamped to the last encoder frame.
    """
    words: list[dict] = []
    for tok, frame, step in zip(tokens, frames, steps):
        if _is_special(tok):
            continue
        text = tok.replace(WORD_START, "")
        if text == "":
            continue
        end_frame = min(total_frames, frame + max(1, step))
        if tok.startswith(WORD_START) or not words:
            words.append({"text": text, "startMs": round(frame * FRAME_MS), "endMs": round(end_frame * FRAME_MS)})
        else:
            words[-1]["text"] += text
            words[-1]["endMs"] = round(end_frame * FRAME_MS)
    return words
