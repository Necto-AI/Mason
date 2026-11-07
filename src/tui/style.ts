/**
 * The one place a terminal colour or a status symbol is written: the palette, the glyphs, and the two rules that keep
 * them from becoming decoration.
 *
 * Colour carries state and nothing else — the accent marks what is active, green a check that passed, yellow one that
 * needs attention, red one that failed — so a screen read without colour loses emphasis but no information. Everything
 * else is the terminal's own foreground and a `dim` for the second tier. That is also why there is no truecolor here: the
 * eight names below exist in every terminal a person is likely to run this in, and a theme that has to negotiate with the
 * user's palette is a theme that is wrong half the time.
 *
 * A pipe is not a screen. `paint` is off when stdout is not a TTY, when `NO_COLOR` is set, or when `TERM=dumb`: the same
 * components then render plain text, which is what a log file and a test want. `glyphs` follows the locale for the same
 * reason — `✓` is three bytes of UTF-8, and a terminal set to ISO-8859-1 shows three question marks.
 */
import { visibleWidth } from "@earendil-works/pi-tui";

/** The styles a screen may apply. Every one is a no-op when `colour` is false. */
export interface Paint {
	readonly colour: boolean;
	/** The one thing a heading, a selection and an active value may be. */
	readonly accent: (text: string) => string;
	readonly bold: (text: string) => string;
	/** Secondary text: a hint, a description, a path. */
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
	readonly cursor: string;
	readonly rule: string;
	readonly mask: string;
	/** The two halves of a progress dot: where the flow has been, and where it is going. */
	readonly dot: string;
	readonly dotAhead: string;
	/** The frames a running operation cycles through. */
	readonly spinner: readonly string[];
}

const SGR = {
	reset: 0,
	bold: 1,
	dim: 2,
	red: 31,
	green: 32,
	yellow: 33,
	cyan: 36,
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
	const accent = wrap(SGR.cyan, colour);
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
			dot: "*",
			dotAhead: ".",
			spinner: ["|", "/", "-", "\\"],
		};
	return {
		ok: "✓",
		fail: "✗",
		warn: "!",
		wait: "·",
		skip: "·",
		cursor: "›",
		rule: "─",
		mask: "•",
		dot: "●",
		dotAhead: "○",
		spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
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

/** Display columns of a string, ignoring the escapes it carries. */
export function widthOf(text: string): number {
	return visibleWidth(text);
}

/** `left` and `right` on one line of exactly `width` columns, or `left` alone when they would collide. */
export function spread(left: string, right: string, width: number): string {
	const room = width - widthOf(left) - widthOf(right);
	if (room < 1) return left;
	return `${left}${" ".repeat(room)}${right}`;
}
