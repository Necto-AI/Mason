/**
 * Microphone capture for dictation: press-to-talk in, 16 kHz mono out.
 *
 * Capture runs at whatever rate the context and device give (48 kHz on most desktops) because asking the context
 * for 16 kHz is not reliably honoured across browsers; the resample happens once, at the end, through an
 * `OfflineAudioContext` — exact and free of hand-rolled filters. The samples are tapped by an `AudioWorklet` so
 * the audio thread never waits on the main one; its source is a string because a worklet must be its own module,
 * and a blob URL keeps the bundler out of it. The worklet flushes its partial block on stop: dictation ends when
 * the speaker stops, and the last word should not lose its tail to a block boundary.
 */

import { SAMPLE_RATE } from "./asr.ts";

/** The tap: buffers whole blocks (4096 samples ≈ 85 ms at 48 kHz) and flushes the tail on request. */
const TAP_SOURCE = `
const BLOCK = 4096;

class MicTap extends AudioWorkletProcessor {
	constructor() {
		super();
		this._buffer = new Float32Array(BLOCK);
		this._filled = 0;
		this.port.onmessage = (event) => {
			if (event.data !== null && event.data !== undefined && event.data.flush === true) {
				this._flush();
				this.port.postMessage({ flushed: true });
			}
		};
	}

	_flush() {
		if (this._filled === 0) return;
		const samples = this._buffer.slice(0, this._filled);
		this._filled = 0;
		this.port.postMessage({ samples }, [samples.buffer]);
	}

	process(inputs) {
		const channel = inputs[0] !== undefined ? inputs[0][0] : undefined;
		if (channel === undefined) return true;
		let offset = 0;
		while (offset < channel.length) {
			const take = Math.min(BLOCK - this._filled, channel.length - offset);
			this._buffer.set(channel.subarray(offset, offset + take), this._filled);
			this._filled += take;
			offset += take;
			if (this._filled === BLOCK) this._flush();
		}
		return true;
	}
}

registerProcessor("pda-mic-tap", MicTap);
`;

export interface Recording {
	/** Stops capture and resolves the recorded audio, mono at 16 kHz. Idempotent. */
	stop(): Promise<Float32Array>;
	/** Stops capture and drops the audio. */
	cancel(): void;
}

function join(chunks: readonly Float32Array[]): Float32Array<ArrayBuffer> {
	let length = 0;
	for (const chunk of chunks) length += chunk.length;
	const samples = new Float32Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		samples.set(chunk, offset);
		offset += chunk.length;
	}
	return samples;
}

async function resampleTo16k(samples: Float32Array<ArrayBuffer>, sourceRate: number): Promise<Float32Array<ArrayBuffer>> {
	if (sourceRate === SAMPLE_RATE || samples.length === 0) return samples;
	const length = Math.max(1, Math.round((samples.length * SAMPLE_RATE) / sourceRate));
	const offline = new OfflineAudioContext(1, length, SAMPLE_RATE);
	const buffer = offline.createBuffer(1, samples.length, sourceRate);
	buffer.copyToChannel(samples, 0);
	const node = offline.createBufferSource();
	node.buffer = buffer;
	node.connect(offline.destination);
	node.start();
	const rendered = await offline.startRendering();
	return rendered.getChannelData(0).slice();
}

export async function startRecording(): Promise<Recording> {
	const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
	const chunks: Float32Array[] = [];
	let context: AudioContext;
	try {
		context = new AudioContext();
	} catch (error) {
		for (const track of stream.getTracks()) track.stop();
		throw error;
	}

	let tap: AudioWorkletNode | null = null;
	let source: MediaStreamAudioSourceNode | null = null;
	let resolveFlush: (() => void) | null = null;
	let closed = false;

	const teardown = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		if (tap !== null) {
			tap.port.onmessage = null;
			tap.disconnect();
		}
		source?.disconnect();
		for (const track of stream.getTracks()) track.stop();
		await context.close();
	};

	/** Ask the tap for its partial block; a dead worklet must not hang the release. */
	const flushTap = (): Promise<void> =>
		new Promise((resolve) => {
			if (tap === null) {
				resolve();
				return;
			}
			const timer = setTimeout(resolve, 100);
			resolveFlush = () => {
				clearTimeout(timer);
				resolve();
			};
			tap.port.postMessage({ flush: true });
		});

	try {
		const moduleUrl = URL.createObjectURL(new Blob([TAP_SOURCE], { type: "text/javascript" }));
		try {
			await context.audioWorklet.addModule(moduleUrl);
		} finally {
			URL.revokeObjectURL(moduleUrl);
		}
		if (context.state === "suspended") await context.resume();

		source = context.createMediaStreamSource(stream);
		tap = new AudioWorkletNode(context, "pda-mic-tap");
		tap.port.onmessage = (event: MessageEvent<unknown>) => {
			const message = event.data as { samples?: Float32Array; flushed?: boolean };
			if (message.samples !== undefined) chunks.push(message.samples);
			if (message.flushed === true && resolveFlush !== null) {
				const resolve = resolveFlush;
				resolveFlush = null;
				resolve();
			}
		};
		// The tap has to reach the destination to be pulled, but monitoring the mic is feedback: a zero gain.
		const sink = context.createGain();
		sink.gain.value = 0;
		source.connect(tap);
		tap.connect(sink);
		sink.connect(context.destination);

		const sampleRate = context.sampleRate;
		let stopping: Promise<Float32Array> | null = null;
		const stop = (): Promise<Float32Array> => {
			if (stopping === null) {
				stopping = (async () => {
					await flushTap();
					await teardown();
					const joined = join(chunks);
					return sampleRate === SAMPLE_RATE ? joined : resampleTo16k(joined, sampleRate);
				})();
			}
			return stopping;
		};
		return { stop, cancel: () => void teardown() };
	} catch (error) {
		await teardown();
		throw error;
	}
}
