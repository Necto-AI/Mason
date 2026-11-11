/**
 * A real screen on a renderer a test owns.
 *
 * `@opentui/core/testing` gives the application the same thing a terminal would — a grid it paints into and a byte stream
 * it reads keys from — without a pty, so a test asserts over the frame a person would have seen rather than over the lines
 * a component happened to return. The renderer paints on its own loop here, which is what makes "the screen showed this
 * before the next key" a fact and not a guess.
 *
 * No Kitty keyboard protocol is negotiated, because a plain terminal speaks in bytes: `\x1b[B` is the down arrow, `\r` is
 * enter and a lone `\x1b` is escape. A test that presses those is pressing what a person's keyboard sends.
 */

import { NativeError, NativeStatus, type Renderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { TerminalScreen } from "../../src/tui/app.ts";
import { type Glyphs, glyphs, type Paint, paint } from "../../src/tui/style.ts";

export interface Harness {
	readonly screen: TerminalScreen;
	readonly setup: TestRendererSetup;
	/** The frame as a person sees it: one line per row, trailing blanks gone, and no blank rows at the bottom. */
	frame(): Promise<string>;
	/** The same, as rows. */
	rows(): Promise<string[]>;
	/** Put something on the screen that is not a screen: a component under test, mounted where the renderer will paint it. */
	mount(renderable: Renderable): void;
	/** Press keys, one chunk each, the way a terminal delivers them, and wait for the screen they produced. */
	press(...keys: readonly string[]): Promise<void>;
	/** Wait for the frame to catch up with whatever just happened. */
	settle(): Promise<void>;
	dispose(): Promise<void>;
}

/**
 * Every screen this file opened and nobody disposed.
 *
 * The renderer paints on its own loop, so an undisposed one keeps the process alive after the last assertion: a test file
 * then reads as a thirty-minute timeout instead of a failing test. A file registers `after(disposeAll)` once and the leak
 * becomes a clean exit; a file that forgets still hangs, which is the only way this stays discoverable.
 */
const open = new Set<Harness>();

/** Dispose every screen a test file opened and forgot. Register it once per file: `after(disposeAll)`. */
export async function disposeAll(): Promise<void> {
	for (const harness of [...open]) await harness.dispose();
}

/**
 * How long a capture waits for the renderer to hand its buffer back.
 *
 * A capture is a native lease on the current buffer, and the renderer paints on its own loop: the frame being presented
 * holds the buffer, and a capture that lands inside that window is refused with `OutputBusy` (#177). Nothing the JS
 * scheduler reports reflects the window — `flush()` returns idle while a presentation is still pending — so the harness
 * waits for the frame to end and tries again. A session that never hands the buffer back is a leak, and the error below
 * says so, in the harness, for every test in the file.
 */
const CAPTURE_WAIT_MS = 5_000;

/**
 * One capture at a time, for the whole file: two screens are alive at once in `tui.test.ts`, and a capture that overlapped
 * another's grab of a buffer is the same refusal the wait is there to absorb. Queued rather than retried per screen, so
 * the order a test awaits its frames in is the order they are taken.
 */
let captures: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
	const next = captures.then(work, work);
	captures = next.catch(() => undefined);
	return next;
}

/** A window and a style, or the defaults a real run would have on a UTF-8 terminal with colour. */
export interface HarnessOptions {
	readonly columns?: number;
	readonly rows?: number;
	readonly paint?: Paint;
	readonly glyphs?: Glyphs;
	readonly subtitle?: string;
	/** How long a capture waits for the buffer before it gives up. Short in a test that proves the giving up. */
	readonly captureWaitMs?: number;
}

export async function openScreen(options: HarnessOptions = {}): Promise<Harness> {
	const columns = options.columns ?? 100;
	const rows = options.rows ?? 30;
	const setup = await createTestRenderer({ width: columns, height: rows, exitOnCtrlC: false });
	const screen = new TerminalScreen({
		renderer: setup.renderer,
		paint: options.paint ?? paint(false),
		glyphs: options.glyphs ?? glyphs(true),
		...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
	});
	setup.renderer.start();
	const settle = async (): Promise<void> => {
		await new Promise((resolve) => setTimeout(resolve, 25));
		await setup.flush();
	};
	const wait = options.captureWaitMs ?? CAPTURE_WAIT_MS;
	const capture = (): Promise<string> =>
		serial(async () => {
			const until = Date.now() + wait;
			for (;;) {
				try {
					return setup.captureCharFrame();
				} catch (error) {
					if (!(error instanceof NativeError) || error.status !== NativeStatus.OutputBusy) throw error;
					if (Date.now() > until) {
						throw new Error(`the renderer held its buffer for ${wait} ms, so the screen was never captured`, {
							cause: error,
						});
					}
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
			}
		});
	const frame = async (): Promise<string> => {
		const lines = (await capture()).split("\n").map((line) => line.replace(/\s+$/, ""));
		while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		return lines.join("\n");
	};
	const harness: Harness = {
		screen,
		setup,
		frame,
		rows: async () => (await frame()).split("\n"),
		mount: (renderable) => {
			setup.renderer.root.add(renderable);
			setup.renderer.requestRender();
		},
		press: async (...keys) => {
			for (const key of keys) setup.mockInput.pressKey(key);
			await settle();
		},
		settle,
		dispose: async () => {
			open.delete(harness);
			// The screen first: `busy` runs on an interval of its own, and a test that fails between busy(true) and
			// busy(false) would otherwise leave it running, which keeps the process alive after the last assertion.
			screen.close();
			await setup.dispose();
		},
	};
	open.add(harness);
	await settle();
	return harness;
}

/** The window sizes the spec names: one wide enough for a description column, and one that is not. */
export const WIDE = { columns: 100, rows: 30 } as const;
export const NARROW = { columns: 72, rows: 24 } as const;
