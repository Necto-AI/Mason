/**
 * The terminal implementation of `Screen`: one alternate-screen application, one frame, and a body that is replaced
 * rather than a sequence of prompts printed one after another.
 *
 * The alternate screen is what makes the layout persistent. On the main screen a TUI appends and repaints in the
 * scrollback, which is right for a transcript and wrong for a wizard: the section would scroll away on the fifth question
 * and the keys would be one screen behind. In the alternate screen the window is the application's, the chrome never
 * moves, and the body scrolls inside it. When it stops, the screen is discarded — so `close()` reprints the last frame as
 * plain rows, and the summary of what was installed survives in the scrollback where a person can still read it.
 *
 * Everything a person can press is matched by the same keys as every other mason prompt (`escape` back, `enter`
 * continue), and `ctrl+c` is the one key that does not belong to the frame: in raw mode it is a byte, not a signal, so
 * this file is where it becomes a clean stop and a status.
 */
import { CliRenderer, type KeyEvent, type PasteEvent, type Renderable } from "@opentui/core";
import {
	type Body,
	type Choice,
	ChoiceList,
	type Geometry,
	MaskedField,
	NoteView,
	type StatusRow,
	StatusList,
	TextField,
} from "./components.ts";
import { type Context, Frame, type Hint, bodyRows, measure } from "./frame.ts";
import { Cancelled, type Page, type Progress, type Question, type Screen, type Where } from "./screen.ts";
import { type Glyphs, type Paint, terminalStyle } from "./style.ts";

const BACK: Hint = { key: "esc", label: "back" };
const QUIT: Hint = { key: "ctrl+c", label: "quit" };
const OPEN: Hint = { key: "ctrl+o", label: "open" };

/** The footer every screen carries, in one order: what continues, what opens, what goes back, what stops. */
function hints(action: "select" | "continue" | "scroll", journey = false): readonly Hint[] {
	const open = journey ? [OPEN] : [];
	if (action === "scroll")
		return [{ key: "↑↓", label: "scroll" }, { key: "enter", label: "continue" }, ...open, BACK, QUIT];
	return [{ key: "enter", label: action === "select" ? "select" : "continue" }, ...open, BACK, QUIT];
}

/** A running operation repaints on a timer of its own: a spinner that waits for the next keypress is not a spinner. */
const SPINNER_REPAINT_MS = 80;

let warningsFiltered = false;

/**
 * Stop the renderer's own warning from reaching the terminal.
 *
 * The native half of the renderer loads through `node:ffi`, which warns once per process, and `mason onboard` is the
 * first thing a person sees: a stack-trace notice over the first screen is the wrong first impression. Only that warning
 * is dropped. Every other one is forwarded to the printer Node installed, which names the file and the stack — a bare
 * `console.warn` would not, and a wizard that hid a deprecation it should show would be worse than a noisy one.
 */
export function filterWarnings(): void {
	if (warningsFiltered) return;
	warningsFiltered = true;
	const forward = process.listeners("warning") as Array<(warning: Error) => void>;
	process.removeAllListeners("warning");
	process.on("warning", (warning: NodeJS.ErrnoException) => {
		if (warning.name === "ExperimentalWarning" && /FFI is an experimental feature/.test(warning.message)) return;
		for (const printer of forward) printer(warning);
	});
}

export interface TerminalScreenOptions {
	/** The renderer. A test injects one from `createTestRenderer`; `open` creates this process's own. */
	readonly renderer: CliRenderer;
	readonly paint?: Paint;
	readonly glyphs?: Glyphs;
	readonly subtitle?: string;
}

export class TerminalScreen implements Screen {
	private readonly renderer: CliRenderer;
	private readonly paintValue: Paint;
	private readonly glyphsValue: Glyphs;
	private readonly frame: Frame;
	private active: Body | undefined;
	private stopBusy: (() => void) | undefined;
	/** Whether the renderer is the one `open` made, and so whether the terminal behind it is ours to close. */
	private owns = false;
	/** Set once the terminal is in raw mode and painting: `close` may destroy at once from then on. */
	private ready = false;
	private starting: Promise<void> | undefined;
	private closed = false;
	private location: Context = { brand: "mason", title: "", index: 1, total: 1 };

	constructor(options: TerminalScreenOptions) {
		const style = terminalStyle();
		this.renderer = options.renderer;
		this.paintValue = options.paint ?? style.paint;
		this.glyphsValue = options.glyphs ?? style.glyphs;
		this.frame = new Frame({ renderer: this.renderer, paint: this.paintValue, glyphs: this.glyphsValue });
		if (options.subtitle !== undefined) this.location = { ...this.location, subtitle: options.subtitle };
		this.renderer.keyInput.on("keypress", this.onKey);
		this.renderer.keyInput.on("paste", this.onPaste);
		this.renderer.on("resize", this.onResize);
		this.renderer.root.add(this.frame.root);
		this.renderer.requestRender();
	}

	/** The real screen, or a refusal: a flow that needs keys cannot be run against a pipe. */
	static open(options: { readonly subtitle?: string } = {}): TerminalScreen {
		if (process.stdin.isTTY !== true || process.stdout.isTTY !== true)
			throw new Error("this needs a terminal: run it from one, or pass --yes to answer with flags");
		filterWarnings();
		const renderer = new CliRenderer(process.stdin, process.stdout, process.stdout.columns || 80, process.stdout.rows || 24, {
			screenMode: "alternate-screen",
			// Ctrl-C is a byte here: this screen decides what it means, and the renderer must not exit under it.
			exitOnCtrlC: false,
			consoleMode: "disabled",
		});
		const screen = new TerminalScreen({ renderer, ...options });
		screen.owns = true;
		// Raw mode and the alternate screen belong to the terminal, not to the tree: the first screen is built now and
		// painted the moment the terminal is ours, which is the same order a person sees.
		screen.starting = renderer.setupTerminal().then(
			() => {
				screen.ready = true;
				if (screen.closed) return;
				// The window's title is the terminal's, so it is set once the terminal is: before that there is no title to set.
				renderer.setTerminalTitle(
					[screen.location.brand, screen.location.subtitle].filter((part) => part !== undefined).join(" · "),
				);
				renderer.start();
			},
			(error: unknown) => {
				screen.closed = true;
				const reason = error instanceof Error ? error.message : String(error);
				console.error(`[mason] the terminal could not be taken: ${reason}`);
				process.exit(1);
			},
		);
		return screen;
	}

	get look(): { readonly paint: Paint; readonly glyphs: Glyphs } {
		return { paint: this.paintValue, glyphs: this.glyphsValue };
	}

	get columns(): number {
		return Math.max(20, this.renderer.width);
	}

	get rows(): number {
		return Math.max(8, this.renderer.height);
	}

	where(context: Where): void {
		this.location = { ...this.location, ...context };
		this.frame.setContext(this.location);
		this.renderer.requestRender();
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
				this.settle();
				resolve(value);
			};
			list.onCancel = () => {
				this.settle();
				reject(new Cancelled());
			};
			this.show(list, hints("select", options.journey !== undefined));
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
				...(options.journey === undefined ? {} : { journey: options.journey }),
			});
			field.onSubmit = (value) => {
				this.settle();
				resolve(value);
			};
			field.onCancel = () => {
				this.settle();
				reject(new Cancelled());
			};
			this.show(field, hints("continue", options.journey !== undefined));
		});
	}

	async secret(_id: string, title: string, options: Question = {}): Promise<string> {
		return await new Promise<string>((resolve, reject) => {
			const field = new MaskedField(this.geometry(), {
				question: title,
				...(options.hint === undefined ? {} : { hint: options.hint }),
				...(options.flag === undefined ? {} : { flag: options.flag }),
				...(options.journey === undefined ? {} : { journey: options.journey }),
			});
			field.onSubmit = (value) => {
				this.settle();
				resolve(value);
			};
			field.onCancel = () => {
				this.settle();
				reject(new Cancelled());
			};
			this.show(field, hints("continue", options.journey !== undefined));
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
		const view = new NoteView(this.geometry(), {
			title,
			lines: page.lines,
			...(page.note === undefined ? {} : { note: page.note }),
		});
		// The page is laid out before the footer is set: whether it goes on below the fold is what the footer has to say.
		const built = view.build();
		return await new Promise<void>((resolve, reject) => {
			view.onContinue = () => {
				this.settle();
				resolve();
			};
			view.onCancel = () => {
				this.settle();
				reject(new Cancelled());
			};
			// A page is not an editor, so the arrows scroll it — the frame owns the scroll region, not the page.
			view.onScroll = (delta) => {
				this.frame.scrollBy(delta);
				this.renderer.requestRender();
			};
			this.show(view, hints(view.rows > this.geometry().rows ? "scroll" : "continue"), built);
		});
	}

	progress(_id: string, title: string, rows: readonly StatusRow[]): Progress {
		const view = new StatusList(this.geometry(), rows, { title });
		const waiting: { resolve?: (key: string) => void; keys: readonly string[] } = { keys: [] };
		view.onKey = (key) => {
			if (!waiting.keys.includes(key)) return;
			const settle = waiting.resolve;
			waiting.resolve = undefined;
			waiting.keys = [];
			settle?.(key);
		};
		// No `enter` hint while the steps run: it means something only once one of them has failed, and `key()` below is
		// what says so. A footer that advertises a key that does nothing is a footer that lies on every frame.
		this.show(view, [QUIT]);
		return {
			update: (next, note) => {
				view.set(next, note);
				this.renderer.requestRender();
			},
			key: async (offered) => {
				waiting.keys = offered.map((hint) => hint.key);
				this.frame.setHints(offered);
				this.renderer.requestRender();
				return await new Promise<string>((resolve) => {
					waiting.resolve = resolve;
				});
			},
			close: () => {
				this.active = undefined;
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
		const timer = setInterval(() => {
			this.active?.tick?.();
			this.renderer.requestRender();
		}, SPINNER_REPAINT_MS);
		this.stopBusy = () => clearInterval(timer);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.stopBusy?.();
		this.stopBusy = undefined;
		// Read while the screen is still the buffer's: after `destroy` the alternate screen is gone and anywhere this
		// process might have printed is gone with it.
		const rows = this.owns ? frameRows(this.renderer) : [];
		const finish = (): void => {
			this.renderer.keyInput.off("keypress", this.onKey);
			this.renderer.keyInput.off("paste", this.onPaste);
			this.renderer.off("resize", this.onResize);
			this.renderer.destroy();
			// The alternate screen is discarded on exit, so the last frame is reprinted where a person can scroll back to it.
			if (rows.length > 0) process.stdout.write(`${rows.join("\n")}\n`);
		};
		if (this.starting === undefined || this.ready) finish();
		else void this.starting.then(finish, finish);
	}

	/** Mount a body and give it the keyboard. Nothing else is mounted, so a screen cannot render under another one. */
	private show(body: Body, footer: readonly Hint[], built?: Renderable): void {
		this.active = body;
		this.frame.setHints(footer);
		this.frame.mount(built ?? body.build());
		this.renderer.requestRender();
	}

	/** An answer was given: the body stops taking keys, and stays on the screen until the next screen replaces it. */
	private settle(): void {
		this.active = undefined;
	}

	private geometry(): Geometry {
		return {
			renderer: this.renderer,
			window: this.renderer.width,
			columns: measure(this.renderer.width),
			rows: bodyRows(this.renderer.height),
			paint: this.paintValue,
			glyphs: this.glyphsValue,
		};
	}

	private readonly onKey = (key: KeyEvent): void => {
		if (key.ctrl && key.name === "c") {
			this.close();
			process.exit(130);
			return;
		}
		const body = this.active;
		if (body === undefined) return;
		if (!body.handleKey(key)) return;
		// The key was the body's: it redraws what it changed rather than the screen mounting a new tree, so a cursor moves
		// without the list behind it being thrown away.
		body.reflect?.();
		this.renderer.requestRender();
	};

	private readonly onPaste = (event: PasteEvent): void => {
		const body = this.active;
		if (body?.handlePaste === undefined) return;
		if (body.handlePaste(new TextDecoder().decode(event.bytes))) this.renderer.requestRender();
	};

	private readonly onResize = (): void => {
		this.frame.setColumns(this.renderer.width);
		const body = this.active;
		if (body !== undefined) {
			// The body was built at the old window, and the width is what decides whether a row has a description beside it: it
			// is told the new room before it is asked to draw it, or a shrunken window keeps the layout it was given.
			body.resize?.(this.geometry());
			this.frame.mount(body.build());
		}
		this.renderer.requestRender();
	};
}

/** The last painted frame as plain rows: what the wizard leaves in the scrollback once the alternate screen is gone. */
function frameRows(renderer: CliRenderer): readonly string[] {
	const text = new TextDecoder().decode(renderer.currentRenderBuffer.getRealCharBytes(true));
	const rows = text.split("\n").map((row) => row.replace(/\s+$/, ""));
	while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
	return rows;
}
