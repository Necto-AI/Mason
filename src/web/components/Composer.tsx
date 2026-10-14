/** The composer: one input, and the choices that only make sense while a turn is running. */
import { useState } from "react";

export interface ComposerProps {
	readonly busy: boolean;
	readonly disabled: boolean;
	readonly pending: boolean;
	readonly onSend: (text: string) => void;
	readonly onSteer: (text: string) => void;
	readonly onStop: () => void;
	readonly onCompact: () => void;
	readonly onReset: () => void;
}

export function Composer({ busy, disabled, pending, onSend, onSteer, onStop, onCompact, onReset }: ComposerProps) {
	const [text, setText] = useState("");
	const submit = (action: (value: string) => void) => {
		const value = text.trim();
		if (value === "") return;
		action(value);
		setText("");
	};
	return (
		<form
			className="composer"
			data-testid="composer"
			onSubmit={(event) => {
				event.preventDefault();
				submit(onSend);
			}}
		>
			<textarea
				className="composer-input"
				data-testid="composer-input"
				placeholder={busy ? "Type a follow-up…" : "Ask the agent…"}
				rows={2}
				value={text}
				disabled={disabled}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						submit(onSend);
					}
				}}
			/>
			<div className="composer-actions">
				<button type="submit" className="chip chip-primary" data-testid="send" disabled={pending || disabled}>
					Send
				</button>
				<button
					type="button"
					className="chip"
					data-testid="steer"
					disabled={pending || !busy}
					onClick={() => submit(onSteer)}
				>
					Steer
				</button>
				<button type="button" className="chip" data-testid="stop" disabled={pending || !busy} onClick={onStop}>
					Stop
				</button>
				<button type="button" className="chip" data-testid="compact" disabled={pending || busy} onClick={onCompact}>
					Compact
				</button>
				<button type="button" className="chip" data-testid="reset" disabled={pending || busy} onClick={onReset}>
					Reset
				</button>
			</div>
		</form>
	);
}
