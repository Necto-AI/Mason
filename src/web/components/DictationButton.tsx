/**
 * Hold-to-talk dictation: press and hold the mic while speaking, release to transcribe. The composer owns the
 * textarea and receives the words; this button owns only the press, the microphone and the wait.
 *
 * A press shorter than `MIN_MS` is a mis-click, not an utterance: it is dropped without a request, so a stray
 * tap never costs a round trip. The button reports failures instead of swallowing them — a denied microphone or
 * an ASR service that is not running is exactly the thing the reader needs to be told.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { transcribe } from "../lib/asr.ts";
import { startRecording, type Recording } from "../lib/mic.ts";

export interface DictationButtonProps {
	readonly onTranscript: (text: string) => void;
	readonly onError: (message: string) => void;
	readonly disabled?: boolean;
}

/** Below this a press is a mis-click. */
const MIN_MS = 300;

type Phase = "idle" | "recording" | "transcribing";

function describe(error: unknown): string {
	if (error instanceof DOMException) {
		if (error.name === "NotAllowedError") return "Microphone permission denied";
		if (error.name === "NotFoundError") return "No microphone found";
	}
	return error instanceof Error ? error.message : String(error);
}

export function DictationButton({ onTranscript, onError, disabled = false }: DictationButtonProps) {
	const [phase, setPhase] = useState<Phase>("idle");
	const arming = useRef<Promise<Recording> | null>(null);
	const startedAt = useRef(0);
	const held = useRef(false);

	const finish = useCallback(
		async (cancel: boolean) => {
			held.current = false;
			const pending = arming.current;
			if (pending === null) return;
			arming.current = null;
			let recording: Recording;
			try {
				recording = await pending;
			} catch (error) {
				onError(describe(error));
				setPhase("idle");
				return;
			}
			if (cancel || Date.now() - startedAt.current < MIN_MS) {
				recording.cancel();
				setPhase("idle");
				return;
			}
			setPhase("transcribing");
			try {
				const result = await transcribe(await recording.stop());
				const text = result.text.trim();
				if (text !== "") onTranscript(text);
			} catch (error) {
				onError(describe(error));
			} finally {
				setPhase("idle");
			}
		},
		[onError, onTranscript],
	);

	const start = useCallback(() => {
		if (disabled || arming.current !== null) return;
		startedAt.current = Date.now();
		held.current = true;
		setPhase("recording");
		const pending = startRecording();
		arming.current = pending;
		pending.catch(() => {
			// the rejection is reported by finish(); this keeps it handled if the press outlives the failure
		});
	}, [disabled]);

	// A button that disappears mid-press (session switch, re-render) must not leave the mic open.
	useEffect(
		() => () => {
			const pending = arming.current;
			arming.current = null;
			if (pending !== null) void pending.then((recording) => recording.cancel()).catch(() => {});
		},
		[],
	);

	return (
		<button
			type="button"
			className="composer-mic"
			data-testid="dictation"
			data-state={phase}
			title={phase === "recording" ? "Release to transcribe" : phase === "transcribing" ? "Transcribing…" : "Hold to dictate"}
			aria-label="Hold to dictate"
			disabled={disabled}
			onPointerDown={(event) => {
				if (disabled || phase === "transcribing") return;
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				start();
			}}
			onPointerUp={() => {
				if (held.current) void finish(false);
			}}
			onPointerCancel={() => {
				if (held.current) void finish(true);
			}}
			onLostPointerCapture={() => {
				if (held.current) void finish(false);
			}}
			onKeyDown={(event) => {
				if ((event.key === " " || event.key === "Enter") && !event.repeat) {
					event.preventDefault();
					start();
				}
			}}
			onKeyUp={(event) => {
				if ((event.key === " " || event.key === "Enter") && held.current) {
					event.preventDefault();
					void finish(false);
				}
			}}
			onContextMenu={(event) => event.preventDefault()}
		>
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth={2}
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				<path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
				<path d="M19 11a7 7 0 0 1-14 0" />
				<path d="M12 18v3" />
			</svg>
		</button>
	);
}
