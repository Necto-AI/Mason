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
import { type TestRendererSetup, createTestRenderer } from "@opentui/core/testing";
import type { Renderable } from "@opentui/core";
import { TerminalScreen } from "../../src/tui/app.ts";
import { type Glyphs, type Paint, glyphs, paint } from "../../src/tui/style.ts";

export interface Harness {
	readonly screen: TerminalScreen;
	readonly setup: TestRendererSetup;
	/** The frame as a person sees it: one line per row, trailing blanks gone, and no blank rows at the bottom. */
	frame(): string;
	/** The same, as rows. */
	rows(): string[];
	/** Put something on the screen that is not a screen: a component under test, mounted where the renderer will paint it. */
	mount(renderable: Renderable): void;
	/** Press keys, one chunk each, the way a terminal delivers them, and wait for the screen they produced. */
	press(...keys: readonly string[]): Promise<void>;
	/** Wait for the frame to catch up with whatever just happened. */
	settle(): Promise<void>;
	dispose(): Promise<void>;
}

/** A window and a style, or the defaults a real run would have on a UTF-8 terminal with colour. */
export interface HarnessOptions {
	readonly columns?: number;
	readonly rows?: number;
	readonly paint?: Paint;
	readonly glyphs?: Glyphs;
	readonly subtitle?: string;
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
	const frame = (): string => {
		const lines = setup
			.captureCharFrame()
			.split("\n")
			.map((line) => line.replace(/\s+$/, ""));
		while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		return lines.join("\n");
	};
	const harness: Harness = {
		screen,
		setup,
		frame,
		rows: () => frame().split("\n"),
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
			await setup.dispose();
		},
	};
	await settle();
	return harness;
}

/** The window sizes the spec names: one wide enough for a description column, and one that is not. */
export const WIDE = { columns: 100, rows: 30 } as const;
export const NARROW = { columns: 72, rows: 24 } as const;
