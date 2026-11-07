/**
 * The seam between a flow and a terminal.
 *
 * `Screen` is the whole of what an onboarding screen is allowed to do to a person: ask them to pick one of a list, type
 * a line, type a secret, say yes or no, read a page, or watch a list of steps run. Nothing here knows about pi-tui, and
 * nothing here knows about mason's files: a flow written against this interface runs on a real terminal, and runs in a
 * test with no terminal at all, which is the only way the navigation and the failure paths can be pinned.
 *
 * `ScriptedScreen` is the second implementation, and it is not a mock of the first: it answers from a table, records
 * everything it was asked, and fails loudly on a screen the script does not answer. That failure is the assertion — "the
 * wizard must not ask that again on this run" is a test that passes because the question was never asked.
 *
 * Cancelling is `Cancelled`, one class for every screen, so a flow can translate it once: escape means back within a
 * flow, and on the first screen it means nothing was written.
 */
import type { Choice, StatusRow } from "./components.ts";
import { type Glyphs, type Paint, plainStyle } from "./style.ts";

/** Raised when a person asks to stop. Nothing is undone, because a wizard writes nothing before its apply step. */
export class Cancelled extends Error {
	constructor() {
		super("cancelled: nothing was written");
	}
}

/** Where a step is: the section the frame draws, and how far along the flow it sits. */
export interface Where {
	/** The section heading, e.g. "Model and provider". The question itself is the body's first line. */
	readonly title: string;
	readonly index: number;
	readonly total: number;
	readonly subtitle?: string;
}

/** What a question may carry, whichever kind it is. The fields are guidance, not permission: the flow decides. */
export interface Question {
	/** One or two lines above the field: where a token comes from, what an answer costs. */
	readonly hint?: string;
	/** An answer already given: the flow's own memory, shown so a re-entered screen is not blank. */
	readonly value?: string;
	readonly placeholder?: string;
	readonly required?: boolean;
	/** Returns the sentence to show instead of accepting the answer, or nothing when it is fine. */
	readonly validate?: (value: string) => string | undefined;
	/** The flag that answers this question without a terminal, offered by a secret field as its way out of the echo. */
	readonly flag?: string;
	/** Lines above the question: what a review is. Only a list shows them, because a list is what asks a decision. */
	readonly preface?: readonly string[];
}

/** A page of text with nothing to type: what a review, a summary and a completion screen are. */
export interface Page {
	/** Already styled by the caller; a page is prose, not a form. */
	readonly lines: readonly string[];
	readonly note?: string;
}

/** A key and what it does here: the footer draws the label, so no screen has to derive one from a keycode. */
export interface KeyHint {
	readonly key: string;
	readonly label: string;
}

/** A live list of steps: the application writes rows into it as the operations they describe change state. */
export interface Progress {
	update(rows: readonly StatusRow[], note?: string): void;
	/** Show the keys that matter now, and resolve with the first one pressed. */
	key(hints: readonly KeyHint[]): Promise<string>;
	close(): void;
}

export interface Screen {
	/** The window, for a list that has to size itself. */
	readonly columns: number;
	readonly rows: number;
	/** Where the flow is: the frame draws this above every screen, and a note once per run. */
	where(context: Where): void;
	/** The palette the frame renders in, so a page of prose is styled like the screen it sits on. */
	readonly look: { readonly paint: Paint; readonly glyphs: Glyphs };
	select(id: string, title: string, choices: readonly Choice[], options?: Question): Promise<string>;
	text(id: string, title: string, options?: Question): Promise<string>;
	/** The same field, echoing one mask glyph per character and never the value. */
	secret(id: string, title: string, options?: Question): Promise<string>;
	confirm(id: string, title: string, options: { readonly yes: string; readonly no: string }): Promise<boolean>;
	note(id: string, title: string, page: Page): Promise<void>;
	progress(id: string, title: string, rows: readonly StatusRow[]): Progress;
	/** Repaint on a timer while a network call runs; off again when it returns. */
	busy(on: boolean): void;
	/** Release the terminal. Safe to call twice. */
	close(): void;
}

/** One answer a script holds: a pick, a line, a yes or no, or a key pressed on a progress screen. */
export type ScriptedAnswer = string | boolean;

/** The answer that presses escape: a flow must take no write, and hand back the code a missing answer already uses. */
export const CANCEL = "!cancel";

/**
 * A screen that answers from a table.
 *
 * Arrays are queues: the same question asked twice (a validation that rejected the first answer, a screen re-entered
 * after a trip backwards) takes the next answer, so a test can say "type this, then this".
 */
export class ScriptedScreen implements Screen {
	readonly columns: number;
	readonly rows: number;
	/** Every question in the order it was asked, with the kind that asked it, what it was prefilled with, and its prose. */
	readonly asked: Array<{
		/** The prose above the question, when it had any: the summary a decision is made against. */
		readonly preface?: readonly string[];
		readonly id: string;
		readonly kind: string;
		readonly title: string;
		readonly value?: string;
		readonly choices?: readonly string[];
	}> = [];
	/** Every place the flow said it was, in order: the progress indication, asserted without the pixels. */
	readonly locations: Where[] = [];
	/** Every page shown, in order. */
	readonly pages: Array<{ readonly id: string; readonly title: string; readonly page: Page }> = [];
	/** The rows each progress screen ended with, keyed by the screen's id. */
	readonly progressRows = new Map<string, readonly StatusRow[]>();
	/** The last place the flow said it was: a navigation test reads this, not the pixels. */
	location: Where | undefined;
	readonly look: { readonly paint: Paint; readonly glyphs: Glyphs };
	private readonly script: Record<string, ScriptedAnswer | readonly ScriptedAnswer[]>;
	private readonly queues = new Map<string, ScriptedAnswer[]>();
	private closed = 0;

	constructor(
		script: Readonly<Record<string, ScriptedAnswer | readonly ScriptedAnswer[]>>,
		size: {
			readonly columns?: number;
			readonly rows?: number;
			readonly style?: { readonly paint: Paint; readonly glyphs: Glyphs };
		} = {},
	) {
		this.script = { ...script };
		this.columns = size.columns ?? 100;
		this.rows = size.rows ?? 30;
		this.look = size.style ?? plainStyle;
	}

	/** How many times `close` was called: a flow that forgets the terminal in a `finally` is a terminal in raw mode. */
	get closes(): number {
		return this.closed;
	}

	private take(
		id: string,
		kind: string,
		title: string,
		value?: string,
		choices?: readonly string[],
		preface?: readonly string[],
	): ScriptedAnswer {
		this.asked.push({
			id,
			kind,
			title,
			...(value === undefined ? {} : { value }),
			...(choices === undefined ? {} : { choices }),
			...(preface === undefined ? {} : { preface }),
		});
		const queued = this.queues.get(id);
		if (queued !== undefined && queued.length > 0) return queued.shift() as ScriptedAnswer;
		const answer = this.script[id];
		if (answer === undefined)
			throw new Error(`the flow asked "${id}" (${title}) as ${kind} and the script has no answer for it`);
		if (answer === CANCEL) throw new Cancelled();
		if (Array.isArray(answer)) {
			const [first, ...rest] = answer as readonly ScriptedAnswer[];
			this.queues.set(id, [...rest]);
			if (first === undefined) throw new Error(`the scripted answers for "${id}" ran out`);
			if (first === CANCEL) throw new Cancelled();
			return first;
		}
		return answer as ScriptedAnswer;
	}

	async select(id: string, title: string, choices: readonly Choice[], options: Question = {}): Promise<string> {
		const answer = this.take(
			id,
			"select",
			title,
			options.value,
			choices.map((choice) => choice.value),
			options.preface,
		);
		if (typeof answer !== "string")
			throw new Error(
				`the scripted answer for "${id}" is not a value; it picks one of ${choices.map((c) => c.value).join(", ")}`,
			);
		if (!choices.some((choice) => choice.value === answer))
			throw new Error(
				`the scripted answer for "${id}" is "${answer}", which is not offered: ${choices.map((c) => c.value).join(", ")}`,
			);
		return answer;
	}

	async text(id: string, title: string, options: Question = {}): Promise<string> {
		const answer = this.take(id, "text", title, options.value);
		if (typeof answer !== "string") throw new Error(`the scripted answer for "${id}" is not a line`);
		return answer;
	}

	async secret(id: string, title: string, options: Question = {}): Promise<string> {
		const answer = this.take(id, "secret", title, options.value);
		if (typeof answer !== "string") throw new Error(`the scripted answer for "${id}" is not a secret`);
		return answer;
	}

	async confirm(id: string, title: string): Promise<boolean> {
		const answer = this.take(id, "confirm", title);
		if (typeof answer !== "boolean") throw new Error(`the scripted answer for "${id}" is not yes or no`);
		return answer;
	}

	async note(id: string, title: string, page: Page): Promise<void> {
		this.asked.push({ id, kind: "note", title });
		this.pages.push({ id, title, page });
	}

	progress(id: string, title: string, rows: readonly StatusRow[]): Progress {
		this.asked.push({ id, kind: "progress", title });
		this.progressRows.set(id, rows);
		return {
			update: (next) => {
				this.progressRows.set(id, next);
			},
			key: async (hints) => {
				const answer = this.script[`${id}.key`];
				if (typeof answer === "string") return answer;
				// The last key offered is the one that gives up, so an unscripted flow never hangs a test.
				return hints[hints.length - 1]?.key ?? "enter";
			},
			close: () => {},
		};
	}

	where(context: Where): void {
		this.location = context;
		this.locations.push(context);
	}

	busy(): void {}

	close(): void {
		this.closed += 1;
	}
}
