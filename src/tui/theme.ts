/**
 * The one place a colour is chosen: the palette the renderer draws in, and the parser that turns what a flow painted into
 * styled text.
 *
 * A flow styles its own prose before the renderer sees it (`paint.dim(…)`, `paint.heading(…)`), so the two halves need a
 * vocabulary they both understand. It is a small SGR subset — `0`, `1`, `2`, `22`, `31`, `32`, `33`, `36` — and the codes
 * name *states*, not colours: `36` is the accent. This file is what that means: clay where the terminal has truecolor,
 * the 256-colour index clay is where it does not, and nothing at all when `paint` is off. One accent, said once.
 *
 * Everything else is the terminal's own foreground plus the `dim` attribute, so the theme does not fight the reader's
 * colours; `ok`, `warn` and `bad` are the terminal's own green, yellow and red, because a check that failed is a state
 * every terminal already has a word for.
 */
import { createTextAttributes, RGBA, StyledText, type TextChunk } from "@opentui/core";
import { type Paint, widthOf } from "./style.ts";

/** The one accent: a designed value, so it is a hex and the index it falls on in a 256-colour palette. */
export const CLAY = "#d7875f";
const CLAY_INDEX = 173;

/** What a run of text asks for. `plain` is the terminal's own foreground, which is most of a screen. */
export type Tone = "plain" | "accent" | "ok" | "warn" | "bad";

/** One run of text a painted line declared: what it says, and the state it says it in. */
export interface Run {
	readonly text: string;
	readonly tone: Tone;
	readonly bold: boolean;
	readonly dim: boolean;
}

/** A paragraph of painted text, wrapped: what to draw, and the rows it costs — a page needs the count before it is shown. */
export interface Paragraph {
	readonly text: StyledText;
	readonly rows: number;
}

export interface Theme {
	/** Whether anything is drawn in colour at all. A plain theme parses the codes and drops them. */
	readonly colour: boolean;
	readonly accent: RGBA;
	readonly ok: RGBA;
	readonly warn: RGBA;
	readonly bad: RGBA;
	/** One painted line: the subset parsed, nothing wrapped. */
	line(text: string): StyledText;
	/** A painted paragraph at `width`: hard breaks kept, long lines wrapped, and the rows it took. */
	paragraph(text: string, width: number): Paragraph;
}

const RESET: Omit<Run, "text"> = { tone: "plain", bold: false, dim: false };

/** The tone an SGR code names, when it names one: `36` is the accent, whatever the terminal renders it in. */
const TONES: Readonly<Record<string, Tone>> = { "31": "bad", "32": "ok", "33": "warn", "36": "accent" };

/**
 * The SGR subset a painted line carries, as runs.
 *
 * A code outside the subset is dropped rather than forwarded: a screen that echoed an escape it did not understand is a
 * screen whose layout is a guess, and every escape that reaches the renderer is one this parser has already seen.
 */
export function parseSgr(text: string): readonly Run[] {
	const runs: Run[] = [];
	let style = RESET;
	let plain = "";
	const flush = (): void => {
		if (plain === "") return;
		const last = runs[runs.length - 1];
		if (last !== undefined && last.tone === style.tone && last.bold === style.bold && last.dim === style.dim)
			runs[runs.length - 1] = { ...last, text: last.text + plain };
		else runs.push({ ...style, text: plain });
		plain = "";
	};
	for (let index = 0; index < text.length; ) {
		if (text.startsWith("\x1b[", index)) {
			const end = text.indexOf("m", index + 2);
			const codes = end === -1 ? "" : text.slice(index + 2, end);
			if (end === -1 || !/^[0-9;]*$/.test(codes)) {
				// Not a sequence this parser knows, and not text either: drop the escape character and go on.
				index += 1;
				continue;
			}
			flush();
			for (const code of codes.split(";")) {
				if (code === "0") style = RESET;
				else if (code === "1") style = { ...style, bold: true };
				else if (code === "2") style = { ...style, dim: true };
				else if (code === "22") style = { ...style, bold: false, dim: false };
				else if (code === "39") style = { ...style, tone: "plain" };
				else if (TONES[code] !== undefined) style = { ...style, tone: TONES[code] as Tone };
			}
			index = end + 1;
			continue;
		}
		plain += text[index];
		index += 1;
	}
	flush();
	return runs;
}

/** Where one hard line of runs ends and the next begins. */
function hardLines(runs: readonly Run[]): readonly (readonly Run[])[] {
	const lines: Run[][] = [[]];
	for (const run of runs) {
		const parts = run.text.split("\n");
		parts.forEach((part, index) => {
			if (index > 0) lines.push([]);
			if (part !== "") (lines[lines.length - 1] as Run[]).push({ ...run, text: part });
		});
	}
	return lines;
}

/** One hard line, wrapped at `width`: at a space where there is one, inside a word only when the word cannot fit. */
function wrapRuns(runs: readonly Run[], width: number): readonly (readonly Run[])[] {
	const lines: Run[][] = [[]];
	let used = 0;
	const current = (): Run[] => lines[lines.length - 1] as Run[];
	const push = (run: Run, text: string): void => {
		if (text === "") return;
		current().push({ ...run, text });
		used += widthOf(text);
	};
	for (const run of runs) {
		let rest = run.text;
		while (rest !== "") {
			const space = rest.indexOf(" ");
			const word = space === -1 ? rest : rest.slice(0, space);
			if (word !== "") {
				if (used > 0 && used + widthOf(word) > width) {
					lines.push([]);
					used = 0;
				}
				let piece = word;
				while (widthOf(piece) > width) {
					let cut = piece.length;
					while (cut > 1 && widthOf(piece.slice(0, cut)) > width) cut -= 1;
					push(run, piece.slice(0, cut));
					lines.push([]);
					used = 0;
					piece = piece.slice(cut);
				}
				push(run, piece);
			}
			if (space === -1) break;
			push(run, " ");
			rest = rest.slice(space + 1);
		}
	}
	return lines;
}

/** The chunks OpenTUI takes, with the tone and the two attributes the theme can name. */
function chunksOf(runs: readonly Run[], theme: Theme): TextChunk[] {
	const chunks: TextChunk[] = [];
	for (const run of runs) {
		if (run.text === "") continue;
		const fg = theme.colour && run.tone !== "plain" ? theme[run.tone] : undefined;
		const attributes = theme.colour ? createTextAttributes({ bold: run.bold, dim: run.dim }) : 0;
		chunks.push({
			__isChunk: true,
			text: run.text,
			...(fg === undefined ? {} : { fg }),
			...(attributes === 0 ? {} : { attributes }),
		});
	}
	return chunks;
}

/** Truecolor when the terminal says it has it, the 256-colour index of clay otherwise. */
function truecolor(env: NodeJS.ProcessEnv): boolean {
	const term = env.COLORTERM ?? "";
	return /truecolor|24bit/i.test(term);
}

/** The theme a paint implies: colour or not — which a flow already decided — and the depth this process's terminal has. */
export function theme(ink: Paint, env: NodeJS.ProcessEnv = process.env): Theme {
	const colour = ink.colour;
	const accent = truecolor(env) ? RGBA.fromHex(CLAY) : RGBA.fromIndex(CLAY_INDEX);
	const built: Theme = {
		colour,
		accent,
		ok: RGBA.fromIndex(2),
		warn: RGBA.fromIndex(3),
		bad: RGBA.fromIndex(1),
		line: (text) => new StyledText(chunksOf(parseSgr(text), built)),
		paragraph: (text, width) => {
			const lines = hardLines(parseSgr(text)).flatMap((line) => wrapRuns(line, Math.max(1, width)));
			const runs = lines.flatMap((line, index) => (index === 0 ? line : [{ ...RESET, text: "\n" } as Run, ...line]));
			return { text: new StyledText(chunksOf(runs, built)), rows: lines.length };
		},
	};
	return built;
}
