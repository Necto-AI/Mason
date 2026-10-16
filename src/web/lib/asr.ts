/**
 * The dictation client: one multipart POST to the ASR service, plus the audio packing the browser owes it.
 *
 * The service is the official Phonon-2 container (ghcr.io/fermionresearch/phonon-cpu) running its
 * OpenAI-compatible server — a separate process on its own port, with `--cors` because the page calls it
 * cross-origin. Phonon-2 is the same Parakeet TDT v3 network the previous ONNX service ran, quantized to
 * ~2.1 bits; the audio contract is unchanged: 16 kHz mono, resampled in `mic.ts`. Same host as the page
 * unless `?asr=<host[:port]|url>` points somewhere else (a phone on the LAN talking to the dev box, say).
 */

export const SAMPLE_RATE = 16_000;
/** Where the service listens by default (the container maps port 8000). */
export const ASR_PORT = 8000;
/** The model the served endpoint must be; never silently transcribed by another. */
export const ASR_MODEL = "phonon-2";

/** Trim the trailing slash a URL override may carry, so `${url}/v1/...` never doubles it. */
function trimSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Where the service lives: the page's host on the ASR port, or the `?asr=` override (bare `host:port` allowed). */
export function asrServiceUrl(href: string, override: string | null): string {
	const trimmed = override?.trim() ?? "";
	if (trimmed !== "") {
		return trimSlash(/^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`);
	}
	const base = new URL(href);
	return `${base.protocol}//${base.hostname}:${ASR_PORT}`;
}

/** Scale float samples to PCM16, clamping anything past ±1.0 (a loud mic should clip, not wrap). */
export function floatToPcm16(samples: Float32Array): Int16Array {
	const pcm = new Int16Array(samples.length);
	for (let index = 0; index < samples.length; index += 1) {
		const sample = Math.max(-1, Math.min(1, samples[index]));
		pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
	}
	return pcm;
}

/** Wrap PCM16 in the smallest WAV a decoder will accept: 44-byte header, one `fmt `, one `data`. */
export function encodeWavPcm16(pcm: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(44 + pcm.length * 2);
	const view = new DataView(bytes.buffer);
	const ascii = (offset: number, text: string) => {
		for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + pcm.length * 2, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true); // PCM fmt chunk size
	view.setUint16(20, 1, true); // format: PCM
	view.setUint16(22, 1, true); // channels: mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	ascii(36, "data");
	view.setUint32(40, pcm.length * 2, true);
	for (let index = 0; index < pcm.length; index += 1) view.setInt16(44 + index * 2, pcm[index], true);
	return bytes;
}

/** Send the recorded samples and return the transcript. `endpoint` exists for tests; the page never passes it. */
export async function transcribe(
	samples: Float32Array,
	options: { readonly endpoint?: string; readonly signal?: AbortSignal } = {},
): Promise<{ readonly text: string }> {
	const base =
		options.endpoint ?? asrServiceUrl(window.location.href, new URLSearchParams(window.location.search).get("asr"));
	const url = `${base}/v1/audio/transcriptions`;
	const form = new FormData();
	form.append("file", new File([encodeWavPcm16(floatToPcm16(samples))], "recording.wav", { type: "audio/wav" }));
	form.append("model", ASR_MODEL);
	let response: Response;
	try {
		response = await fetch(url, { method: "POST", body: form, signal: options.signal });
	} catch (error) {
		throw new Error(
			`ASR service unreachable at ${new URL(url).host} (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	if (!response.ok) {
		// the OpenAI error envelope, or whatever the reverse proxy puts in the way
		const payload = (await response.json().catch(() => null)) as { error?: { message?: string } | string } | null;
		const message =
			typeof payload?.error === "object" ? payload.error.message : (payload?.error ?? undefined);
		throw new Error(message ?? `ASR service returned ${response.status}`);
	}
	const payload = (await response.json()) as { text?: string };
	if (typeof payload.text !== "string") throw new Error("ASR service returned no transcript text");
	return { text: payload.text };
}
