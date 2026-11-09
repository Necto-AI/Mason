/**
 * The frame every screen lives inside: where the person is, what this screen is called, and the keys that work here.
 *
 * The point of a frame rather than a sequence of prompts is that these four things never move. The section and the step
 * counter sit at the top, a hairline under them, the keys at the bottom, and only the middle changes — so a person who has
 * learned one screen has learned every screen, including the two they have not seen yet.
 *
 * The middle is a scroll region flanked by nothing but the frame's own padding, and the body inside it is centred when it
 * is short and scrolls from the top when it is long: a wizard whose questions start at the top edge of a tall window
 * reads as a log, and one whose list is cut off with no way to scroll is a bug. The wordmark is the brand, so it is drawn
 * where the brand belongs — at the top of the first screen's body, never in the chrome, which would cost three rows on
 * six screens that do not need it.
 *
 * Spacing is fixed rather than negotiated: two columns of margin at every width, one more inside the scroll region so the
 * body has an edge, and a measure capped at `MEASURE` columns so a 200-column window does not stretch a paragraph across
 * the room. A narrow window narrows the content; it does not re-flow the frame, because a layout that changes shape at 69
 * columns is a layout that has to be designed twice.
 */
import {
	ASCIIFontRenderable,
	BoxRenderable,
	type CliRenderer,
	type ColorInput,
	type Renderable,
	ScrollBoxRenderable,
	TextRenderable,
} from "@opentui/core";
import { spinnerFrame } from "./components.ts";
import { type Glyphs, type Paint, widthOf } from "./style.ts";
import { type Theme, theme } from "./theme.ts";

/** Where the person is: what this screen is, and how far along the flow it sits. */
export interface Context {
	/** `mason`, or whatever the application calls itself: the wordmark on the first screen and the window's title. */
	readonly brand: string;
	/** The section, as a heading: "Model and provider". */
	readonly title: string;
	/** One-based, of `total`. `total` of one draws no counter: a single screen is not a flow. */
	readonly index: number;
	readonly total: number;
	/** One line for the window's title, used once: "first run". */
	readonly subtitle?: string;
}

/** A key and what it does. The key is drawn in the accent; the label dim, so the eye skips it after the first screen. */
export interface Hint {
	readonly key: string;
	readonly label: string;
}

/** The margin the frame puts between the window's edge and any text: two columns, at every width. */
export const MARGIN = 2;

/** The lines the frame spends on everything but the body: the section, two hairlines and the keys. */
export const CHROME_ROWS = 4;

/** The widest a body may draw, so prose does not stretch across a wide window. */
export const MEASURE = 86;

/** One more column of inset inside the scroll region, so the body sits clear of the frame's edge. */
const INSET = 1;

/** The columns a body may draw at a window of `columns`: the margins out, capped at `MEASURE`. */
export function measure(columns: number): number {
	return Math.max(12, Math.min(MEASURE, columns - MARGIN * 2 - INSET));
}

/** The rows a body has at a window of `rows`. */
export function bodyRows(rows: number): number {
	return Math.max(3, rows - CHROME_ROWS);
}

/** A hairline long enough for any window: the box clips it, which is cheaper than measuring it a frame later. */
const RULE = "─".repeat(400);

export interface FrameOptions {
	readonly renderer: CliRenderer;
	readonly paint: Paint;
	readonly glyphs: Glyphs;
}

export class Frame {
	readonly style: { readonly paint: Paint; readonly glyphs: Glyphs };
	/** The whole frame, mounted once: a screen replaces the body, not the root. */
	readonly root: BoxRenderable;
	private readonly renderer: CliRenderer;
	private readonly ink: Theme;
	private readonly section: TextRenderable;
	private readonly counter: TextRenderable;
	private readonly keys: TextRenderable;
	private readonly content: BoxRenderable;
	private readonly scroll: ScrollBoxRenderable;
	private readonly wordmark: ASCIIFontRenderable;
	private whereabouts: Context = { brand: "mason", title: "", index: 1, total: 1 };
	private busy = false;
	private hints: readonly Hint[] = [];
	private body: Renderable | undefined;
	private columns: number;

	constructor(options: FrameOptions) {
		const { renderer } = options;
		this.renderer = renderer;
		this.style = { paint: options.paint, glyphs: options.glyphs };
		this.ink = theme(options.paint);
		this.columns = renderer.width;

		this.root = new BoxRenderable(renderer, {
			flexDirection: "column",
			width: "100%",
			height: "100%",
			paddingLeft: MARGIN,
			paddingRight: MARGIN,
		});

		const head = new BoxRenderable(renderer, { flexDirection: "row", width: "100%", flexShrink: 0 });
		const left = new BoxRenderable(renderer, { flexGrow: 1, flexShrink: 1, flexDirection: "row" });
		this.section = new TextRenderable(renderer, { content: "", wrapMode: "none", flexShrink: 0 });
		left.add(this.section);
		const right = new BoxRenderable(renderer, { flexShrink: 0, flexDirection: "row" });
		this.counter = new TextRenderable(renderer, { content: "", wrapMode: "none", flexShrink: 0 });
		right.add(this.counter);
		head.add(left);
		head.add(right);
		this.root.add(head);

		this.root.add(this.hairline());

		this.scroll = new ScrollBoxRenderable(renderer, {
			flexGrow: 1,
			flexShrink: 1,
			width: "100%",
			scrollY: true,
			scrollX: false,
		});
		this.scroll.verticalScrollBar.visible = false;
		this.content = new BoxRenderable(renderer, {
			flexDirection: "column",
			width: "100%",
			minHeight: "100%",
			justifyContent: "center",
			paddingLeft: INSET,
		});
		this.scroll.add(this.content);
		this.root.add(this.scroll);

		this.root.add(this.hairline());
		this.keys = new TextRenderable(renderer, { content: "", wrapMode: "none", flexShrink: 0 });
		this.root.add(this.keys);

		this.wordmark = new ASCIIFontRenderable(renderer, {
			text: "mason",
			font: this.fontFor(this.columns),
			color: this.markColour(options.paint),
			flexShrink: 0,
			visible: false,
		});
	}

	/** What the frame is showing, which is the flow's whereabouts and not its own. */
	get context(): Context {
		return this.whereabouts;
	}

	setContext(context: Context): void {
		this.whereabouts = context;
		const { paint, glyphs } = this.style;
		this.section.content = this.ink.line(paint.heading(`${glyphs.section} ${context.title}`));
		this.drawCounter();
		this.wordmark.visible = this.isWelcome();
		this.place();
	}

	/**
	 * A network call is running: the chrome says so, in the one place that is on every screen.
	 *
	 * A screen that shows nothing while it waits for a provider is a screen a person decides is broken, and every flow
	 * in this repository waits on something — a completion, a catalog, a container. The spinner rides beside the step
	 * counter rather than in a body, because it has to move whether or not the body knows how to tick.
	 */
	setBusy(on: boolean): void {
		this.busy = on;
		this.drawCounter();
	}

	/** One turn of the spinner's clock. The screen owns the timer; the frame owns what it draws. */
	tick(): void {
		if (this.busy) this.drawCounter();
	}

	private drawCounter(): void {
		const { paint } = this.style;
		const step = this.whereabouts.total > 1 ? `step ${this.whereabouts.index} / ${this.whereabouts.total}` : "";
		const marker = this.busy ? `${spinnerFrame(this.style.glyphs)} ` : "";
		this.counter.content = this.ink.line(`${paint.accent(marker)}${paint.dim(step)}`);
	}

	/** The keys this screen carries. They are dropped rather than wrapped when the window is too narrow for all of them. */
	setHints(hints: readonly Hint[]): void {
		this.hints = hints;
		this.refreshHints();
	}

	/** Mount a screen's body: one at a time, so no screen can leave half of itself behind. */
	mount(body: Renderable | undefined): void {
		this.body = body;
		this.place();
	}

	/** Scroll the body: a page is the one screen whose arrows belong to the frame rather than to a field. */
	scrollBy(delta: number): void {
		this.scroll.scrollBy(delta);
	}

	/** Re-draw what depends on the window's width: the keys that fit, and the width of the wordmark. */
	setColumns(columns: number): void {
		this.columns = columns;
		this.wordmark.font = this.fontFor(columns);
		this.refreshHints();
	}

	private place(): void {
		for (const child of this.content.getChildren()) this.content.remove(child);
		if (this.isWelcome()) this.content.add(this.wordmark);
		if (this.body !== undefined) this.content.add(this.body);
	}

	/**
	 * Whether this is the first screen of a flow.
	 *
	 * The wordmark is the brand, so it is drawn where the brand belongs — at the top of the first body, never in the chrome,
	 * which would cost three rows on six screens that do not need it. A flow of one screen is not a flow: `mason setup`
	 * asks its questions in place, and a brand over every one of them would be a brand that never leaves.
	 */
	private isWelcome(): boolean {
		return this.whereabouts.total > 1 && this.whereabouts.index === 1;
	}

	private refreshHints(): void {
		const { paint } = this.style;
		const room = this.columns - MARGIN * 2;
		const drawn = this.hints.map((hint) => `${paint.accent(hint.key)} ${paint.dim(hint.label)}`);
		// The least important hint is the last one, and it is dropped rather than wrapped: a footer that wraps is a footer
		// with two lines on a narrow window and one on a wide one, which is the one thing a persistent frame must not do.
		let kept = drawn.length;
		while (kept > 1 && widthOf(drawn.slice(0, kept).join("   ")) > room) kept -= 1;
		this.keys.content = this.ink.line(drawn.slice(0, kept).join("   "));
	}

	private hairline(): TextRenderable {
		return new TextRenderable(this.renderer, {
			content: this.ink.line(this.style.paint.dim(RULE)),
			wrapMode: "none",
			width: "100%",
			flexShrink: 0,
		});
	}

	private fontFor(columns: number): "block" | "tiny" {
		return columns >= 80 ? "block" : "tiny";
	}

	/** The wordmark is the one thing drawn in the accent without meaning a state: it is the brand, and it is the brand's. */
	private markColour(paint: Paint): ColorInput | undefined {
		return paint.colour ? this.ink.accent : undefined;
	}
}
