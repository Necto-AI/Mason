/**
 * The two ways `mason setup` asks a question: a terminal, and no terminal.
 *
 * The wizard is a shell over functions that take answers (`setup.ts`), and this file is the only place that knows how an
 * answer is collected. `terminalPrompter` is a thin adapter over the same `TerminalScreen` every other mason flow draws
 * with, so one renderer and one set of keys serves `mason onboard` and `mason setup`: a question here is the same list,
 * the same field, and the same footer as a question there.
 *
 * `scriptedPrompter` answers from flags and refuses when a required answer was not among them, which is what makes the
 * flow drivable in CI and in a test: no TTY, no keypresses, the same functions. `choosePrompter` therefore falls back to
 * the scripted side when there is no terminal, and a headless run says why it is asking for flags instead of quietly
 * taking defaults.
 */
import { filterWarnings, TerminalScreen } from "../src/tui/app.ts";
import type { Journey } from "../src/tui/screen.ts";
import { Cancelled } from "../src/tui/screen.ts";

/** One option in a list: the value is what the flow gets, the label is what a person reads. */
export interface Choice {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
	/** A row the filter never takes away: an action, or the way out of a list that does not hold the answer. */
	readonly pinned?: boolean;
}

export interface TextQuestion {
	/** One or two lines of context above the prompt, e.g. where a token comes from. */
	readonly hint?: string;
	/** The flag that answers this without a terminal, e.g. `--env TELEGRAM_BOT_TOKEN="<token>"`. */
	readonly flag?: string;
	/**
	 * The answer is a credential, and the field masks it: one glyph per character, never the value. What the answer is
	 * *not* is written down — it goes into the container's environment and nowhere else, never into the install record.
	 */
	readonly secret?: boolean;
	/** Taken when the person presses enter on an empty line. */
	readonly fallback?: string;
	/** An answer with no fallback is required: an empty line asks again. */
	readonly required?: boolean;
	/** The page the answer comes from, when it comes from somewhere else: drawn under the hint, opened with `ctrl+o`. */
	readonly journey?: Journey;
}

/** A question answered from a list, and the flag that answers it without a terminal. */
export interface PickQuestion {
	/** e.g. `--provider <id>`: what a headless run should pass instead of an answer. */
	readonly flag?: string;
	/** One line of context under the question: where the list comes from, or how much of it there is. */
	readonly hint?: string;
	/**
	 * What a scripted run takes when the answer was not among its flags: named by the caller, never guessed here, because
	 * a default this file chose would be a decision about somebody's bot.
	 */
	readonly fallback?: string;
}

/** What the flow may ask. Every method is one question, and nothing here decides what an answer means. */
export interface Prompter {
	pick(question: string, choices: readonly Choice[], options?: PickQuestion): Promise<string>;
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
export interface ScriptedAnswers {
	/** Setup's `--connector`, which answers the one question whose list is the catalog. */
	readonly connector?: string;
	/** Setup's `--owner`. */
	readonly owner?: string;
	/** Any other pick, keyed by the question text: `mason init` asks which provider, `mason new` nothing. */
	readonly picks?: ReadonlyMap<string, string>;
	/** Any other text answer, keyed by the question text: the provider's model and key. */
	readonly texts?: ReadonlyMap<string, string>;
}

export function scriptedPrompter(answers: ScriptedAnswers): Prompter {
	const picked = (question: string): string | undefined => {
		const scripted = answers.picks?.get(question);
		if (scripted !== undefined) return scripted;
		return question === CONNECTOR_QUESTION ? answers.connector : undefined;
	};
	return {
		async pick(question, choices, options = {}) {
			const scripted = picked(question);
			if (scripted !== undefined) {
				if (!choices.some((choice) => choice.value === scripted))
					throw new MissingAnswer(
						`there is no "${scripted}": it is ${choices.map((choice) => choice.value).join(", ")}`,
					);
				return scripted;
			}
			if (choices.length === 1 && choices[0] !== undefined) return choices[0].value;
			const fallback = options.fallback;
			if (fallback !== undefined && choices.some((choice) => choice.value === fallback)) return fallback;
			throw new MissingAnswer(
				`no terminal, and ${question}: pass ${options.flag ?? "--connector <name>"}, one of ` +
					`${choices.map((choice) => choice.value).join(", ")}`,
			);
		},
		async text(question, options = {}) {
			// A question with a flag was answered before this point; the map is how the caller hands the answer over.
			const scripted = answers.texts?.get(question);
			if (scripted !== undefined) return scripted;
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

/** The connector list's question. Setup's `--connector` answers this one, and no other pick. */
export const CONNECTOR_QUESTION = "Which connector do you want to talk through?";

/** The conversations a connector's grant allows, asked when `--conversations` was not passed. */
export const CONVERSATIONS_QUESTION = "which conversations may it carry? (ids, comma separated)";

/** The event kinds a connector may fire, asked when `--events` was not passed: `kind=hook`, comma separated. */
export const EVENTS_QUESTION = "which event kinds may it fire? (kind=hook, comma separated, empty for none)";

/** `mason init`'s three answers. */
export const PROVIDER_QUESTION = "which provider?";
export const MODEL_QUESTION = "which model?";
export const KEY_QUESTION = "the provider's API key?";

/**
 * The terminal: one screen for the whole run, with each question mounted, answered and replaced in turn.
 *
 * Escape is `mason setup`'s cancel, not a step backwards: `setup` asks its questions in one pass and nothing is written
 * before its plan, so going back would only be returning to a question already answered. It is translated to the
 * `MissingAnswer` a scripted run raises, which is what every caller already reads as "nothing was written".
 */
export function terminalPrompter(): Prompter {
	filterWarnings();
	const screen = TerminalScreen.open({ subtitle: "setup" });
	screen.where({ title: "Setup", index: 1, total: 1 });
	let closed = false;
	const finish = (): void => {
		if (closed) return;
		closed = true;
		screen.close();
	};
	const cancelled = (): MissingAnswer => new MissingAnswer("cancelled: nothing was written");

	return {
		async pick(question, choices, options = {}) {
			try {
				return await screen.select(
					"wizard.pick",
					question,
					choices.map((choice) => ({
						value: choice.value,
						label: choice.label,
						...(choice.description === undefined ? {} : { description: choice.description }),
						...(choice.pinned === undefined ? {} : { pinned: choice.pinned }),
					})),
					options.hint === undefined ? {} : { hint: options.hint },
				);
			} catch (error) {
				if (error instanceof Cancelled) throw cancelled();
				throw error;
			}
		},
		async text(question, options = {}) {
			// A required answer is asked again rather than refused: the person is here, and one empty enter is a slip, not a
			// decision. An empty answer to an optional question takes the fallback, which is how a model's first id and an
			// optional variable are both "enter, enter".
			for (;;) {
				let answer: string;
				try {
					answer =
						options.secret === true
							? await screen.secret("wizard.secret", question, {
									...(options.hint === undefined ? {} : { hint: options.hint }),
									...(options.flag === undefined ? {} : { flag: options.flag }),
									...(options.journey === undefined ? {} : { journey: options.journey }),
								})
							: await screen.text("wizard.text", question, {
									...(options.hint === undefined ? {} : { hint: options.hint }),
									...(options.fallback === undefined ? {} : { placeholder: options.fallback }),
									...(options.journey === undefined ? {} : { journey: options.journey }),
									// Forwarded, not assumed: an optional question and a default both end with an empty line,
									// and a field that refuses one turns "enter, enter" into a dead end.
									...(options.required === undefined ? {} : { required: options.required }),
								});
				} catch (error) {
					if (error instanceof Cancelled) throw cancelled();
					throw error;
				}
				if (answer !== "") return answer;
				if (options.fallback !== undefined) return options.fallback;
				if (options.required !== true) return "";
			}
		},
		async confirm(question, _fallback) {
			try {
				return await screen.confirm("wizard.confirm", question, { yes: "yes", no: "no" });
			} catch (error) {
				if (error instanceof Cancelled) throw cancelled();
				throw error;
			}
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
	readonly picks?: ReadonlyMap<string, string>;
	readonly texts?: ReadonlyMap<string, string>;
}): Prompter {
	const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
	if (options.yes || !interactive)
		return scriptedPrompter({
			...(options.connector === undefined ? {} : { connector: options.connector }),
			...(options.owner === undefined ? {} : { owner: options.owner }),
			...(options.picks === undefined ? {} : { picks: options.picks }),
			...(options.texts === undefined ? {} : { texts: options.texts }),
		});
	return terminalPrompter();
}
