/**
 * The vocabulary a screen draws with: the paint a flow styles its own prose with, the glyphs a status line uses, and the
 * two measurements a layout needs.
 *
 * `paint` is the wire between a flow and the renderer. A flow writes `paint.dim(…)` into a line it hands the screen, the
 * screen parses that back into styled text (`theme.ts`), and neither has to know what the other draws with — which is why
 * the codes are a small fixed subset (bold, dim, and the four states) rather than a palette. The codes name *states*, not
 * colours: `36` is the accent, and the theme is the one place that decides it is clay.
 *
 * Colour carries state and nothing else — the accent marks what is active, green a check that passed, yellow one that
 * needs attention, red one that failed — so a screen read without colour loses emphasis but no information. Everything
 * else is the terminal's own foreground and the `dim` attribute, which follows the reader's theme instead of ours.
 *
 * A pipe is not a screen. `paint` is off when stdout is not a TTY, when `NO_COLOR` is set, or when `TERM=dumb`: the same
 * components then render plain text, which is what a log file and a test want. `glyphs` follows the locale for the same
 * reason — `✓` is three bytes of UTF-8, and a terminal set to ISO-8859-1 shows three question marks.
 */

/** The styles a screen may apply. Every one is a no-op when `colour` is false. */
export interface Paint {
	readonly colour: boolean;
	/** The one thing a heading, a selection and an active value may be. */
	readonly accent: (text: string) => string;
	readonly bold: (text: string) => string;
	/** Secondary text: a hint, a description, a path. The attribute, not a grey: it follows the terminal's own theme. */
	readonly dim: (text: string) => string;
	readonly ok: (text: string) => string;
	readonly warn: (text: string) => string;
	readonly bad: (text: string) => string;
	/** What a heading is: the accent, emphasised once. */
	readonly heading: (text: string) => string;
}

/** The symbols a status line and a list use. Chosen per locale; never both at once. */
export interface Glyphs {
	readonly ok: string;
	readonly fail: string;
	readonly warn: string;
	readonly wait: string;
	readonly skip: string;
	/** What marks the row a keypress is on: a bar in a UTF-8 terminal, an arrow where the bar is not one. */
	readonly cursor: string;
	readonly rule: string;
	readonly mask: string;
	/** The frames a running operation cycles through. */
	readonly spinner: readonly string[];
	/** The mark before a section's name in the frame. */
	readonly section: string;
	/** The mark before a value being typed. */
	readonly prompt: string;
}

const SGR = {
	reset: 0,
	bold: 1,
	dim: 2,
	red: 31,
	green: 32,
	yellow: 33,
	accent: 36,
} as const;

function wrap(code: number, colour: boolean): (text: string) => string {
	if (!colour) return (text) => text;
	return (text) => `\x1b[${code}m${text}\x1b[${SGR.reset}m`;
}

/** Whether to paint: a TTY that has not opted out, with a terminal that knows what an escape is. */
export function colourEnabled(
	env: NodeJS.ProcessEnv = process.env,
	isTTY: boolean | undefined = process.stdout.isTTY,
): boolean {
	if (isTTY !== true) return false;
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
	if (env.TERM === "dumb") return false;
	return true;
}

export function paint(colour: boolean): Paint {
	const accent = wrap(SGR.accent, colour);
	const bold = wrap(SGR.bold, colour);
	return {
		colour,
		accent,
		bold,
		dim: wrap(SGR.dim, colour),
		ok: wrap(SGR.green, colour),
		warn: wrap(SGR.yellow, colour),
		bad: wrap(SGR.red, colour),
		heading: (text) => bold(accent(text)),
	};
}

/** UTF-8 in the locale, or ASCII: the only two answers, so a screen cannot be half of each. */
export function utf8Locale(env: NodeJS.ProcessEnv = process.env): boolean {
	const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "";
	return /utf-?8/i.test(locale);
}

export function glyphs(utf8: boolean): Glyphs {
	if (!utf8)
		return {
			ok: "+",
			fail: "x",
			warn: "!",
			wait: ".",
			skip: "-",
			cursor: ">",
			rule: "-",
			mask: "*",
			spinner: ["|", "/", "-", "\\"],
			section: "*",
			prompt: ">",
		};
	return {
		ok: "✓",
		fail: "✗",
		warn: "!",
		wait: "·",
		skip: "·",
		cursor: "▌",
		rule: "─",
		mask: "•",
		spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
		section: "◇",
		prompt: "❯",
	};
}

/** The style a real run gets: what the terminal and the locale say, in one object the screens pass around. */
export function terminalStyle(
	env: NodeJS.ProcessEnv = process.env,
	isTTY: boolean | undefined = process.stdout.isTTY,
): { readonly paint: Paint; readonly glyphs: Glyphs } {
	return { paint: paint(colourEnabled(env, isTTY)), glyphs: glyphs(utf8Locale(env)) };
}

/** The style a test or a log gets: no escapes, ASCII. */
export const plainStyle: { readonly paint: Paint; readonly glyphs: Glyphs } = {
	paint: paint(false),
	glyphs: glyphs(false),
};

/** An SGR sequence, which is everything `paint` writes and the only escape a styled line may carry. */
const SGR_ONLY = /\x1b\[[0-9;]*m/g;

/**
 * The code points a terminal draws two cells wide, and the ones it draws in none.
 *
 * A table rather than a dependency: the ranges are the ones Unicode marks East Asian Wide or Fullwidth, plus the emoji
 * blocks a person actually pastes, and the whole point of the measure is to be the same number the renderer paints with.
 */
const DOUBLE: readonly (readonly [number, number])[] = [
	[0x1100, 0x115f],
	[0x2e80, 0x303e],
	[0x3041, 0x33ff],
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xa000, 0xa4cf],
	[0xa960, 0xa97f],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe10, 0xfe19],
	[0xfe30, 0xfe6f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x1f300, 0x1f64f],
	[0x1f900, 0x1f9ff],
	[0x1f680, 0x1f6ff],
	[0x20000, 0x3fffd],
];

/** The cells one code point takes: two for a wide one, none for a mark that draws inside the cell before it. */
function cellsOf(code: number): number {
	if (code === 0x200d || code === 0xfe0f) return 0;
	if (code >= 0x0300 && code <= 0x036f) return 0;
	for (const [from, to] of DOUBLE) if (code >= from && code <= to) return 2;
	return 1;
}

/** Display columns of a string, ignoring the escapes it carries and counting a wide glyph as two cells. */
export function widthOf(text: string): number {
	let width = 0;
	for (const char of text.replace(SGR_ONLY, "")) width += cellsOf(char.codePointAt(0) ?? 0);
	return width;
}
