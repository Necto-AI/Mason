import assert from "node:assert/strict";
import { test } from "node:test";
import { ASR_PORT, asrServiceUrl, encodeWavPcm16, floatToPcm16, SAMPLE_RATE } from "../src/web/lib/asr.ts";
import {
	BAR_COUNT,
	BAR_MAX,
	BAR_MIN,
	barHeights,
	HOLD_MS,
	LEVEL_CEIL,
	LEVEL_FLOOR,
	MIN_MS,
	pressOutcome,
	releaseOutcome,
	worthTranscribing,
} from "../src/web/lib/dictation.ts";

// The pure part of dictation: where the service is found and what the bytes on the wire are. The microphone
// itself is the browser's and is not tested here — these are the two places the audio format could drift.

test("the service defaults to the page's own host, on its own port", () => {
	assert.equal(asrServiceUrl("http://localhost:8787/chat?debug=1", null), `http://localhost:${ASR_PORT}`);
	assert.equal(asrServiceUrl("https://agent.lan:8787/", null), `https://agent.lan:${ASR_PORT}`);
	assert.equal(asrServiceUrl("http://192.168.1.10:8787/", ""), `http://192.168.1.10:${ASR_PORT}`);
});

test("?asr= overrides the service, as a URL or a bare host:port", () => {
	assert.equal(asrServiceUrl("http://localhost:8787/", "http://192.168.1.10:9999"), "http://192.168.1.10:9999");
	assert.equal(asrServiceUrl("http://localhost:8787/", "pc:8788"), "http://pc:8788");
	assert.equal(asrServiceUrl("http://localhost:8787/", "https://asr.example.com/"), "https://asr.example.com");
	assert.equal(asrServiceUrl("http://localhost:8787/", "  pc:8788  "), "http://pc:8788");
});

test("the WAV header describes 16 kHz mono PCM16, with the payload sized into it", () => {
	const wav = encodeWavPcm16(Int16Array.from([0, 8192, -8192]));
	assert.equal(wav.length, 44 + 6);
	const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
	const ascii = (offset: number, length: number) => String.fromCharCode(...wav.subarray(offset, offset + length));
	assert.equal(ascii(0, 4), "RIFF");
	assert.equal(view.getUint32(4, true), 36 + 6);
	assert.equal(ascii(8, 4), "WAVE");
	assert.equal(ascii(12, 4), "fmt ");
	assert.equal(view.getUint32(16, true), 16);
	assert.equal(view.getUint16(20, true), 1);
	assert.equal(view.getUint16(22, true), 1);
	assert.equal(view.getUint32(24, true), SAMPLE_RATE);
	assert.equal(view.getUint32(28, true), SAMPLE_RATE * 2);
	assert.equal(view.getUint16(32, true), 2);
	assert.equal(view.getUint16(34, true), 16);
	assert.equal(ascii(36, 4), "data");
	assert.equal(view.getUint32(40, true), 6);
	assert.deepEqual([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)], [0, 8192, -8192]);
});

test("float samples clamp at the PCM16 rails instead of wrapping", () => {
	const pcm = floatToPcm16(Float32Array.from([0, 1, -1, 0.5, 2, -2]));
	assert.deepEqual(Array.from(pcm), [0, 32767, -32768, 16383, 32767, -32768]);
});

test("a silent recording encodes to a valid, empty-bodied WAV", () => {
	const wav = encodeWavPcm16(floatToPcm16(new Float32Array(0)));
	assert.equal(wav.length, 44);
	assert.equal(new DataView(wav.buffer).getUint32(40, true), 0);
});

test("a block's RMS maps onto the bar range, clamped at both rails", () => {
	const heights = barHeights([0, LEVEL_FLOOR, (LEVEL_FLOOR + LEVEL_CEIL) / 2, LEVEL_CEIL, 1], 5);
	const [silent, floor, mid, ceil, hot] = heights;
	assert.equal(silent, BAR_MIN); // below the floor: bottomed out, not vanished
	assert.equal(floor, BAR_MIN);
	assert.ok(mid > BAR_MIN && mid < BAR_MAX);
	assert.equal(ceil, BAR_MAX);
	assert.equal(hot, BAR_MAX); // above the ceiling: pegged, not overflowing
	// a louder block is never a shorter bar
	assert.ok(heights.every((h, i) => i === 0 || h >= heights[i - 1]));
});

test("the bars are the last levels, oldest first, padded on the left while history builds", () => {
	assert.equal(BAR_COUNT, 5);
	assert.deepEqual(
		barHeights([], BAR_COUNT),
		Array.from({ length: BAR_COUNT }, () => BAR_MIN),
	);
	// one loud block appears as the rightmost bar; the rest are still resting dots
	const grown = barHeights([LEVEL_CEIL], BAR_COUNT);
	assert.deepEqual(
		grown.slice(0, BAR_COUNT - 1),
		Array.from({ length: BAR_COUNT - 1 }, () => BAR_MIN),
	);
	assert.equal(grown[BAR_COUNT - 1], BAR_MAX);
	// history longer than the bars: only the newest survive, order preserved
	const scrolled = barHeights([0, LEVEL_CEIL, 0, LEVEL_CEIL, 0, LEVEL_CEIL], BAR_COUNT);
	assert.deepEqual(scrolled, [BAR_MAX, BAR_MIN, BAR_MAX, BAR_MIN, BAR_MAX]);
});

test("a press starts, stops a latched recording, and does nothing while transcribing", () => {
	assert.equal(pressOutcome("idle", false), "start");
	assert.equal(pressOutcome("recording", true), "stop");
	assert.equal(pressOutcome("recording", false), "ignore"); // a hold is in flight; its release decides
	assert.equal(pressOutcome("transcribing", false), "ignore");
	assert.equal(pressOutcome("transcribing", true), "ignore");
});

test("a quick release latches the recording; a hold is push-to-talk", () => {
	assert.equal(releaseOutcome(0), "latch");
	assert.equal(releaseOutcome(HOLD_MS - 1), "latch");
	assert.equal(releaseOutcome(HOLD_MS), "talk");
	assert.equal(releaseOutcome(2500), "talk");
});

test("a recording below the slip threshold is dropped instead of sent", () => {
	assert.equal(worthTranscribing(MIN_MS - 1), false);
	assert.equal(worthTranscribing(MIN_MS), true);
});
