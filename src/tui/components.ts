/**
 * The components an onboarding screen is made of: one list, one text field, one masked field, one status list, and the
 * note that an apply or a completion screen is.
 *
 * They are deliberately small and share one contract — `render(width)` returns lines that fit in `width`, and every
 * keyboard convention is the same on all of them, because a wizard where escape means "back" on one screen and "cancel"
 * on the next is a wizard a person has to learn twice. Input matching, fuzzy filtering and width arithmetic come from
 * `@earendil-works/pi-tui`; what is here is the layout and the vocabulary.
 *
 * `MaskedInput` is the one component with a security argument. The terminal's own editor echoes what it is given, and
 * pi-tui's `Input` has no masked mode, so a secret typed into it is a secret written to the screen, to a scrollback
 * buffer, and to whatever records the session. This field keeps the value in memory, renders one mask glyph per
 * character, and never puts the value in a line it returns. The only place the value leaves is the promise `onSubmit`
 * resolves, which is the caller that stores it.
 */
import {
	type Component,
	CURSOR_MARKER,
	decodeKittyPrintable,
	type Focusable,
	fuzzyFilter,
	Input,
	matchesKey,
	renderFakeCursor,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Glyphs, type Paint, widthOf } from "./style.ts";

/** What a screen knows about its own geometry: a list sizes itself to the room the window leaves it. */
export interface Geometry {
	readonly columns: number;
	readonly rows: number;
	/** The style the whole application renders in. */
	readonly paint: Paint;
	readonly glyphs: Glyphs;
}

/** One row a person may pick: the value is what the flow gets, the label is what a person reads. */
export interface Choice {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

const SPINNER_MS = 80;

/** The glyph for a running operation at `now`: deterministic, so a test can assert the frame it expects. */
export function spinnerFrame(glyphs: Glyphs, now = Date.now()): string {
	const frames = glyphs.spinner;
	return frames[Math.floor(now / SPINNER_MS) % frames.length] ?? frames[0] ?? "*";
}

/** The one character a raw keypress means, if it means one at all. Escape sequences are not characters. */
export function typedChar(data: string): string | undefined {
	const decoded = decodeKittyPrintable(data) ?? data;
	if (decoded.length !== 1) return undefined;
	const code = decoded.charCodeAt(0);
	if (code < 0x20 || code === 0x7f) return undefined;
	return decoded;
}

/**
 * Every body is focusable: the terminal hands keys to whatever is mounted, and a body that ignores them is quiet.
 *
 * Focus is a property with one hook rather than a field, because a field that holds an `Input` has to pass the flag on:
 * the editor draws the cursor and the wrapper draws the question, and only one of them may think it is focused.
 */
abstract class Body implements Component, Focusable {
	private focusedValue = false;
	get focused(): boolean {
		return this.focusedValue;
	}
	set focused(value: boolean) {
		this.focusedValue = value;
		this.onFocus?.(value);
	}
	protected onFocus?(value: boolean): void;
	invalidate(): void {}
	abstract render(width: number): string[];
	handleInput?(data: string): void;
}

function wrap(text: string, width: number, style: (value: string) => string): string[] {
	if (text === "") return [];
	return wrapTextWithAnsi(text, Math.max(1, width)).map((line) => style(line));
}

/**
 * A list, with an optional search line.
 *
 * The search is fuzzy over the label and the description, and it is on for every list rather than for "long" ones: a
 * person who has seen a provider list forty entries long types into the next one that is four, and a list that silently
 * ignores the letters is worse than one that filters. A short list simply has nothing to filter.
 */
export class ChoiceList extends Body {
	onSelect?: (value: string) => void;
	onCancel?: () => void;
	private readonly geometry: Geometry;
	private readonly question: string;
	private readonly hint: string | undefined;
	private readonly preface: readonly string[];
	private readonly searchable: boolean;
	private readonly maxVisible: number;
	private readonly all: readonly Choice[];
	private readonly selected: string | undefined;
	private query = "";
	private index = 0;

	constructor(
		geometry: Geometry,
		options: {
			readonly question: string;
			readonly hint?: string;
			/** Already-styled lines above the question: a review, a summary, a plan. Wrapped, never truncated. */
			readonly preface?: readonly string[];
			readonly choices: readonly Choice[];
			readonly searchable?: boolean;
			readonly selected?: string;
			readonly maxVisible?: number;
		},
	) {
		super();
		this.geometry = geometry;
		this.question = options.question;
		this.hint = options.hint;
		this.preface = options.preface ?? [];
		this.searchable = options.searchable ?? true;
		this.all = options.choices;
		this.selected = options.selected;
		// Three rows are the question, the hint and the search line; the rest of the window is the list's. Four is the
		// smallest window worth scrolling: below that a page hint costs as much as it explains.
		this.maxVisible = Math.max(4, options.maxVisible ?? Math.min(10, geometry.rows - 6));
		this.index = Math.max(
			0,
			this.all.findIndex((choice) => choice.value === options.selected),
		);
	}

	/** What the list is showing now: the filtered rows, in the order they are drawn. */
	visible(): readonly Choice[] {
		if (!this.searchable || this.query.trim() === "") return this.all;
		return fuzzyFilter([...this.all], this.query, (choice) => `${choice.label} ${choice.description ?? ""}`);
	}

	render(width: number): string[] {
		const { paint, glyphs } = this.geometry;
		const rows = this.visible();
		this.index = Math.min(this.index, Math.max(0, rows.length - 1));
		const out: string[] = [
			...this.preface.flatMap((line) =>
				line.trim() === ""
					? [""]
					: wrapTextWithAnsi(line, Math.max(1, width)).map((part) => truncateToWidth(part, width)),
			),
			...(this.preface.length === 0 ? [] : [""]),
			truncateToWidth(paint.heading(this.question), width),
			...(this.hint === undefined ? [] : wrap(this.hint, width, paint.dim)),
			"",
		];
		if (this.searchable) {
			const prompt = this.query === "" ? paint.dim("type to filter") : this.query;
			out.push(truncateToWidth(`${paint.dim("/")} ${prompt}`, width), "");
		}
		if (rows.length === 0) {
			out.push(truncateToWidth(paint.dim("no match"), width));
			return out;
		}
		// The window follows the selection: a list longer than the window is scrolled, never cut at a static offset.
		const start = Math.max(0, Math.min(this.index - this.maxVisible + 2, rows.length - this.maxVisible));
		const shown = rows.slice(start, start + this.maxVisible);
		shown.forEach((choice, offset) => {
			out.push(...this.row(choice, start + offset === this.index, width));
		});
		if (rows.length > shown.length)
			out.push(
				truncateToWidth(
					paint.dim(`${start + 1}-${start + shown.length} of ${rows.length}  ${glyphs.wait} page up/down`),
					width,
				),
			);
		return out;
	}

	/** One row, and its description on the same line only when there is room for both: a narrow window drops the prose. */
	private row(choice: Choice, selected: boolean, width: number): string[] {
		const { paint, glyphs } = this.geometry;
		const cursor = selected ? `${paint.accent(glyphs.cursor)} ` : "  ";
		const label = selected ? paint.accent(choice.label) : choice.label;
		const description = choice.description ?? "";
		if (description === "") return [truncateToWidth(`${cursor}${label}`, width)];
		const inline = `${cursor}${label}  ${paint.dim(description)}`;
		if (width >= 72 && widthOf(inline) <= width) return [inline];
		const wrapped = wrap(description, width - 4, paint.dim);
		return [`${cursor}${label}`, ...wrapped.map((line) => `    ${line}`)];
	}

	handleInput(data: string): void {
		const rows = this.visible();
		if (matchesKey(data, "up")) this.index = this.index === 0 ? Math.max(0, rows.length - 1) : this.index - 1;
		else if (matchesKey(data, "down")) this.index = this.index >= rows.length - 1 ? 0 : this.index + 1;
		else if (matchesKey(data, "pageUp")) this.index = Math.max(0, this.index - this.maxVisible);
		else if (matchesKey(data, "pageDown"))
			this.index = Math.min(Math.max(0, rows.length - 1), this.index + this.maxVisible);
		else if (matchesKey(data, "enter")) {
			const chosen = rows[this.index];
			if (chosen !== undefined) this.onSelect?.(chosen.value);
			return;
		} else if (matchesKey(data, "escape")) {
			this.onCancel?.();
			return;
		} else if (matchesKey(data, "ctrl+u")) this.setQuery("");
		else if (matchesKey(data, "backspace")) this.setQuery(this.query.slice(0, -1));
		else {
			const typed = typedChar(data);
			if (typed !== undefined && this.searchable) this.setQuery(this.query + typed);
		}
	}

	private setQuery(query: string): void {
		this.query = query;
		this.index = 0;
	}
}

/**
 * A single-line text field: the question, the hint, and pi-tui's own editor.
 *
 * The editor is the vendor's `Input`, which is the one thing here that is not rewritten: cursor movement, word deletion,
 * paste and the kill ring are forty behaviours a person already knows, and a second implementation of them would be a
 * second set of bugs. What this adds is the frame around it — the question above, a validation message below, and the
 * refusal to submit a value that does not pass.
 */
export class TextField extends Body {
	onSubmit?: (value: string) => void;
	onCancel?: () => void;
	private readonly geometry: Geometry;
	private readonly question: string;
	private readonly hint: string | undefined;
	private readonly validate: ((value: string) => string | undefined) | undefined;
	private readonly required: boolean;
	private readonly input: Input;
	private error: string | undefined;

	constructor(
		geometry: Geometry,
		options: {
			readonly question: string;
			readonly hint?: string;
			readonly value?: string;
			readonly placeholder?: string;
			readonly required?: boolean;
			readonly validate?: (value: string) => string | undefined;
		},
	) {
		super();
		this.geometry = geometry;
		this.question = options.question;
		this.hint = options.hint;
		this.required = options.required ?? true;
		this.validate = options.validate;
		this.input = new Input({
			prompt: `${geometry.paint.dim(">")} `,
			...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
		});
		this.setValue(options.value ?? "");
		this.input.onSubmit = (value: string) => this.submit(value);
		this.input.onEscape = () => this.onCancel?.();
	}

	/** Focus is the editor's too: the fake cursor is drawn by whichever component owns the line. */
	protected onFocus(value: boolean): void {
		this.input.focused = value;
	}

	/** The argument is accepted on the next submit; this is what a field remembers across a revalidation. */
	accept(value: string): void {
		this.setValue(value);
	}

	/**
	 * Put a value in, with the cursor after it.
	 *
	 * `Input.setValue` keeps the cursor where it was, which is column zero for a field that was just built — so a
	 * prefilled answer would be edited by inserting in front of it, and ctrl-u would clear nothing. Ctrl-E is the
	 * editor's own "end of line", so this is the same path the person's key would take.
	 */
	private setValue(value: string): void {
		this.input.setValue(value);
		this.input.handleInput("\x05");
	}

	private submit(value: string): void {
		const trimmed = value.trim();
		if (trimmed === "" && this.required) {
			this.error = "this answer is required";
			return;
		}
		const problem = this.validate?.(trimmed);
		if (problem !== undefined) {
			this.error = problem;
			return;
		}
		this.error = undefined;
		this.onSubmit?.(trimmed);
	}

	render(width: number): string[] {
		const { paint } = this.geometry;
		return [
			truncateToWidth(paint.heading(this.question), width),
			...(this.hint === undefined ? [] : wrap(this.hint, width, paint.dim)),
			"",
			...this.input.render(width),
			...(this.error === undefined
				? []
				: ["", truncateToWidth(paint.bad(`${this.geometry.glyphs.fail} ${this.error}`), width)]),
		];
	}

	handleInput(data: string): void {
		this.error = undefined;
		this.input.handleInput(data);
	}
}

/**
 * A field that never echoes what is typed.
 *
 * There is no cursor movement inside the value on purpose: a secret is typed once, corrected with backspace, and the
 * arrow keys are left to do nothing rather than to move a cursor the screen is not showing. The value goes to `onSubmit`
 * and nowhere else — not to a render, not to an error, not to the terminal.
 */
export class MaskedInput extends Body {
	onSubmit?: (value: string) => void;
	onCancel?: () => void;
	private readonly geometry: Geometry;
	private readonly question: string;
	private readonly hint: string | undefined;
	private readonly flag: string | undefined;
	private value = "";

	constructor(
		geometry: Geometry,
		options: {
			readonly question: string;
			readonly hint?: string;
			/** The flag that answers this question without a terminal, offered in the hint so a shared screen has a way out. */
			readonly flag?: string;
		},
	) {
		super();
		this.geometry = geometry;
		this.question = options.question;
		this.hint = options.hint;
		this.flag = options.flag;
	}

	/** How many characters were typed. The value itself is not readable from outside, which is the point. */
	get length(): number {
		return this.value.length;
	}

	render(width: number): string[] {
		const { paint, glyphs } = this.geometry;
		const hint = [
			...(this.hint === undefined ? [] : [this.hint]),
			...(this.flag === undefined ? [] : [`it is kept out of this screen: pass ${this.flag} to skip the question`]),
		];
		const masked = glyphs.mask.repeat(this.value.length);
		const cursor = this.focused ? `${CURSOR_MARKER}${renderFakeCursor(" ")}` : "";
		const prompt = `${paint.dim(">")} `;
		const room = Math.max(1, width - prompt.length - (this.focused ? 1 : 0));
		// The tail is what is shown: a backspace has to be visible even when the value is longer than the line.
		const shown = masked.length > room ? masked.slice(masked.length - room) : masked;
		return [
			truncateToWidth(paint.heading(this.question), width),
			...hint.flatMap((line) => wrap(line, width, paint.dim)),
			"",
			`${prompt}${paint.dim(shown)}${cursor}`,
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "enter")) {
			if (this.value === "") return;
			this.onSubmit?.(this.value);
			return;
		}
		if (matchesKey(data, "escape")) {
			this.onCancel?.();
			return;
		}
		if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
			this.value = this.value.slice(0, -1);
			return;
		}
		if (matchesKey(data, "ctrl+u") || matchesKey(data, "ctrl+w")) {
			this.value = "";
			return;
		}
		const typed = typedChar(data);
		if (typed !== undefined) this.value += typed;
		else if (data.length > 1 && !data.startsWith("\x1b")) this.value += data.replace(/[\x00-\x1f\x7f]/g, "");
	}
}

/** One row of a status list: what is being done, and how it went. */
export interface StatusRow {
	readonly label: string;
	readonly state: "wait" | "run" | "ok" | "fail" | "warn" | "skip" | "info";
	readonly detail?: string;
}

/**
 * The rows an apply, an environment check or a completion screen shows.
 *
 * A running row draws a spinner from the clock rather than owning a timer: the screen repaints while an operation is in
 * flight, and a component that schedules its own interval is a component that leaks one when a step throws.
 */
export class StatusList extends Body {
	private rows: readonly StatusRow[];
	private note: string | undefined;
	private readonly geometry: Geometry;
	private readonly now: () => number;
	onKey?: (key: string) => void;

	constructor(
		geometry: Geometry,
		rows: readonly StatusRow[],
		options: { readonly note?: string; readonly now?: () => number } = {},
	) {
		super();
		this.geometry = geometry;
		this.rows = rows;
		this.note = options.note;
		this.now = options.now ?? Date.now;
	}

	set(rows: readonly StatusRow[], note?: string): void {
		this.rows = rows;
		if (note !== undefined) this.note = note;
	}

	render(width: number): string[] {
		const { paint, glyphs } = this.geometry;
		const out: string[] = [];
		for (const row of this.rows) {
			const mark =
				row.state === "ok"
					? paint.ok(glyphs.ok)
					: row.state === "fail"
						? paint.bad(glyphs.fail)
						: row.state === "warn"
							? paint.warn(glyphs.warn)
							: row.state === "run"
								? paint.accent(spinnerFrame(glyphs, this.now()))
								: row.state === "skip"
									? paint.dim(glyphs.skip)
									: paint.dim(glyphs.wait);
			const label = row.state === "run" ? paint.accent(row.label) : row.label;
			out.push(truncateToWidth(`${mark} ${label}`, width));
			if (row.detail !== undefined && row.detail !== "")
				out.push(...wrap(row.detail, width - 2, paint.dim).map((line) => `  ${line}`));
		}
		if (this.note !== undefined && this.note !== "") out.push("", ...wrap(this.note, width, paint.bold));
		return out;
	}

	handleInput(data: string): void {
		if (this.onKey === undefined) return;
		if (matchesKey(data, "enter")) this.onKey("enter");
		else if (matchesKey(data, "escape")) this.onKey("escape");
		else {
			const typed = typedChar(data);
			if (typed !== undefined) this.onKey(typed.toLowerCase());
		}
	}
}

/**
 * A screen that only says something: the review, the completion, a summary of what is already configured.
 *
 * `lines` are already styled by the caller — a review is not a form, and a component that interprets the words it is
 * given would need a small language for them. What it adds is the one key that continues, and the rule that escape means
 * the same thing here as everywhere else.
 */
export class NoteView extends Body {
	private readonly lines: readonly string[];

	constructor(lines: readonly string[]) {
		super();
		this.lines = lines;
	}

	render(width: number): string[] {
		return this.lines.flatMap((line) =>
			line.trim() === ""
				? [""]
				: wrapTextWithAnsi(line, Math.max(1, width)).map((part) => truncateToWidth(part, width)),
		);
	}

	/** A page reads; it does not act. The keys that leave it belong to the screen that showed it. */
	handleInput(): void {}
}
