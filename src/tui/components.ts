/**
 * The bodies a screen is made of: a list, a text field, a masked field, a page, and a status list.
 *
 * Each one is a controller rather than a widget: it owns the state a person is changing, `build()` turns that state into
 * an OpenTUI subtree, and `handleKey` takes one keypress. A resize asks for `build()` again, so the state survives what
 * the layout cannot — a list keeps its selection and its filter, a field keeps the line and the cursor — and nothing here
 * schedules a frame of its own: the screen decides when to repaint.
 *
 * They share one keyboard, because a wizard where escape means "back" on one screen and "cancel" on the next is a wizard
 * a person has to learn twice. `enter` continues or selects, `escape` cancels, the arrows move a selection or scroll a
 * page, space continues a page, and a bare `/` starts a filter in a list.
 *
 * `MaskedField` is the one component with a security argument. A secret typed into a screen is a secret written to the
 * terminal, to a scrollback buffer, and to whatever records the session, so this field keeps the value in memory, draws
 * one mask glyph per character, and never puts the value in a line it returns. The only place the value leaves is the
 * promise `onSubmit` resolves, which is the caller that stores it.
 */
import {
	BoxRenderable,
	type CliRenderer,
	type KeyEvent,
	RGBA,
	type Renderable,
	StyledText,
	TextRenderable,
	type TextChunk,
	createTextAttributes,
} from "@opentui/core";
import { spawn } from "node:child_process";
import type { Journey } from "./screen.ts";
import { type Glyphs, type Paint, widthOf } from "./style.ts";
import { type Theme, theme } from "./theme.ts";

/** What a screen knows about its own geometry: the renderer it draws with, and the room it has. */
export interface Geometry {
	readonly renderer: CliRenderer;
	/** The window's width. What decides whether a row has room for a description beside its label. */
	readonly window: number;
	/** The measure: how wide a body may draw. Never wider than the window, capped so prose does not stretch. */
	readonly columns: number;
	/** The rows the body has, so a list can decide how many rows it shows. */
	readonly rows: number;
	readonly paint: Paint;
	readonly glyphs: Glyphs;
}

/** One row a person may pick: the value is what the flow gets, the label is what a person reads. */
export interface Choice {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

/** One row of a status list: what is being done, and how it went. */
export interface StatusRow {
	readonly label: string;
	readonly state: "wait" | "run" | "ok" | "fail" | "warn" | "skip" | "info";
	readonly detail?: string;
}

/** A body: what a screen mounts, and what every keypress is offered to, in that order. */
export interface Body {
	/** The renderable for the state the body is in now. Called again after a resize: it must not lose what was typed. */
	build(): Renderable;
	/** Take one keypress; `true` when it was used, so the screen can leave the rest alone. */
	handleKey(key: KeyEvent): boolean;
	/** Text that arrived as one paste. A field takes it whole; nothing else has anything to do with it. */
	handlePaste?(text: string): boolean;
	/** A keypress changed what this body says: redraw the tree it already has, rather than mounting a new one. */
	reflect?(): void;
	/** One turn of the spinner's clock, for a body that draws a running row. */
	tick?(): void;
}

/** The interval a spinner frame lasts: fast enough to read as motion, slow enough not to be a strobe. */
const SPINNER_MS = 80;

/** Below this many columns a row drops its description, and the selected row's one moves under the list. */
const DESCRIBE_MIN = 90;

/** What a box costs a paragraph inside it: two columns of border and four of padding. */
const BOXED_INSET = 6;

/**
 * How many lines a block has to have before it is boxed.
 *
 * An edge marks what an answer is about: a plan, a review, a note someone has to read to decide. A sentence above a
 * question is prose, and boxing it would put a frame around every question in the wizard — which is the decoration the
 * spec's second rule exists to forbid. Four lines are one glance; past that the block is something a person reads first,
 * and the box is what says where it ends. The count is of the lines the flow wrote, never of the rows they wrap to:
 * a window's width must not be what decides whether a block is a plan.
 */
const BOXED_MIN_LINES = 5;

/** The glyph for a running operation at `now`: deterministic, so a test can assert the frame it expects. */
export function spinnerFrame(glyphs: Glyphs, now = Date.now()): string {
	const frames = glyphs.spinner;
	return frames[Math.floor(now / SPINNER_MS) % frames.length] ?? frames[0] ?? "*";
}

/** Enter is `return` in a terminal that sends the byte and `enter` in one that speaks the kitty protocol. */
export function isEnter(key: KeyEvent): boolean {
	return key.name === "return" || key.name === "enter" || key.name === "linefeed";
}

export function isEscape(key: KeyEvent): boolean {
	return key.name === "escape";
}

/** The one character a keypress means. Modified keys, arrows and function keys are not text, and a paste arrives whole. */
export function typedChar(key: KeyEvent): string | undefined {
	if (key.ctrl || key.meta) return undefined;
	if (key.name === "space") return " ";
	if (key.name.length === 1) return key.name;
	return undefined;
}

/** The attributes a theme may draw with; none at all when paint is off, which is what keeps a piped screen escape-free. */
function attrs(ink: Theme, wanted: { bold?: boolean; dim?: boolean; inverse?: boolean }): number {
	return ink.colour ? createTextAttributes(wanted) : 0;
}

/** A chunk of plain text, which is most of what a body draws. */
function chunk(text: string): TextChunk {
	return { __isChunk: true, text };
}

/** One block of text in a body: full width, never re-wrapped by the renderer, and never asked to shrink into nothing. */
function block(geometry: Geometry, content: StyledText, marginBottom = 0): TextRenderable {
	return new TextRenderable(geometry.renderer, {
		content,
		wrapMode: "none",
		width: "100%",
		flexShrink: 0,
		...(marginBottom === 0 ? {} : { marginBottom }),
	});
}

/** A painted paragraph at `width`, with the blank lines a page uses kept as a row rather than dropped. */
function prose(geometry: Geometry, ink: Theme, source: string, width: number, marginBottom = 0): TextRenderable {
	return block(geometry, ink.paragraph(source === "" ? " " : source, width).text, marginBottom);
}

/** A blank row: a space, because a text renderable with nothing in it has no height to give. */
function gap(geometry: Geometry): TextRenderable {
	return block(geometry, new StyledText([chunk(" ")]));
}

/** A column a body is made of: every child is a full-width line, so the column is the whole of the layout. */
function column(geometry: Geometry): BoxRenderable {
	return new BoxRenderable(geometry.renderer, { flexDirection: "column", width: "100%", flexShrink: 0 });
}

/**
 * A box around a piece of text: the one thing a decision is made against gets an edge, prose does not.
 *
 * The border is drawn in the terminal's own foreground rather than in the accent, because a border is not a state — and
 * it is left unset when there is no colour, where the border characters are all the emphasis it needs.
 */
function boxed(geometry: Geometry, ink: Theme, content: Renderable): BoxRenderable {
	const frame = new BoxRenderable(geometry.renderer, {
		flexDirection: "column",
		width: "100%",
		flexShrink: 0,
		border: true,
		borderStyle: "rounded",
		...(ink.colour ? { borderColor: RGBA.defaultForeground() } : {}),
		paddingLeft: 2,
		paddingRight: 2,
		paddingTop: 1,
		paddingBottom: 1,
		marginBottom: 1,
	});
	frame.add(content);
	return frame;
}

/**
 * The line a field draws: the prompt, the value, and the one cell the cursor is on, reversed.
 *
 * The terminal's own caret is not used. It lives on a grid the frame does not control, and this screen is redrawn from a
 * body that scrolls; a reversed cell is where the cursor is in the same frame as the text it is in.
 */
function fieldText(
	geometry: Geometry,
	ink: Theme,
	parts: { before: string; under: string; after: string; tag?: string },
): StyledText {
	const chunks: TextChunk[] = [{ ...chunk(`${geometry.glyphs.prompt} `), ...(ink.colour ? { fg: ink.accent } : {}) }];
	if (parts.before !== "") chunks.push(chunk(parts.before));
	chunks.push({ ...chunk(parts.under === "" ? " " : parts.under), attributes: attrs(ink, { inverse: true }) });
	if (parts.after !== "") chunks.push(chunk(parts.after));
	if (parts.tag !== undefined) chunks.push({ ...chunk(` ${parts.tag}`), attributes: attrs(ink, { dim: true }) });
	return new StyledText(chunks);
}

/**
 * A list, with an optional filter.
 *
 * The filter is on for every list rather than for "long" ones: a person who has seen a provider list forty entries long
 * types into the next one that is four. It is started by `/` and not by a letter, because a list is also a place where a
 * person adds and drops entries, and a filter that swallowed those keys would be a list that cannot be edited. `escape`
 * clears the filter before it means "back", so a mistyped letter is one key from gone.
 */
export class ChoiceList implements Body {
	onSelect?: (value: string) => void;
	onCancel?: () => void;
	private readonly geometry: Geometry;
	private readonly ink: Theme;
	private readonly question: string;
	private readonly hint: string | undefined;
	private readonly preface: readonly string[];
	private readonly searchable: boolean;
	private readonly maxVisible: number;
	private readonly all: readonly Choice[];
	private view: BoxRenderable | undefined;
	private query = "";
	private typing = false;
	private index = 0;

	constructor(
		geometry: Geometry,
		options: {
			readonly question: string;
			readonly hint?: string;
			/** Already-painted lines above the question: a review, a plan. Boxed, because a decision is made against it. */
			readonly preface?: readonly string[];
			readonly choices: readonly Choice[];
			readonly searchable?: boolean;
			readonly selected?: string;
			readonly maxVisible?: number;
		},
	) {
		this.geometry = geometry;
		this.ink = theme(geometry.paint);
		this.question = options.question;
		this.hint = options.hint;
		this.preface = options.preface ?? [];
		this.searchable = options.searchable ?? true;
		this.all = options.choices;
		// Six rows are the question, the hint, a blank line and the filter's; the rest of the window is the list's. Four is
		// the smallest list worth scrolling: below that a page hint costs as much as it explains.
		this.maxVisible = Math.max(4, options.maxVisible ?? Math.min(10, geometry.rows - 6));
		this.index = Math.max(
			0,
			this.all.findIndex((choice) => choice.value === options.selected),
		);
	}

	/** What the list is showing now: the filtered rows, in the order they are drawn. */
	visible(): readonly Choice[] {
		const query = this.query.trim().toLowerCase();
		if (query === "") return this.all;
		return this.all.filter((choice) => `${choice.label} ${choice.description ?? ""}`.toLowerCase().includes(query));
	}

	build(): Renderable {
		const root = column(this.geometry);
		this.view = root;
		this.fill(root);
		return root;
	}

	/** The bar moved, or the filter changed what the list shows: the same tree, with its rows drawn again. */
	reflect(): void {
		if (this.view !== undefined) this.fill(this.view);
	}

	private fill(root: BoxRenderable): void {
		for (const child of root.getChildren()) root.remove(child);
		const { window, columns, paint } = this.geometry;
		if (this.preface.length > 0) root.add(this.review());
		root.add(prose(this.geometry, this.ink, paint.heading(this.question), columns));
		if (this.hint !== undefined) root.add(prose(this.geometry, this.ink, paint.dim(this.hint), columns));
		if (this.typing)
			root.add(
				prose(
					this.geometry,
					this.ink,
					`${paint.dim("/")}${this.query === "" ? paint.dim("type to filter") : this.query}`,
					columns,
				),
			);
		root.add(gap(this.geometry));
		const rows = this.visible();
		this.index = Math.min(this.index, Math.max(0, rows.length - 1));
		if (rows.length === 0) {
			root.add(prose(this.geometry, this.ink, paint.dim("no match"), columns));
			return;
		}
		// The window follows the selection: a list longer than the window is scrolled, never cut at a static offset.
		const start = Math.max(0, Math.min(this.index - this.maxVisible + 2, rows.length - this.maxVisible));
		const shown = rows.slice(start, start + this.maxVisible);
		const beside = window >= DESCRIBE_MIN;
		const labelWidth = Math.max(...rows.map((choice) => widthOf(choice.label)));
		shown.forEach((choice, offset) => {
			root.add(this.row(choice, start + offset === this.index, beside, labelWidth));
		});
		if (rows.length > shown.length)
			root.add(
				prose(
					this.geometry,
					this.ink,
					paint.dim(
						`${start + 1}-${start + shown.length} of ${rows.length}  ${this.geometry.glyphs.wait} page up/down`,
					),
					columns,
				),
			);
		// The description column is the first thing a narrow window drops, and the selected row's description then moves
		// under the list as one line, rather than wrapping mid-sentence beside a label.
		const selected = rows[this.index];
		if (!beside && selected?.description !== undefined && selected.description !== "") {
			root.add(gap(this.geometry));
			root.add(prose(this.geometry, this.ink, paint.dim(selected.description), columns));
		}
	}

	/** The lines above the question, boxed when they are what the answer is about rather than a sentence about it. */
	private review(): Renderable {
		const source = this.preface.join("\n");
		const width = this.geometry.columns;
		if (this.preface.length < BOXED_MIN_LINES) return prose(this.geometry, this.ink, source, width, 1);
		return boxed(this.geometry, this.ink, prose(this.geometry, this.ink, source, width - BOXED_INSET));
	}

	/** One row: the bar, the label, and the description in the column beside it when there is room for one. */
	private row(choice: Choice, selected: boolean, beside: boolean, labelWidth: number): TextRenderable {
		const { paint, glyphs } = this.geometry;
		const bar = selected ? paint.accent(glyphs.cursor) : " ";
		const padded = choice.label.padEnd(labelWidth);
		const label = selected ? paint.bold(padded) : padded;
		const description = beside && choice.description !== undefined ? `  ${paint.dim(choice.description)}` : "";
		return prose(this.geometry, this.ink, `${bar} ${label}${description}`, this.geometry.columns);
	}

	handleKey(key: KeyEvent): boolean {
		const rows = this.visible();
		if (key.name === "up") {
			this.index = this.index === 0 ? Math.max(0, rows.length - 1) : this.index - 1;
			return true;
		}
		if (key.name === "down") {
			this.index = this.index >= rows.length - 1 ? 0 : this.index + 1;
			return true;
		}
		if (key.name === "pageup") {
			this.index = Math.max(0, this.index - this.maxVisible);
			return true;
		}
		if (key.name === "pagedown") {
			this.index = Math.min(Math.max(0, rows.length - 1), this.index + this.maxVisible);
			return true;
		}
		if (isEnter(key)) {
			const chosen = rows[this.index];
			if (chosen !== undefined) this.onSelect?.(chosen.value);
			return true;
		}
		if (isEscape(key)) {
			if (this.typing && this.query !== "") {
				this.query = "";
				this.index = 0;
			} else this.onCancel?.();
			return true;
		}
		if (this.typing) {
			if (key.name === "backspace" || key.name === "delete") {
				this.query = this.query.slice(0, -1);
				this.index = 0;
				return true;
			}
			if (key.ctrl && key.name === "u") {
				this.query = "";
				this.index = 0;
				return true;
			}
		}
		const typed = typedChar(key);
		if (typed === undefined || !this.searchable) return false;
		if (!this.typing) {
			if (typed !== "/") return false;
			this.typing = true;
			this.query = "";
			this.index = 0;
			return true;
		}
		this.query += typed;
		this.index = 0;
		return true;
	}
}

/** What both fields carry: the question, the help, the page the answer lives on, and the one line the value is drawn on. */
abstract class Field implements Body {
	onSubmit?: (value: string) => void;
	onCancel?: () => void;
	protected readonly geometry: Geometry;
	protected readonly ink: Theme;
	private readonly question: string;
	private readonly hint: string | undefined;
	private readonly journey: Journey | undefined;
	private readonly flag: string | undefined;
	private readonly required: boolean;
	private readonly validate: ((value: string) => string | undefined) | undefined;
	protected value = "";
	protected cursor = 0;
	protected problem: string | undefined;
	protected notice: string | undefined;
	private view: BoxRenderable | undefined;

	constructor(
		geometry: Geometry,
		options: {
			readonly question: string;
			readonly hint?: string;
			readonly flag?: string;
			readonly journey?: Journey;
			readonly required?: boolean;
			readonly validate?: (value: string) => string | undefined;
		},
	) {
		this.geometry = geometry;
		this.ink = theme(geometry.paint);
		this.question = options.question;
		this.hint = options.hint;
		this.flag = options.flag;
		this.journey = options.journey;
		this.required = options.required ?? true;
		this.validate = options.validate;
	}

	/** How many characters were typed. The value itself is not readable from outside the field, which is the point. */
	get length(): number {
		return this.value.length;
	}

	/** The line the value is drawn on: the field decides how much of it a screen may see. */
	protected abstract echo(): StyledText;

	/** What the field takes from one piece of text: a character, or a paste that arrives as one. */
	protected abstract insert(text: string): void;

	build(): Renderable {
		const root = column(this.geometry);
		this.view = root;
		this.fill(root);
		return root;
	}

	/** A keystroke changed the line, the cursor or the complaint under it: the same tree, drawn again. */
	reflect(): void {
		if (this.view !== undefined) this.fill(this.view);
	}

	private fill(root: BoxRenderable): void {
		for (const child of root.getChildren()) root.remove(child);
		const { columns, paint } = this.geometry;
		root.add(prose(this.geometry, this.ink, paint.heading(this.question), columns));
		if (this.hint !== undefined) root.add(prose(this.geometry, this.ink, paint.dim(this.hint), columns));
		if (this.journey !== undefined)
			root.add(
				prose(
					this.geometry,
					this.ink,
					paint.dim(`ctrl+o opens ${hostOf(this.journey.url)}, ${this.journey.what}`),
					columns,
				),
			);
		if (this.flag !== undefined)
			root.add(
				prose(
					this.geometry,
					this.ink,
					paint.dim(`it is kept out of this screen: pass ${this.flag} to skip the question`),
					columns,
				),
			);
		if (this.notice !== undefined) root.add(prose(this.geometry, this.ink, paint.dim(this.notice), columns));
		root.add(gap(this.geometry));
		root.add(block(this.geometry, this.echo()));
		if (this.problem !== undefined) {
			root.add(gap(this.geometry));
			root.add(prose(this.geometry, this.ink, paint.bad(`${this.geometry.glyphs.fail} ${this.problem}`), columns));
		}
	}

	handleKey(key: KeyEvent): boolean {
		this.notice = undefined;
		if (key.ctrl && key.name === "o" && this.journey !== undefined) {
			openPage(this.journey.url, (problem) => {
				this.notice = problem;
			});
			return true;
		}
		if (isEnter(key)) {
			this.submit();
			return true;
		}
		if (isEscape(key)) {
			this.onCancel?.();
			return true;
		}
		if (this.move(key)) return true;
		const typed = typedChar(key);
		if (typed !== undefined) this.insert(typed);
		return true;
	}

	handlePaste(text: string): boolean {
		this.insert(text.replace(/[\x00-\x1f\x7f]/g, ""));
		return true;
	}

	/** Cursor movement, deletion and the kill keys: the editing a person expects on any line a terminal gives them. */
	private move(key: KeyEvent): boolean {
		if (key.name === "left") this.cursor = Math.max(0, this.cursor - 1);
		else if (key.name === "right") this.cursor = Math.min(this.value.length, this.cursor + 1);
		else if (key.name === "home" || (key.ctrl && key.name === "a")) this.cursor = 0;
		else if (key.name === "end" || (key.ctrl && key.name === "e")) this.cursor = this.value.length;
		else if (key.name === "backspace") {
			if (this.cursor === 0) return true;
			this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
			this.cursor -= 1;
		} else if (key.name === "delete") {
			this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
		} else if (key.ctrl && key.name === "u") {
			this.value = "";
			this.cursor = 0;
		} else if (key.ctrl && key.name === "w") {
			const head = this.value.slice(0, this.cursor).replace(/\s*\S*$/, "");
			this.value = head + this.value.slice(this.cursor);
			this.cursor = head.length;
		} else return false;
		return true;
	}

	private submit(): void {
		const answer = this.value.trim();
		if (answer === "" && this.required) {
			this.problem = "this answer is required";
			return;
		}
		const problem = this.validate?.(answer);
		if (problem !== undefined) {
			this.problem = problem;
			return;
		}
		this.problem = undefined;
		this.onSubmit?.(answer);
	}
}

/** A single-line editor: the question, the hint, and the line a person types into. */
export class TextField extends Field {
	private readonly placeholder: string | undefined;

	constructor(
		geometry: Geometry,
		options: {
			readonly question: string;
			readonly hint?: string;
			readonly value?: string;
			readonly placeholder?: string;
			readonly required?: boolean;
			readonly validate?: (value: string) => string | undefined;
			readonly journey?: Journey;
		},
	) {
		super(geometry, options);
		this.value = options.value ?? "";
		// The cursor starts at the end: a prefilled answer is edited from its end, not inserted in front of.
		this.cursor = this.value.length;
		this.placeholder = options.placeholder;
	}

	/** The argument is accepted on the next submit; this is what a field remembers across a revalidation. */
	accept(value: string): void {
		this.value = value;
		this.cursor = value.length;
		this.reflect();
	}

	protected echo(): StyledText {
		if (this.value === "" && this.placeholder !== undefined) {
			const { paint, glyphs } = this.geometry;
			return this.ink.line(`${paint.accent(glyphs.prompt)} ${paint.dim(this.placeholder)}`);
		}
		return fieldText(this.geometry, this.ink, {
			before: this.value.slice(0, this.cursor),
			under: this.value.slice(this.cursor, this.cursor + 1),
			after: this.value.slice(this.cursor + 1),
		});
	}

	protected insert(text: string): void {
		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
	}
}

/**
 * A field that never echoes what is typed.
 *
 * There is no cursor movement inside the value on purpose: a secret is typed once, pasted whole, and corrected with
 * backspace, and the arrow keys are left to move nothing rather than a cursor the screen is not showing. The value goes to
 * `onSubmit` and nowhere else — not to a render, not to an error, not to the terminal.
 */
export class MaskedField extends Field {
	protected echo(): StyledText {
		const { glyphs } = this.geometry;
		const masked = glyphs.mask.repeat(this.value.length);
		// The cursor cell trails the mask, so a backspace is visible on the last character even before the count changes.
		return fieldText(this.geometry, this.ink, { before: masked, under: "", after: "", tag: String(this.value.length) });
	}

	protected insert(text: string): void {
		this.value += text;
		this.cursor = this.value.length;
	}
}

/**
 * A page: prose with nothing to type, which is what a review, a summary and a completion screen are.
 *
 * `lines` are already painted by the caller — a page is not a form, and a component that interpreted the words it was
 * given would need a small language for them. What this adds is the count: a page taller than the body says so in the
 * footer, and the arrows then belong to the frame rather than to the page.
 */
export class NoteView implements Body {
	onContinue?: () => void;
	onCancel?: () => void;
	/** The arrows scroll the frame, which is the only thing on the screen that can move. */
	onScroll?: (delta: number) => void;
	/** How many rows the page took the last time it was built: the screen reads this to say whether it scrolls. */
	rows = 0;
	private readonly geometry: Geometry;
	private readonly ink: Theme;
	private readonly title: string;
	private readonly lines: readonly string[];
	private readonly note: string | undefined;

	constructor(
		geometry: Geometry,
		options: { readonly title: string; readonly lines: readonly string[]; readonly note?: string },
	) {
		this.geometry = geometry;
		this.ink = theme(geometry.paint);
		this.title = options.title;
		this.lines = options.lines;
		this.note = options.note;
	}

	build(): Renderable {
		const { columns, paint } = this.geometry;
		const root = column(this.geometry);
		const source = this.lines.map((line) => (line === "" ? " " : line)).join("\n");
		let rows = 0;
		const add = (text: string, marginBottom = 0): void => {
			const drawn = this.ink.paragraph(text, columns);
			rows += drawn.rows;
			root.add(block(this.geometry, drawn.text, marginBottom));
		};
		add(paint.heading(this.title));
		add(" ");
		// The same rule as a list's review: prose is prose, and an edge marks what has to be read before the key is pressed.
		const body = this.ink.paragraph(source, columns);
		rows += body.rows;
		if (this.lines.length < BOXED_MIN_LINES) root.add(block(this.geometry, body.text));
		else {
			rows += 4 + 2;
			root.add(boxed(this.geometry, this.ink, block(this.geometry, this.ink.paragraph(source, columns - BOXED_INSET).text)));
		}
		if (this.note !== undefined && this.note !== "") {
			add(" ");
			add(paint.bold(this.note));
		}
		this.rows = rows;
		return root;
	}

	handleKey(key: KeyEvent): boolean {
		if (isEnter(key) || typedChar(key) === " ") {
			this.onContinue?.();
			return true;
		}
		if (isEscape(key)) {
			this.onCancel?.();
			return true;
		}
		if (key.name === "down") {
			this.onScroll?.(1);
			return true;
		}
		if (key.name === "up") {
			this.onScroll?.(-1);
			return true;
		}
		return false;
	}
}

/**
 * The rows an apply, an environment check or a completion screen shows.
 *
 * A running row draws a spinner from the clock rather than owning a timer: the screen repaints while an operation is in
 * flight, and a component that schedules its own interval is a component that leaks one when a step throws.
 */
export class StatusList implements Body {
	onKey?: (key: string) => void;
	private rows: readonly StatusRow[];
	private note: string | undefined;
	private readonly geometry: Geometry;
	private readonly ink: Theme;
	private readonly title: string | undefined;
	private readonly now: () => number;
	private drawn: TextRenderable | undefined;
	private detail: TextRenderable | undefined;

	constructor(
		geometry: Geometry,
		rows: readonly StatusRow[],
		options: { readonly title?: string; readonly note?: string; readonly now?: () => number } = {},
	) {
		this.geometry = geometry;
		this.ink = theme(geometry.paint);
		this.rows = rows;
		this.note = options.note;
		this.title = options.title;
		this.now = options.now ?? Date.now;
	}

	set(rows: readonly StatusRow[], note?: string): void {
		this.rows = rows;
		if (note !== undefined) this.note = note;
		this.reflect();
	}

	/** One turn of the spinner: a running row is the only thing on any screen that moves, and the screen times it. */
	tick(): void {
		this.reflect();
	}

	/** The rows changed: the one text they are drawn in is rewritten, because a status list is one block and not a tree. */
	reflect(): void {
		if (this.drawn === undefined) return;
		this.drawn.content = this.ink.paragraph(this.markRows(), this.geometry.columns).text;
		if (this.detail !== undefined && this.note !== undefined)
			this.detail.content = this.ink.paragraph(this.note, this.geometry.columns).text;
	}

	build(): Renderable {
		const { columns, paint } = this.geometry;
		const root = column(this.geometry);
		if (this.title !== undefined) root.add(prose(this.geometry, this.ink, paint.heading(this.title), columns));
		this.drawn = prose(this.geometry, this.ink, this.markRows(), columns);
		root.add(this.drawn);
		this.detail =
			this.note === undefined ? undefined : prose(this.geometry, this.ink, paint.bold(this.note), columns);
		if (this.detail !== undefined) {
			root.add(gap(this.geometry));
			root.add(this.detail);
		}
		return root;
	}

	handleKey(key: KeyEvent): boolean {
		if (this.onKey === undefined) return false;
		if (isEnter(key)) this.onKey("enter");
		else if (isEscape(key)) this.onKey("escape");
		else {
			const typed = typedChar(key);
			if (typed === undefined) return false;
			this.onKey(typed.toLowerCase());
		}
		return true;
	}

	/** Every row as one painted string: the mark, the label, and the detail under it when there is one. */
	private markRows(): string {
		const { paint, glyphs } = this.geometry;
		const lines: string[] = [];
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
			lines.push(`${mark} ${label}`);
			if (row.detail !== undefined && row.detail !== "") lines.push(`  ${paint.dim(row.detail)}`);
		}
		if (this.note !== undefined && this.note !== "") lines.push("", paint.bold(this.note));
		return lines.join("\n");
	}
}

/** The host a journey's page is on: what a one-line pointer can afford to name, and what a person recognizes. */
function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/**
 * Open a page in the person's own browser.
 *
 * Three commands in the order a machine is likely to have one: `xdg-open` on Linux, `open` on macOS, `wslview` under WSL.
 * Each is spawned detached with its output thrown away, because a browser that writes to a wizard's terminal is a browser
 * that draws over the screen. Nothing here throws: a page that cannot be opened is a sentence on the screen, and the
 * person still has the address in front of them.
 */
function openPage(url: string, report: (problem: string) => void): void {
	const commands = ["xdg-open", "open", "wslview"];
	const attempt = (index: number): void => {
		const command = commands[index];
		if (command === undefined) {
			report(`could not open ${hostOf(url)}: open ${url} yourself`);
			return;
		}
		const child = spawn(command, [url], { detached: true, stdio: "ignore" });
		child.on("error", () => attempt(index + 1));
		child.on("spawn", () => child.unref());
	};
	attempt(0);
}
