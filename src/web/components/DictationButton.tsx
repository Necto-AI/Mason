/**
 * The dictation button: click to start recording and click again to stop, or hold the button and let go to send
 * — whichever the hand does first. The composer owns the textarea and receives the words; this button owns the
 * press, the microphone and the wait.
 *
 * The button always says what it will do next (title, and the square replacing the mic while recording), because
 * a latched recording that looks idle is the failure mode worth spending pixels on. Failures are reported
 * instead of swallowed: a denied microphone or a service that is not running is exactly what the reader needs to
 * be told.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { transcribe } from "../lib/asr.ts";
import { pressOutcome, releaseOutcome, type DictationPhase, worthTranscribing } from "../lib/dictation.ts";
import { startRecording, type Recording } from "../lib/mic.ts";

export interface DictationButtonProps {
	readonly onTranscript: (text: string) => void;
	readonly onError: (message: string) => void;
	readonly disabled?: boolean;
}

function describe(error: unknown): string {
	if (error instanceof DOMException) {
		if (error.name === "NotAllowedError") return "Microphone permission denied";
		if (error.name === "NotFoundError") return "No microphone found";
	}
	return error instanceof Error ? error.message : String(error);
}

export function DictationButton({ onTranscript, onError, disabled = false }: DictationButtonProps) {
	const [phase, setPhaseState] = useState<DictationPhase>("idle");
	const [latched, setLatched] = useState(false);
	// The handlers read what the last render decided, not what it is still rendering; state alone lags a press.
	const phaseRef = useRef<DictationPhase>("idle");
	const latchedRef = useRef(false);
	const arming = useRef<Promise<Recording> | null>(null);
	const startedAt = useRef(0);
	const pressedAt = useRef(0);
	const pressed = useRef(false);

	const setPhase = useCallback((next: DictationPhase) => {
		phaseRef.current = next;
		setPhaseState(next);
	}, []);

	const setLatch = useCallback((value: boolean) => {
		latchedRef.current = value;
		setLatched(value);
	}, []);

	const begin = useCallback(() => {
		if (disabled || arming.current !== null) return;
		startedAt.current = Date.now();
		setLatch(false);
		setPhase("recording");
		const pending = startRecording();
		arming.current = pending;
		pending.catch((error: unknown) => {
			if (arming.current !== pending) return; // finish() took it and will report it
			arming.current = null;
			pressed.current = false;
			setLatch(false);
			setPhase("idle");
			onError(describe(error));
		});
	}, [disabled, onError, setLatch, setPhase]);

	const finish = useCallback(
		async (cancel: boolean) => {
			pressed.current = false;
			setLatch(false);
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
			if (cancel || !worthTranscribing(Date.now() - startedAt.current)) {
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
		[onError, onTranscript, setLatch, setPhase],
	);

	// The button going away (session switch, a re-render that unmounts it) must not leave the mic open.
	useEffect(
		() => () => {
			void finish(true);
		},
		[finish],
	);

	// Neither must a lost connection: nobody can send what it hears anyway.
	useEffect(() => {
		if (disabled) void finish(true);
	}, [disabled, finish]);

	const title =
		phase === "transcribing"
			? "Transcribing\u2026"
			: phase === "recording"
				? latched
					? "Recording \u2014 click to stop"
					: "Release to transcribe"
				: "Dictate \u2014 click to start, or hold to talk";

	return (
		<button
			type="button"
			className="composer-mic"
			data-testid="dictation"
			data-state={phase}
			data-latched={latched ? "true" : undefined}
			title={title}
			aria-label={title}
			aria-pressed={latched}
			disabled={disabled}
			onPointerDown={(event) => {
				const outcome = pressOutcome(phaseRef.current, latchedRef.current);
				if (disabled || outcome === "ignore") return;
				event.preventDefault();
				event.currentTarget.focus({ preventScroll: true });
				if (outcome === "stop") {
					void finish(false);
					return;
				}
				event.currentTarget.setPointerCapture(event.pointerId);
				pressed.current = true;
				pressedAt.current = Date.now();
				begin();
			}}
			onPointerUp={() => {
				if (!pressed.current) return;
				if (releaseOutcome(Date.now() - pressedAt.current) === "talk") {
					void finish(false);
					return;
				}
				pressed.current = false;
				setLatch(true);
			}}
			onPointerCancel={() => {
				if (pressed.current) void finish(true);
			}}
			onLostPointerCapture={() => {
				// The press left the button with no pointerup to end it (capture stolen, element removed).
				if (pressed.current) void finish(false);
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					if (phaseRef.current === "recording") {
						event.preventDefault();
						void finish(true);
					}
					return;
				}
				if (event.key !== " " && event.key !== "Enter") return;
				if (event.repeat) return;
				event.preventDefault();
				const outcome = pressOutcome(phaseRef.current, latchedRef.current);
				if (disabled || outcome === "ignore") return;
				if (outcome === "stop") {
					void finish(false);
					return;
				}
				begin();
				setLatch(true); // a key has no release: on the keyboard it always toggles
			}}
			onContextMenu={(event) => event.preventDefault()}
		>
			{phase === "recording" ? (
				<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
					<rect x="6.5" y="6.5" width="11" height="11" rx="2" />
				</svg>
			) : (
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
			)}
		</button>
	);
}
