/**
 * The two ways `mason setup` asks a question: a terminal, and no terminal.
 *
 * The wizard is a shell over functions that take answers (`setup.ts`), and this file is the only place that knows how an
 * answer is collected. `terminalPrompter` drives `@earendil-works/pi-tui` — a renderer and a widget kit, not a prompt
 * library, so the sequence is a state machine here: mount a `SelectList` or an `Input`, take what it hands back, unmount
 * it, ask the next thing. `scriptedPrompter` answers from flags and refuses when a required answer was not among them,
 * which is what makes the flow drivable in CI and in a test: no TTY, no keypresses, the same functions.
 *
 * pi-tui has no TTY guard of its own. Started on a pipe it renders ANSI and reads whole lines, so a `SelectList` would
 * appear to hang: the arrow keys it listens for never arrive. `choosePrompter` therefore falls back to the scripted side
 * when there is no terminal, and a headless run says why it is asking for flags instead of quietly taking defaults.
 */
import {
	Input,
	matchesKey,
	ProcessTerminal,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Spacer,
	Text,
	type TUI,
	TuiMainScreen,
} from "@earendil-works/pi-tui";

/** One option in a list: the value is what the flow gets, the label is what a person reads. */
export interface Choice {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

export interface TextQuestion {
	/** One line of context above the prompt, e.g. where a token comes from. */
	readonly hint?: string;
	/** The flag that answers this without a terminal, e.g. `--env TELEGRAM_BOT_TOKEN="<token>"`. */
	readonly flag?: string;
	/**
	 * The answer is a credential, and the terminal has to say that it is about to echo it: pi-tui's `Input` has no masked
	 * mode. What the answer is *not* is written down — the value goes into the container's environment and nowhere else,
	 * never into the install record.
	 */
	readonly secret?: boolean;
	/** Taken when the person presses enter on an empty line. */
	readonly fallback?: string;
	/** An answer with no fallback is required: an empty line asks again. */
	readonly required?: boolean;
}

/** What the flow may ask. Every method is one question, and nothing here decides what an answer means. */
export interface Prompter {
	pick(question: string, choices: readonly Choice[]): Promise<string>;
	text(question: string, options?: TextQuestion): Promise<string>;
	confirm(question: string, fallback: boolean): Promise<boolean>;
	/** Releases the terminal, if one was taken. Safe to call twice. */
	close(): void;
}

/** Raised when a required answer was not given: a cancelled wizard, or a scripted run missing a flag. */
export class MissingAnswer extends Error {}

/**
 * Answers from the flags a caller already collected, and nothing else.
 *
 * `pick` returns the only choice when there is exactly one — a `--yes` run of a home that already holds one connector
 * should not have to name it — and otherwise refuses with the list, because a default chosen here would be a guess about
 * which bot the person wants.
 */
export function scriptedPrompter(answers: { readonly connector?: string; readonly owner?: string }): Prompter {
	return {
		async pick(question, choices) {
			if (answers.connector !== undefined) {
				if (!choices.some((choice) => choice.value === answers.connector))
					throw new MissingAnswer(
						`there is no connector "${answers.connector}": it is ${choices.map((choice) => choice.value).join(", ")}`,
					);
				return answers.connector;
			}
			if (choices.length === 1 && choices[0] !== undefined) return choices[0].value;
			throw new MissingAnswer(
				`no terminal, and ${question}: pass --connector <name>, one of ${choices.map((choice) => choice.value).join(", ")}`,
			);
		},
		async text(question, options = {}) {
			// The owner is the one free-text question that has a flag of its own; everything else is an env answer, and
			// the caller resolves those before it gets here.
			if (question === OWNER_QUESTION && answers.owner !== undefined) return answers.owner;
			// An optional question is answerable with nothing: a headless run declines it rather than failing, which is
			// how `--yes` leaves a proxy unset on a host that does not need one.
			if (options.required !== true) return options.fallback ?? "";
			throw new MissingAnswer(`no terminal, and ${question}: pass ${options.flag ?? "--owner <id>"}`);
		},
		async confirm(_question, fallback) {
			// `--no-start` is the only boolean the flow asks, and a scripted run has already decided it.
			return fallback;
		},
		close() {},
	};
}

/** The question whose answer has a flag; `scriptedPrompter` compares against it rather than guessing from the text. */
export const OWNER_QUESTION = "who owns this chat?";

/** The theme pi-tui wants, in the colours a terminal already has: no truecolor dependency, no colour on a pipe. */
function theme(): SelectListTheme {
	const dim = (s: string): string => `\x1b[2m${s}\x1b[22m`;
	const invert = (s: string): string => `\x1b[7m${s}\x1b[27m`;
	const cyan = (s: string): string => `\x1b[36m${s}\x1b[39m`;
	return { selectedPrefix: cyan, selectedText: invert, description: dim, scrollInfo: dim, noMatch: dim };
}

/**
 * The terminal. One `TUI` for the whole run, with each question mounted, answered and unmounted in turn.
 *
 * Every `ask` builds its own promise and resolves it from the widget's callback; the widget leaves the tree before the
 * promise settles, so the next question never renders underneath the last one. `close()` calls `tui.stop()` once, and
 * the caller runs it in a `finally`: a throw between two questions must not leave the terminal in raw mode with the
 * cursor hidden.
 */
export function terminalPrompter(): Prompter {
	const terminal = new ProcessTerminal();
	const tui: TUI = new TuiMainScreen(terminal);
	let closed = false;
	const finish = (): void => {
		if (closed) return;
		closed = true;
		tui.stop();
	};
	// Ctrl-C in raw mode is a byte, not a signal: pi-tui installs no handler of its own, so this is the one thing that
	// has to be intercepted before it becomes a keystroke in an input box.
	tui.addInputListener((data) => {
		if (matchesKey(data, "ctrl+c")) {
			finish();
			process.exit(130);
		}
		return undefined;
	});
	tui.start();

	function pick(question: string, choices: readonly Choice[]): Promise<string> {
		return new Promise((answer, reject) => {
			const label = new Text(question, 0, 1);
			const list = new SelectList(
				choices.map(
					(choice): SelectItem => ({
						value: choice.value,
						label: choice.label,
						...(choice.description === undefined ? {} : { description: choice.description }),
					}),
				),
				10,
				theme(),
			);
			const done = (value: string): void => {
				tui.removeChild(list);
				tui.removeChild(label);
				answer(value);
			};
			list.onSelect = (item) => {
				done(item.value);
			};
			list.onCancel = () => {
				reject(new MissingAnswer("cancelled: nothing was written"));
			};
			tui.addChild(label);
			tui.addChild(list);
			tui.setFocus(list);
			// `addChild` only pushes: without this the question is in the tree and not on the screen.
			tui.requestRender();
		});
	}

	function text(question: string, options: TextQuestion = {}): Promise<string> {
		return new Promise((answer, reject) => {
			// `secret` cannot buy a masked field — pi-tui's `Input` has no such mode, and drawing over it would leave the
			// real value on the line anyway. It buys the one thing that is honest: saying so, with the flag that avoids it.
			const hint =
				options.secret === true
					? [options.hint, "this answer is echoed as you type it: pass the flag instead on a shared screen"]
							.filter((line) => line !== undefined)
							.join("\n")
					: options.hint;
			const label = new Text(hint === undefined ? question : `${question}\n${hint}`, 0, 1);
			const input = new Input({ prompt: "> " });
			const done = (value: string): void => {
				tui.removeChild(input);
				tui.removeChild(label);
				answer(value);
			};
			input.onSubmit = (value: string) => {
				const trimmed = value.trim();
				if (trimmed === "") {
					if (options.fallback !== undefined) return done(options.fallback);
					// A required answer is asked again rather than refused: the person is here, and one empty enter is a
					// slip, not a decision.
					if (options.required === true) {
						input.setValue("");
						return;
					}
					return done("");
				}
				done(trimmed);
			};
			input.onEscape = () => {
				reject(new MissingAnswer("cancelled: nothing was written"));
			};
			tui.addChild(label);
			tui.addChild(new Spacer(1));
			tui.addChild(input);
			tui.setFocus(input);
			tui.requestRender();
		});
	}

	return {
		pick,
		text,
		async confirm(question, fallback) {
			const value = await pick(question, [
				{ value: "yes", label: "yes" },
				{ value: "no", label: "no" },
			]);
			return value === "yes" ? true : value === "no" ? false : fallback;
		},
		close: finish,
	};
}

/**
 * The prompter this run gets: `--yes` or no terminal means flags, and a TTY means the wizard.
 *
 * `--yes` is not the same as "no TTY" — it is a person saying "do not ask me", and it is honoured even on a terminal, so
 * a run on Denis's laptop and a run in CI take the same path.
 */
export function choosePrompter(options: {
	readonly yes: boolean;
	readonly connector?: string;
	readonly owner?: string;
}): Prompter {
	const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
	if (options.yes || !interactive)
		return scriptedPrompter({
			...(options.connector === undefined ? {} : { connector: options.connector }),
			...(options.owner === undefined ? {} : { owner: options.owner }),
		});
	return terminalPrompter();
}
