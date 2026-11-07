/**
 * The terminal implementation of `Screen`: one alternate-screen application, one frame, and a body that is replaced
 * rather than a sequence of prompts printed one after another.
 *
 * The alternate screen is what makes the layout persistent. On the main screen a TUI appends and repaints in the
 * scrollback, which is right for a transcript and wrong for a wizard: the header would scroll away on the fifth question
 * and the keys would be one screen behind. In the alternate screen the window is the application's, the header and the
 * footer never move, and the body scrolls inside them — and when it stops, pi-tui restores the terminal and prints the
 * last screen as ordinary text, so the summary of what was installed survives the exit.
 *
 * Everything a person can press is matched by the same keys as every other mason prompt (`escape` back, `enter`
 * continue), and `ctrl+c` is the one key that does not belong to the frame: in raw mode it is a byte, not a signal, so
 * this file is where it becomes a clean stop and a status.
 */
import {
	type Component,
	Container,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	type Terminal,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import {
	type Choice,
	ChoiceList,
	type Geometry,
	MaskedInput,
	NoteView,
	StatusList,
	type StatusRow,
	TextField,
	typedChar,
} from "./components.ts";
import { CHROME_ROWS, type Context, Frame, type Hint, MARGIN } from "./frame.ts";
import { Cancelled, type Page, type Progress, type Question, type Screen, type Where } from "./screen.ts";
import { type Glyphs, type Paint, terminalStyle } from "./style.ts";

const ENTER: Hint = { key: "enter", label: "" };
const BACK: Hint = { key: "esc", label: "back" };
const QUIT: Hint = { key: "ctrl+c", label: "quit" };

/** The footer every screen carries, in one order: what continues, what goes back, what stops. */
function hints(action: "select" | "continue" | "scroll"): readonly Hint[] {
	// A page that does not fit says the arrows scroll it and enter still continues: both are true at once, and a footer
	// that names only the keys that fit is a footer that hides the one the person needs.
	if (action === "scroll") return [{ key: "up/down", label: "scroll" }, { ...ENTER, label: "continue" }, BACK, QUIT];
	return [{ ...ENTER, label: action === "select" ? "select" : action }, BACK, QUIT];
}

/**
 * The blank line the padded body keeps under its content.
 *
 * `CHROME_ROWS` counts the frame, and the body still spends one row of its own on the blank line that keeps text off the
 * footer rule: a page sized to `rows - CHROME_ROWS` loses its last line, which is why the measurement subtracts this too.
 */
const BODY_TAIL = 1;

/** A running operation repaints on a timer of its own: a spinner that waits for the next keypress is not a spinner. */
const SPINNER_REPAINT_MS = 80;

export interface TerminalScreenOptions {
	/** Injected by a test with a terminal that records writes; the default is this process's own. */
	readonly terminal?: Terminal;
	readonly paint?: Paint;
	readonly glyphs?: Glyphs;
	readonly subtitle?: string;
}

export class TerminalScreen implements Screen {
	private readonly tui: TuiAltScreen;
	private readonly frame: Frame;
	private readonly terminal: Terminal;
	private stopBusy: (() => void) | undefined;
	private closed = false;
	private location: Context = { brand: "mason", title: "", index: 1, total: 1 };

	constructor(options: TerminalScreenOptions = {}) {
		const style = terminalStyle();
		this.frame = new Frame({ paint: options.paint ?? style.paint, glyphs: options.glyphs ?? style.glyphs });
		this.terminal = options.terminal ?? new ProcessTerminal();
		this.tui = new TuiAltScreen(this.terminal);
		this.location = { ...this.location, ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }) };
		const scroll = new ScrollView(this.frame.surface, { primary: true, scrollbar: "auto" });
		this.tui.setLayoutRoot(
			new VStack([
				{ component: this.frame.header, basis: "auto" },
				{ component: scroll, basis: 0, grow: 1, minSize: 3 },
				{ component: this.frame.footer, basis: "auto" },
			]),
		);
		this.tui.addInputListener((data) => {
			if (!matchesKey(data, "ctrl+c")) return undefined;
			this.close();
			process.exit(130);
		});
		this.tui.start();
		this.terminal.setTitle("mason · first run");
		this.paint(undefined);
	}

	/** The real screen, or a refusal: a flow that needs keys cannot be run against a pipe. */
	static open(options: TerminalScreenOptions = {}): TerminalScreen {
		if (process.stdin.isTTY !== true || process.stdout.isTTY !== true)
			throw new Error("this needs a terminal: run it from one, or pass --yes to answer with flags");
		return new TerminalScreen(options);
	}

	get look(): { readonly paint: Paint; readonly glyphs: Glyphs } {
		return this.frame.style;
	}

	get columns(): number {
		return Math.max(20, this.terminal.columns);
	}

	get rows(): number {
		return Math.max(8, this.terminal.rows);
	}

	/** The room a body has: the window, less the frame and the blank line the padded body keeps. */
	private bodyRows(): number {
		return Math.max(4, this.rows - CHROME_ROWS - BODY_TAIL);
	}

	/** The room a body has: the window, less the frame. A list sizes itself against this. */
	private geometry(): Geometry {
		return {
			columns: this.columns,
			rows: this.bodyRows(),
			paint: this.frame.style.paint,
			glyphs: this.frame.style.glyphs,
		};
	}

	where(context: Where): void {
		this.location = { ...this.location, ...context };
		this.frame.setContext(this.location);
		// Forced: the header and the step count are the flow's whereabouts, and they are stale the moment they change.
		this.tui.requestRender(true);
	}

	/** Mount a body and give it the keyboard. Nothing else is mounted, so a screen cannot render under another one. */
	private paint(body: Component | undefined, focus: Component | null = null): void {
		this.frame.mount(body);
		this.tui.setFocus(focus);
		this.tui.requestRender(true);
	}

	/** Mount a body with the hints its screen carries: the body draws its own question, so the title is the flow's. */
	private show(bodyHints: readonly Hint[], body: Component, focus: Component | null): void {
		this.frame.setHints(bodyHints);
		this.paint(body, focus);
	}

	private clear(): void {
		this.frame.setHints([]);
		this.paint(undefined, null);
	}

	async select(_id: string, title: string, choices: readonly Choice[], options: Question = {}): Promise<string> {
		return await new Promise<string>((resolve, reject) => {
			const list = new ChoiceList(this.geometry(), {
				question: title,
				...(options.hint === undefined ? {} : { hint: options.hint }),
				...(options.preface === undefined ? {} : { preface: options.preface }),
				choices,
				...(options.value === undefined ? {} : { selected: options.value }),
			});
			list.onSelect = (value) => {
				this.clear();
				resolve(value);
			};
			list.onCancel = () => {
				this.clear();
				reject(new Cancelled());
			};
			this.show(hints("select"), list, list);
		});
	}

	async text(_id: string, title: string, options: Question = {}): Promise<string> {
		return await new Promise<string>((resolve, reject) => {
			const field = new TextField(this.geometry(), {
				question: title,
				...(options.hint === undefined ? {} : { hint: options.hint }),
				...(options.value === undefined ? {} : { value: options.value }),
				...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
				...(options.required === undefined ? {} : { required: options.required }),
				...(options.validate === undefined ? {} : { validate: options.validate }),
			});
			field.onSubmit = (value) => {
				this.clear();
				resolve(value);
			};
			field.onCancel = () => {
				this.clear();
				reject(new Cancelled());
			};
			this.show(hints("continue"), field, field);
		});
	}

	async secret(_id: string, title: string, options: Question = {}): Promise<string> {
		return await new Promise<string>((resolve, reject) => {
			const field = new MaskedInput(this.geometry(), {
				question: title,
				...(options.hint === undefined ? {} : { hint: options.hint }),
				...(options.flag === undefined ? {} : { flag: options.flag }),
			});
			field.onSubmit = (value) => {
				this.clear();
				resolve(value);
			};
			field.onCancel = () => {
				this.clear();
				reject(new Cancelled());
			};
			this.show(hints("continue"), field, field);
		});
	}

	async confirm(id: string, title: string, options: { readonly yes: string; readonly no: string }): Promise<boolean> {
		const picked = await this.select(
			id,
			title,
			[
				{ value: "yes", label: options.yes },
				{ value: "no", label: options.no },
			],
			{ hint: "escape goes back without changing anything" },
		);
		return picked === "yes";
	}

	async note(_id: string, title: string, page: Page): Promise<void> {
		return await new Promise<void>((resolve, reject) => {
			const lines = [this.frame.style.paint.heading(title), "", ...page.lines];
			if (page.note !== undefined && page.note !== "") lines.push("", this.frame.style.paint.bold(page.note));
			const view = new NoteView(lines);
			// The keys are the screen's, not the page's: a page is the one screen that can be longer than the window, and the
			// arrows have to reach the scroll view rather than be swallowed by the thing being scrolled.
			const stop = this.tui.addInputListener((data) => {
				if (matchesKey(data, "enter") || typedChar(data) === " ") {
					stop();
					this.clear();
					resolve();
					return { consume: true };
				}
				if (matchesKey(data, "escape")) {
					stop();
					this.clear();
					reject(new Cancelled());
					return { consume: true };
				}
				// A page is not an editor, so the arrows scroll it: the alt screen leaves them alone by default, because
				// every other screen on it has a field that wants them.
				if (matchesKey(data, "down")) {
					this.tui.scrollBy(1);
					return { consume: true };
				}
				if (!matchesKey(data, "up")) return undefined;
				this.tui.scrollBy(-1);
				return { consume: true };
			});
			const overflows = view.render(this.columns - 2 * MARGIN).length > this.bodyRows();
			this.show(overflows ? hints("scroll") : hints("continue"), view, null);
		});
	}

	progress(_id: string, title: string, rows: readonly StatusRow[]): Progress {
		const list = new StatusList(this.geometry(), rows);
		const waiter: { resolve?: (key: string) => void; keys: readonly string[] } = { keys: [] };
		list.onKey = (key) => {
			if (!waiter.keys.includes(key)) return;
			const settle = waiter.resolve;
			waiter.resolve = undefined;
			waiter.keys = [];
			settle?.(key);
		};
		// No `enter` hint while the steps run: it means something only once one of them has failed, and `key()` below is
		// what says so. A footer that advertises a key that does nothing is a footer that lies on every frame.
		this.show([QUIT], stack([new NoteView([this.frame.style.paint.heading(title)]), list]), list);
		return {
			update: (next, note) => {
				list.set(next, note);
				// Forced: an operation line is progress, and progress that arrives after the next keypress is not.
				this.tui.requestRender(true);
			},
			key: async (hints) => {
				waiter.keys = hints.map((hint) => hint.key);
				this.frame.setHints(hints.map((hint): Hint => ({ key: hint.key, label: hint.label })));
				// Forced: these hints are the only thing telling the person what to press, so they are on screen before
				// the wait for the press starts.
				this.tui.requestRender(true);
				return await new Promise<string>((resolve) => {
					waiter.resolve = resolve;
				});
			},
			close: () => {
				this.clear();
			},
		};
	}

	busy(on: boolean): void {
		if (!on) {
			this.stopBusy?.();
			this.stopBusy = undefined;
			return;
		}
		if (this.stopBusy !== undefined) return;
		const timer = setInterval(() => this.tui.requestRender(), SPINNER_REPAINT_MS);
		this.stopBusy = () => clearInterval(timer);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.stopBusy?.();
		this.stopBusy = undefined;
		this.tui.stop();
	}
}

/** Children one after another, which is all a body made of two blocks needs. */
function stack(children: readonly Component[]): Component {
	const container = new Container();
	for (const child of children) container.addChild(child);
	return container;
}
