/**
 * A terminal that answers nothing, and a screen that can be read back from what was written to it.
 *
 * Two things here are the point. The first is that pi-tui's renderers write bytes and read bytes, so a test can be a real
 * run of the real application: the same `TerminalScreen`, the same alternate screen, the same layout — with a terminal
 * object instead of a pty. That is how a secret is proven never to reach the screen: the assertion is over the byte
 * stream, not over a component's return value.
 *
 * The second is `screenText`, a small ANSI interpreter. The alternate screen writes cursor moves and erases, so the
 * visible screen is not the concatenation of what was written; reconstructing it is what makes "the frame looks like
 * this at 70 columns" a test, and what puts the layout of a real screen into a report instead of a description of one.
 * It understands the handful of sequences a TUI uses — absolute positioning, relative moves, erase-in-line, erase-screen
 * — and ignores styling, which is the only part a text screenshot was never going to show.
 */
import type { Terminal } from "@earendil-works/pi-tui";

/** A terminal an application can drive with no pty: the writes are kept, the keys are fed in by the test. */
export class FakeTerminal implements Terminal {
	columns: number;
	rows: number;
	/** Everything the application wrote, in order. */
	readonly writes: string[] = [];
	readonly titles: string[] = [];
	/** Whether the reader is still waiting for input: a screen that never resolves shows up here. */
	private input: ((data: string) => void) | undefined;

	constructor(options: { readonly columns?: number; readonly rows?: number } = {}) {
		this.columns = options.columns ?? 100;
		this.rows = options.rows ?? 30;
	}

	start(onInput: (data: string) => void): void {
		this.input = onInput;
	}

	stop(): void {
		this.input = undefined;
	}

	write(data: string): void {
		this.writes.push(data);
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	/** Feed raw bytes, the way a keyboard would: `\r` is enter, `\x1b[A` is up, `\x1b` is escape. */
	type(data: string): void {
		this.input?.(data);
	}

	/** Resize, the way a window manager does: the next render asks the terminal for its size and gets the new one. */
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
	}

	async drainInput(): Promise<void> {}

	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}

	setTitle(title: string): void {
		this.titles.push(title);
	}
}

/** One cell grid, drawn by the sequences a TUI writes. Styling is dropped; position is not. */
class Screen {
	readonly columns: number;
	readonly rows: number;
	private readonly cells: string[][];
	private row = 0;
	private column = 0;

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
		this.cells = Array.from({ length: rows }, () => Array.from({ length: columns }, () => " "));
	}

	/** The visible text: rows as they are, with trailing blanks removed and empty rows at the bottom dropped. */
	text(): string[] {
		const lines = this.cells.map((row) => row.join("").replace(/\s+$/, ""));
		let end = lines.length;
		while (end > 0 && lines[end - 1] === "") end -= 1;
		return lines.slice(0, end);
	}

	private put(char: string): void {
		if (this.column >= this.columns) return;
		const row = this.cells[this.row];
		if (row === undefined) return;
		row[this.column] = char;
		this.column += 1;
	}

	/** Everything one write stream did to the grid, in order. */
	feed(stream: string): void {
		const chars = Array.from(stream);
		for (let index = 0; index < chars.length; index += 1) {
			const char = chars[index] ?? "";
			if (char === "\x1b") {
				index = this.escape(chars, index);
				continue;
			}
			if (char === "\r") {
				this.column = 0;
				continue;
			}
			if (char === "\n") {
				this.row = Math.min(this.rows - 1, this.row + 1);
				continue;
			}
			if (char === "\b") {
				this.column = Math.max(0, this.column - 1);
				continue;
			}
			if (char === "\x07" || char < " ") continue;
			this.put(char);
		}
	}

	/** Consume one escape sequence starting at `start`, and return the index of its last character. */
	private escape(chars: readonly string[], start: number): number {
		const next = chars[start + 1] ?? "";
		if (next === "]") {
			// An OSC string ends at BEL or at the two-character string terminator.
			for (let index = start + 2; index < chars.length; index += 1) {
				if (chars[index] === "\x07") return index;
				if (chars[index] === "\x1b" && chars[index + 1] === "\\") return index + 1;
			}
			return chars.length - 1;
		}
		if (next !== "[" && next !== "(" && next !== ")") return start + 1;
		if (next === "(" || next === ")") return start + 2;
		let index = start + 2;
		while (index < chars.length && !/[A-Za-z]/.test(chars[index] ?? "")) index += 1;
		const final = chars[index] ?? "";
		const params = chars.slice(start + 2, index).join("");
		this.control(params, final);
		return index;
	}

	private control(params: string, final: string): void {
		const numbers = params
			.replace(/^[?><!]/, "")
			.split(";")
			.map((part) => Number.parseInt(part, 10));
		const first = Number.isNaN(numbers[0] ?? Number.NaN) ? 1 : (numbers[0] ?? 1);
		const second = Number.isNaN(numbers[1] ?? Number.NaN) ? 1 : (numbers[1] ?? 1);
		switch (final) {
			case "H":
			case "f":
				this.row = Math.max(0, Math.min(this.rows - 1, first - 1));
				this.column = Math.max(0, Math.min(this.columns - 1, second - 1));
				break;
			case "A":
				this.row = Math.max(0, this.row - first);
				break;
			case "B":
				this.row = Math.min(this.rows - 1, this.row + first);
				break;
			case "C":
				this.column = Math.min(this.columns - 1, this.column + first);
				break;
			case "D":
				this.column = Math.max(0, this.column - first);
				break;
			case "G":
				this.column = Math.max(0, Math.min(this.columns - 1, first - 1));
				break;
			case "J":
				if (first === 2 || first === 3) for (const row of this.cells) row.fill(" ");
				break;
			case "K": {
				const row = this.cells[this.row];
				if (row !== undefined) row.fill(" ", this.column);
				break;
			}
			default:
				// Styling, modes, and everything a text screenshot has no use for.
				break;
		}
	}
}

/** The screen the application left behind, reconstructed from everything it wrote. */
export function screenText(
	writes: readonly string[],
	size: { readonly columns: number; readonly rows: number },
): string[] {
	const screen = new Screen(size.columns, size.rows);
	for (const write of writes) screen.feed(write);
	return screen.text();
}
