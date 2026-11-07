/**
 * The frame every screen lives inside: the brand, where the person is, what this screen is called, and the keys that
 * work here.
 *
 * The point of a frame rather than a sequence of prompts is that these four things never move. The brand and the step
 * counter sit at the top, the section title under them, the keys at the bottom, and only the middle changes — so a
 * person who has learned one screen has learned every screen, including the two they have not seen yet.
 *
 * It is three components, not one, because the middle is the only part that scrolls: the application puts the body in a
 * scroll view between the other two, so a window ten rows tall keeps its header and its keys and gives what is left to
 * the content. `Frame.render` — the whole document, unbounded — is what a test and the alternate screen's exit both use.
 *
 * Spacing is fixed rather than negotiated: two columns of margin on the body at every width, one blank line under the
 * header. A narrow window narrows the content; it does not re-flow the frame, because a layout that changes shape at 69
 * columns is a layout that has to be designed twice.
 */
import { type Component, Container, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Glyphs, type Paint, spread } from "./style.ts";

/** Where the person is: what this screen is, and how far along the flow it sits. */
export interface Context {
	/** `mason`, or whatever the application calls itself. */
	readonly brand: string;
	/** The section, as a heading: "Model and provider". */
	readonly title: string;
	/** One-based, of `total`. `total` of one draws no counter: a single screen is not a flow. */
	readonly index: number;
	readonly total: number;
	/** One line under the brand, used once: "first run". */
	readonly subtitle?: string;
}

/** A key and what it does. The key is drawn in the accent; the label dim, so the eye skips it after the first screen. */
export interface Hint {
	readonly key: string;
	readonly label: string;
}

/** The margin the body gets on each side: two columns is enough to keep text off the edge without eating a narrow window. */
export const MARGIN = 2;

/** The lines the frame spends on everything but the body: three above, two below. A screen sizes a list against this. */
export const CHROME_ROWS = 5;

class Padded implements Component {
	private readonly child: Component;
	private readonly margin: number;

	constructor(child: Component, margin: number) {
		this.child = child;
		this.margin = margin;
	}

	render(width: number): string[] {
		const room = Math.max(1, width - this.margin * 2);
		const pad = " ".repeat(this.margin);
		return [...this.child.render(room).map((line) => truncateToWidth(`${pad}${line}`, width)), ""];
	}

	invalidate(): void {
		this.child.invalidate();
	}
}

class Header implements Component {
	private readonly frame: Frame;

	constructor(frame: Frame) {
		this.frame = frame;
	}

	render(width: number): string[] {
		const { paint, glyphs } = this.frame.style;
		const context = this.frame.context;
		const brand = paint.bold(context.brand);
		const subtitle = context.subtitle === undefined ? "" : ` ${paint.dim(context.subtitle)}`;
		// A flow of one says nothing about progress; a flow of six says "2 of 6" always, and the dots only when the width
		// pays for them. The counter is the fact; the dots are the shape of it.
		const counter = context.total > 1 ? paint.dim(`step ${context.index} of ${context.total}`) : "";
		const dots = context.total > 1 && context.total <= 12 && width >= 68 ? progressDots(context, paint, glyphs) : "";
		const title = truncateToWidth(paint.heading(context.title), width);
		return [
			spread(`${brand}${subtitle}`, counter, width),
			spread(title, dots, width),
			paint.dim(glyphs.rule.repeat(Math.max(0, width))),
			"",
		];
	}

	invalidate(): void {}
}

/** `●●○○○○`: filled for what is behind, hollow for what is ahead. Read left to right, never animated. */
function progressDots(context: Context, paint: Paint, glyphs: Glyphs): string {
	void glyphs;
	const filled = paint.accent("●");
	const hollow = paint.dim("○");
	return Array.from({ length: context.total }, (_, index) => (index < context.index ? filled : hollow)).join(" ");
}

class Footer implements Component {
	private readonly frame: Frame;

	constructor(frame: Frame) {
		this.frame = frame;
	}

	render(width: number): string[] {
		const { paint, glyphs } = this.frame.style;
		const rule = paint.dim(glyphs.rule.repeat(Math.max(0, width)));
		const hints = this.frame.hints;
		if (hints.length === 0) return [rule];
		// Drop the least important hint rather than wrapping: a footer that wraps is a footer with two lines on a narrow
		// window and one on a wide one, which is the one thing a persistent frame must not do.
		const rendered = hints.map((hint) => `${paint.accent(hint.key)} ${paint.dim(hint.label)}`);
		let kept = rendered.length;
		while (kept > 1 && rendered.slice(0, kept).join("   ").length > width) kept -= 1;
		const line = rendered.slice(0, kept).join("   ");
		return [rule, truncateToWidth(line, width)];
	}

	invalidate(): void {}
}

export class Frame {
	readonly header: Component;
	readonly footer: Component;
	/** The body slot: what a screen replaces. */
	readonly body = new Container();
	/** The body as the application mounts it: padded, and the only part that may scroll. */
	readonly surface: Component;
	private readonly padded: Padded;
	private frameContext: Context = { brand: "mason", title: "", index: 1, total: 1 };
	private frameHints: readonly Hint[] = [];
	readonly style: { readonly paint: Paint; readonly glyphs: Glyphs };

	constructor(style: { readonly paint: Paint; readonly glyphs: Glyphs }) {
		this.style = style;
		this.header = new Header(this);
		this.footer = new Footer(this);
		this.padded = new Padded(this.body, MARGIN);
		this.surface = this.padded;
	}

	get context(): Context {
		return this.frameContext;
	}

	get hints(): readonly Hint[] {
		return this.frameHints;
	}

	setContext(context: Context): void {
		this.frameContext = context;
	}

	setHints(hints: readonly Hint[]): void {
		this.frameHints = hints;
	}

	/** Replace the body: one child at a time, so no screen can leave half of itself behind. */
	mount(body: Component | undefined): void {
		this.body.clear();
		if (body !== undefined) this.body.addChild(body);
	}

	/** The whole document at `width`, the way a test and the alternate screen's restore both read it. */
	render(width: number): string[] {
		return [...this.header.render(width), ...this.padded.render(width), ...this.footer.render(width)];
	}

	/** A one-line caption, wrapped: what the review and the completion screens are made of. */
	static lines(text: string, width: number, style: (value: string) => string): string[] {
		return wrapTextWithAnsi(text, Math.max(1, width)).map((line) => style(line));
	}
}
