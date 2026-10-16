/**
 * The composer pill, ported from apiary's `packages/web/src/composer.ts`: one line grows with the text; past 14
 * lines it caps (scrollable, fading top) until the toggle calls for the expanded 27. While a turn runs there are
 * two send actions, matching the durable backend's queue modes: Steer lands at the next boundary (the end of the
 * tool round), Follow-up only when the run ends, and Stop ends the run where the send button would be.
 *
 * This is also where the session tells the truth about itself: a lost connection is announced here, next to the
 * input it blocks, and nowhere else — the shell is not a dashboard.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** The model that answers is a diagnostic, not a headline: it shows up when diagnostics do. */
function modelLabel(model: ComposerProps["model"], debug: boolean) {
	if (!debug || model === undefined) return null;
	return (
		<span className="composer-model" data-testid="composer-model">
			{`${model.provider}/${model.modelId}`}
		</span>
	);
}

/** px, mirrors --prompt-line in chat.css. */
const PROMPT_LINE = 23;

export interface ComposerProps {
	readonly busy: boolean;
	readonly enabled: boolean;
	readonly pending: boolean;
	readonly connection: "connecting" | "connected" | "disconnected";
	/** Model that answers, shown while diagnostics are on. */
	readonly model?: { provider: string; modelId: string } | undefined;
	readonly debug: boolean;
	/** Idle: the message that starts a run. Busy: the follow-up that waits for the run to end. */
	readonly onSubmit: (text: string) => void;
	readonly onSteer: (text: string) => void;
	/** Ends the running turn. */
	readonly onStop: () => void;
}

/** How long a connection blip may last before it is worth mentioning; a reload should not flash a warning. */
const BLIP_MS = 1200;

export function Composer({
	busy,
	enabled,
	pending,
	connection,
	model,
	debug,
	onSubmit,
	onSteer,
	onStop,
}: ComposerProps) {
	const [text, setText] = useState("");
	const [expanded, setExpanded] = useState(false);
	const [multiline, setMultiline] = useState(false);
	const [capped, setCapped] = useState(false);
	const input = useRef<HTMLTextAreaElement | null>(null);
	const form = useRef<HTMLFormElement | null>(null);
	const box = useRef<HTMLDivElement | null>(null);

	const relayout = useCallback(() => {
		const node = input.current;
		const wrapper = box.current;
		if (node === null || wrapper === null) return;
		node.style.height = "0px";
		const natural = node.scrollHeight;
		const multi = expanded || node.value.includes("\n") || natural > PROMPT_LINE + 4;
		const cap = Math.max(
			3 * PROMPT_LINE,
			Math.min((expanded ? 27 : 14) * PROMPT_LINE, window.innerHeight - 152),
		);
		node.style.height = `${Math.min(natural, multi ? cap : PROMPT_LINE)}px`;
		const isCapped = node.scrollHeight > node.clientHeight + 1;
		node.scrollTop = node.scrollHeight;
		setMultiline(multi);
		setCapped(isCapped);
		// The transcript floats its last message clear of the pill, so the pill's footprint is published for it.
		const below = form.current === null ? 0 : Number.parseFloat(getComputedStyle(form.current).paddingBottom) || 0;
		document.documentElement.style.setProperty("--composer-space", `${wrapper.offsetHeight + below}px`);
	}, [expanded]);

	useLayoutEffect(() => {
		relayout();
	}, [relayout, text, busy]);

	useLayoutEffect(() => {
		window.addEventListener("resize", relayout);
		return () => window.removeEventListener("resize", relayout);
	}, [relayout]);

	const send = (mode: "submit" | "steer" | "followUp") => {
		const value = text.trim();
		if (value === "" || !enabled || pending) return;
		setText("");
		if (mode === "steer") onSteer(value);
		else onSubmit(value);
	};

	// A connection that has been down for longer than a blip is worth saying out loud; a reconnecting socket is not
	// the reader's problem until it stays down.
	const [notice, setNotice] = useState(connection);
	useEffect(() => {
		if (connection !== "connected") {
			const timer = setTimeout(() => setNotice(connection), BLIP_MS);
			return () => clearTimeout(timer);
		}
		setNotice(connection);
	}, [connection]);
	const offline = connection !== "connected" && notice !== "connected";

	const canSend = enabled && !pending && text.trim() !== "";
	return (
		<form
			id="prompt-form"
			ref={form}
			onSubmit={(event) => {
				event.preventDefault();
				send(busy ? "followUp" : "submit");
			}}
		>
			{offline ? (
				<div className="composer-strip" data-testid="connection-strip" data-state={connection}>
					<span className="dot" aria-hidden="true" />
					{connection === "disconnected" ? "Connection lost \u2014 reconnecting\u2026" : "Connecting\u2026"}
				</div>
			) : null}
			<div
				ref={box}
				className={`composer${multiline ? " multiline" : ""}${expanded ? " expanded" : ""}${
					capped ? " capped" : ""
				}${busy ? " busy" : ""}`}
				data-testid="composer"
			>
				<textarea
					id="prompt"
					data-testid="composer-input"
					ref={input}
					rows={1}
					value={text}
					disabled={!enabled}
					placeholder={busy ? "Steer or follow-up\u2026" : "Ask anything\u2026"}
					onChange={(event) => setText(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key !== "Enter" || event.shiftKey) return;
						event.preventDefault();
						send(busy ? "followUp" : "submit");
					}}
				/>
				<div className="composer-actions">
					{modelLabel(model, debug)}
					{busy ? (
						<>
							<button
								type="button"
								className="composer-action"
								data-testid="steer"
								title="Steer: place when the current tool round ends"
								disabled={!canSend}
								onClick={() => send("steer")}
							>
								Steer
							</button>
							<button
								type="button"
								className="composer-send"
								data-testid="send"
								title="Follow-up: place when the run ends"
								disabled={!canSend}
								onClick={() => send("followUp")}
							>
								Follow-up
							</button>
							<button
								type="button"
								className="composer-action composer-stop"
								data-testid="stop"
								title="Stop the run"
								aria-label="Stop the run"
								onClick={onStop}
							>
								<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
									<rect x="6.5" y="6.5" width="11" height="11" rx="2" />
								</svg>
							</button>
						</>
					) : (
						<button type="button" id="send" data-testid="send" title="Send" disabled={!canSend} onClick={() => send("submit")}>
							<svg
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth={2}
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<path d="M12 19V5" />
								<path d="m5 12 7-7 7 7" />
							</svg>
						</button>
					)}
					<button
						type="button"
						className="composer-toggle"
						data-testid="composer-toggle"
						title={expanded ? "collapse input" : "expand input"}
						aria-label={expanded ? "collapse input" : "expand input"}
						onClick={() => {
							setExpanded((value) => !value);
							input.current?.focus();
						}}
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
							<path d="m6 9 6 6 6-6" />
						</svg>
					</button>
				</div>
			</div>
		</form>
	);
}
