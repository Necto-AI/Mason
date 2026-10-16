"""Unit tests for the decoder loop, vocabulary loading, detokenization and word timings.

The joiner is faked with scripted logits, so the TDT frame-advance rules are pinned without the real ONNX
graphs. The end-to-end check (real graphs) runs only when ASR_MODELS points at a model directory.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from model import (  # noqa: E402
    ENCODER_DIM,
    FRAME_MS,
    PRED_HIDDEN,
    PRED_LAYERS,
    ParakeetTdt,
    _load_vocab,
    detokenize,
    words_from_tokens,
)

BLANK = 0


class FakeJoiner:
    """Scripted stand-in for the ONNX joiner: each entry picks the token and duration for one call."""

    def __init__(self, script: list[dict], vocab: int = 8) -> None:
        self.script = list(script)
        self.vocab = vocab
        self.calls: list[tuple[list[str], dict]] = []

    def run(self, names: list[str], feeds: dict) -> list[np.ndarray]:
        self.calls.append((list(names), feeds))
        entry = self.script.pop(0) if self.script else {"token": BLANK, "step": 0}
        flat = np.full(self.vocab + 5, -10.0, dtype=np.float32)
        flat[entry["token"]] = 10.0
        flat[self.vocab + entry["step"]] = 10.0
        logits = flat.reshape(1, 1, -1)
        stamp = np.float32(entry.get("stamp", 0.0))
        h = np.full((PRED_LAYERS, 1, PRED_HIDDEN), stamp, dtype=np.float32)
        c = np.full((PRED_LAYERS, 1, PRED_HIDDEN), -stamp, dtype=np.float32)
        return [logits, h, c]


def make_model(joiner: FakeJoiner, vocab: int = 8) -> ParakeetTdt:
    model = object.__new__(ParakeetTdt)  # decode-loop only: skip session construction
    model.joiner = joiner
    model.blank_id = BLANK
    model.vocab_size = vocab
    model.id2token = [f"t{index}" for index in range(vocab)]
    return model


def frames_of(count: int) -> np.ndarray:
    return np.zeros((count, ENCODER_DIM), dtype=np.float32)


class GreedyTdtTest(unittest.TestCase):
    def test_blank_advances_one_frame_and_keeps_state(self) -> None:
        joiner = FakeJoiner([{"token": BLANK, "step": 0}, {"token": 1, "step": 1}])
        ids, frames, steps = make_model(joiner)._greedy_tdt(frames_of(3))
        self.assertEqual(ids, [1])
        self.assertEqual(frames, [1])  # emitted on the second frame
        self.assertEqual(steps, [1])
        # First call carried the zero state and was not advanced by the blank; second call carried it too.
        first_feeds = joiner.calls[0][1]
        second_feeds = joiner.calls[1][1]
        self.assertTrue(np.all(first_feeds["input_states_1"] == 0))
        self.assertTrue(np.all(second_feeds["input_states_1"] == 0))
        self.assertEqual(int(second_feeds["targets"][0, 0]), BLANK)

    def test_duration_step_advances_and_state_follows_emission(self) -> None:
        joiner = FakeJoiner([{"token": 3, "step": 2, "stamp": 5.0}, {"token": BLANK, "step": 0}])
        ids, frames, steps = make_model(joiner)._greedy_tdt(frames_of(5))
        self.assertEqual(ids, [3])
        self.assertEqual(frames, [0])
        self.assertEqual(steps, [2])
        # State advanced on the emission: the next call carried h == 5, and its target was the emitted token.
        next_feeds = joiner.calls[1][1]
        self.assertTrue(np.all(next_feeds["input_states_1"] == 5.0))
        self.assertEqual(int(next_feeds["targets"][0, 0]), 3)

    def test_zero_step_emits_multiple_tokens_on_one_frame(self) -> None:
        joiner = FakeJoiner(
            [
                {"token": 1, "step": 0},
                {"token": 2, "step": 0},
                {"token": 4, "step": 1},
            ]
        )
        ids, frames, steps = make_model(joiner)._greedy_tdt(frames_of(3))
        self.assertEqual(ids, [1, 2, 4])
        self.assertEqual(frames, [0, 0, 0])  # stayed on the frame while step == 0
        self.assertEqual(steps, [0, 0, 1])

    def test_token_cap_advances_after_ten_tokens(self) -> None:
        script = [{"token": 15, "step": 0} for _ in range(11)] + [{"token": BLANK, "step": 0}]
        joiner = FakeJoiner(script, vocab=16)
        ids, frames, _ = make_model(joiner, vocab=16)._greedy_tdt(frames_of(3))
        self.assertEqual(len(ids), 11)
        self.assertEqual(frames[:10], [0] * 10)
        self.assertEqual(frames[10], 1)  # the cap forced an advance

    def test_contract_names_are_passed_to_the_joiner(self) -> None:
        joiner = FakeJoiner([{"token": BLANK, "step": 0}])
        make_model(joiner)._greedy_tdt(frames_of(1))
        names, feeds = joiner.calls[0]
        self.assertEqual(names, ["outputs", "output_states_1", "output_states_2"])
        self.assertEqual(
            set(feeds),
            {"encoder_outputs", "targets", "target_length", "input_states_1", "input_states_2"},
        )
        self.assertEqual(tuple(feeds["encoder_outputs"].shape), (1, ENCODER_DIM, 1))

    def test_rejects_wrong_encoder_dim(self) -> None:
        with self.assertRaises(ValueError):
            make_model(FakeJoiner([]))._greedy_tdt(np.zeros((4, 8), dtype=np.float32))


class VocabTest(unittest.TestCase):
    def _write(self, text: str) -> str:
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        path = Path(self._dir.name) / "vocab.txt"
        path.write_text(text, encoding="utf-8")
        return str(path)

    def test_loads_tokens_by_id_with_blanks_where_ids_are_missing(self) -> None:
        id2token, blank_id = _load_vocab(self._write("<blk> 0\r\n\u2581a 2\r\nb 1\r\n"))
        self.assertEqual(blank_id, 0)
        self.assertEqual(id2token, ["<blk>", "b", "\u2581a"])

    def test_requires_a_blank_token(self) -> None:
        with self.assertRaises(ValueError):
            _load_vocab(self._write("\u2581a 0\n"))


class DetokenizeTest(unittest.TestCase):
    def test_joins_subwords_and_turns_markers_into_spaces(self) -> None:
        self.assertEqual(detokenize(["\u2581Hello", "\u2581wor", "ld", "!"]), "Hello world!")

    def test_drops_special_tokens_and_collapses_spaces(self) -> None:
        self.assertEqual(detokenize(["\u2581a", "<unk>", "\u2581", "\u2581a"]), "a a")


class WordsTest(unittest.TestCase):
    def test_single_token_word_span_uses_the_duration_step(self) -> None:
        words = words_from_tokens(["\u2581hello"], [0], [2], total_frames=100)
        self.assertEqual(words, [{"text": "hello", "startMs": 0, "endMs": round(2 * FRAME_MS)}])

    def test_subwords_continue_the_open_word(self) -> None:
        words = words_from_tokens(["\u2581he", "llo", "\u2581world"], [1, 2, 3], [1, 1, 0], total_frames=100)
        self.assertEqual(
            words,
            [
                {"text": "hello", "startMs": 80, "endMs": 240},
                {"text": "world", "startMs": 240, "endMs": 320},
            ],
        )

    def test_end_is_clamped_to_the_last_encoder_frame(self) -> None:
        words = words_from_tokens(["\u2581end"], [99], [4], total_frames=100)
        self.assertEqual(words[0]["endMs"], 100 * FRAME_MS)

    def test_special_and_marker_only_tokens_do_not_open_words(self) -> None:
        words = words_from_tokens(["\u2581", "<blk>", "\u2581go"], [0, 1, 2], [1, 1, 1], total_frames=10)
        self.assertEqual(words, [{"text": "go", "startMs": 160, "endMs": 240}])


@unittest.skipUnless(os.environ.get("ASR_MODELS"), "set ASR_MODELS=<model dir> to run the ONNX end-to-end check")
class EndToEndTest(unittest.TestCase):
    """Real graphs: proves the tensor contract in the docstring still holds for silence and for a fixture."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.model = ParakeetTdt(os.environ["ASR_MODELS"], prefer_gpu=not os.environ.get("ASR_CPU"))

    def test_silence_decodes_to_an_empty_transcript(self) -> None:
        result = self.model.transcribe(np.zeros(16_000, dtype=np.float32))
        self.assertEqual(result.text, "")
        self.assertEqual(result.duration_s, 1.0)
        self.assertGreater(result.elapsed_s, 0.0)

    def test_warm_up_runs_a_second_of_silence(self) -> None:
        self.assertGreater(self.model.warm_up(), 0.0)

    def test_fixture_wav_transcribes(self) -> None:
        fixture = os.environ.get("ASR_TEST_WAV")
        if not fixture:
            self.skipTest("set ASR_TEST_WAV=<16 kHz mono wav> for a fixture check")
        from audio import decode_audio

        with open(fixture, "rb") as handle:
            result = self.model.transcribe(decode_audio(handle.read()))
        self.assertNotEqual(result.text, "")
        self.assertTrue(result.words and result.words[0]["text"])
        expected = os.path.splitext(fixture)[0] + ".txt"
        if os.path.exists(expected):
            with open(expected, encoding="utf-8") as handle:
                self.assertIn(handle.read().strip().lower(), result.text.lower())


if __name__ == "__main__":
    unittest.main()
