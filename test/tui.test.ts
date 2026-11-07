/**
 * The TUI primitives, pinned where the promises are: a secret that is never rendered, a list that filters, a frame that
 * fits a narrow window, and a screen that is the real application driven by bytes.
 *
 * The last one is why `test/support/terminal.ts` exists. Everything above it proves a component; the `TerminalScreen`
 * tests prove the composition — the alternate screen, the layout root, the scroll view, the focus and the keyboard — and
 * they read the *bytes the application wrote*, which is the only place "the key was never echoed" is a fact rather than a
 * claim about a function that returns lines.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TerminalScreen } from "../src/tui/app.ts";
import { ChoiceList, MaskedInput, NoteView, StatusList, TextField } from "../src/tui/components.ts";
import { Frame } from "../src/tui/frame.ts";
import { Cancelled } from "../src/tui/screen.ts";
import { colourEnabled, glyphs, paint, plainStyle, widthOf } from "../src/tui/style.ts";
import { FakeTerminal, screenText } from "./support/terminal.ts";

const utf8 = glyphs(true);
const style = { paint: paint(false), glyphs: utf8 };

/** A list, field or frame at one window: the geometry a screen would hand it. */
function geometry(
	columns = 100,
	rows = 24,
): { columns: number; rows: number; paint: typeof style.paint; glyphs: typeof utf8 } {
	return { columns, rows, paint: style.paint, glyphs: utf8 };
}

/** Every rendered line fits: the one rule a TUI component cannot break, because the renderer errors on it. */
function fits(lines: readonly string[], width: number): void {
	for (const line of lines) assert.ok(widthOf(line) <= width, `"${line}" is ${widthOf(line)} columns, not ${width}`);
}

/** The editor coalesces renders on a 16ms interval; a forced repaint lands on the next turn of the loop. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

/** A line with the cursor markers pi-tui puts around the cell a cursor would be in. They are zero-width and not text. */
function visible(line: string): string {
	return line.replace(/\x1b_pi:\/?[a-z]+\x07/g, "");
}

describe("style", () => {
	test("plain is the identity, in every name", () => {
		const { accent, bold, dim, ok, warn, bad, heading } = plainStyle.paint;
		for (const apply of [accent, bold, dim, ok, warn, bad, heading]) assert.equal(apply("text"), "text");
	});

	test("colour is off for a pipe, for NO_COLOR, and for a dumb terminal", () => {
		assert.equal(colourEnabled({}, false), false);
		assert.equal(colourEnabled({}, true), true);
		assert.equal(colourEnabled({ NO_COLOR: "1" }, true), false);
		assert.equal(colourEnabled({ TERM: "dumb" }, true), false);
	});

	test("the ascii glyphs are ascii, and the utf-8 ones are not", () => {
		const ascii = glyphs(false);
		for (const mark of [ascii.ok, ascii.fail, ascii.cursor, ascii.rule])
			assert.ok(mark.length === 1 && mark < "\x7f");
		assert.equal(utf8.ok, "✓");
		assert.equal(utf8.rule, "─");
	});
});

describe("ChoiceList", () => {
	const choices = [
		{ value: "telegram", label: "telegram", description: "Telegram, for one person or a group chat" },
		{ value: "console", label: "console", description: "the terminal, built in" },
	];

	test("the question, the hint and one row per choice", () => {
		const list = new ChoiceList(geometry(), {
			question: "How will you talk to it?",
			hint: "the console is built in",
			choices,
		});
		const lines = list.render(100);
		assert.ok(lines.some((line) => line.includes("How will you talk to it?")));
		assert.ok(lines.some((line) => line.includes("the console is built in")));
		assert.ok(lines.some((line) => line.includes("telegram")));
		assert.equal(lines.length, 7);
		fits(lines, 100);
	});

	test("typing filters, and enter takes the one row left", () => {
		const list = new ChoiceList(geometry(), { question: "Which?", choices });
		let picked: string | undefined;
		list.onSelect = (value) => {
			picked = value;
		};
		for (const char of "cons") list.handleInput(char);
		assert.deepEqual(
			list.visible().map((choice) => choice.value),
			["console"],
		);
		list.handleInput("\r");
		assert.equal(picked, "console");
	});

	test("a filter that matches nothing says so, and enter takes nothing", () => {
		const list = new ChoiceList(geometry(), { question: "Which?", choices });
		let picked = false;
		list.onSelect = () => {
			picked = true;
		};
		for (const char of "zzz") list.handleInput(char);
		assert.equal(list.visible().length, 0);
		assert.ok(list.render(100).some((line) => line.includes("no match")));
		list.handleInput("\r");
		assert.equal(picked, false);
	});

	test("the arrows wrap at both ends, and escape cancels", () => {
		const list = new ChoiceList(geometry(), { question: "Which?", choices });
		let cancelled = false;
		list.onCancel = () => {
			cancelled = true;
		};
		list.handleInput("\x1b[A");
		assert.equal(list.render(100).filter((line) => line.includes(glyphs(false).cursor)).length <= 1, true);
		list.handleInput("\x1b[A");
		list.handleInput("\x1b[B");
		list.handleInput("\x1b");
		assert.equal(cancelled, true);
	});

	test("a description moves to its own line when the window is narrow", () => {
		const list = new ChoiceList(geometry(60, 24), { question: "Which?", choices });
		const lines = list.render(60);
		assert.ok(lines.some((line) => line.includes("Telegram, for one person or a group chat")));
		fits(lines, 60);
	});

	test("the list is windowed, and says which rows it is showing", () => {
		const many = Array.from({ length: 20 }, (_, index) => ({ value: `model-${index}`, label: `model-${index}` }));
		const list = new ChoiceList(geometry(100, 14), { question: "Which model?", choices: many });
		const lines = list.render(100);
		assert.ok(lines.length <= 14);
		assert.ok(lines.some((line) => line.includes("of 20")));
		fits(lines, 100);
	});

	test("the preface is the review screen: prose above the question", () => {
		const list = new ChoiceList(geometry(), {
			question: "Apply this plan?",
			preface: ["This is what will be written.", "", "Nothing has been written yet."],
			choices: [{ value: "apply", label: "install it" }],
		});
		const lines = list.render(100);
		assert.equal(lines[0], "This is what will be written.");
		assert.equal(lines[1], "");
		assert.equal(lines[2], "Nothing has been written yet.");
		assert.ok(lines.some((line) => line.includes("Apply this plan?")));
	});
});

describe("MaskedInput", () => {
	test("one mask per character, and never the value", () => {
		const field = new MaskedInput(geometry(), { question: "The API key", hint: "written once", flag: "--key <key>" });
		const renders: string[] = [];
		for (const char of "hunter2") {
			field.handleInput(char);
			renders.push(...field.render(100));
		}
		assert.equal(field.length, 7);
		const last = field.render(100).join("\n");
		assert.ok(last.includes("•".repeat(7)));
		for (const line of renders) assert.ok(!line.includes("hunter"), `a render carried the value: ${line}`);
		assert.ok(
			field.render(100).some((line) => line.includes("--key <key>")),
			"the flag is offered as the way out",
		);
	});

	test("backspace removes one, ctrl+u removes all, and an empty enter submits nothing", () => {
		const field = new MaskedInput(geometry(), { question: "The API key" });
		let submitted: string | undefined;
		field.onSubmit = (value) => {
			submitted = value;
		};
		field.handleInput("\r");
		assert.equal(submitted, undefined);
		field.handleInput("a");
		field.handleInput("b");
		field.handleInput("\x7f");
		assert.equal(field.length, 1);
		field.handleInput("c");
		field.handleInput("\r");
		assert.equal(submitted, "ac");
		field.handleInput("\x15");
		assert.equal(field.length, 0);
	});

	test("a paste is taken whole, and its control characters are not", () => {
		const field = new MaskedInput(geometry(), { question: "The API key" });
		field.handleInput("sk-live-000\t0001");
		assert.equal(field.length, "sk-live-0000001".length);
	});

	test("escape cancels", () => {
		const field = new MaskedInput(geometry(), { question: "The API key" });
		let cancelled = false;
		field.onCancel = () => {
			cancelled = true;
		};
		field.handleInput("\x1b");
		assert.equal(cancelled, true);
	});
});

describe("TextField", () => {
	test("a value that fails validation is shown, and not submitted", () => {
		const field = new TextField(geometry(), {
			question: "What should this agent be called?",
			value: "Bob",
			validate: (value) => (value === value.toLowerCase() ? undefined : "lowercase letters only"),
		});
		let submitted: string | undefined;
		field.onSubmit = (value) => {
			submitted = value;
		};
		field.handleInput("\r");
		assert.equal(submitted, undefined);
		assert.ok(field.render(100).some((line) => line.includes("lowercase letters only")));
		field.accept("bob");
		field.handleInput("\r");
		assert.equal(submitted, "bob");
	});

	test("a required field refuses an empty line, and an optional one takes it", () => {
		const required = new TextField(geometry(), { question: "The model id" });
		let submitted: string | undefined;
		required.onSubmit = (value) => {
			submitted = value;
		};
		required.handleInput("\r");
		assert.equal(submitted, undefined);
		assert.ok(required.render(100).some((line) => line.includes("required")));
		const optional = new TextField(geometry(), { question: "Optional", required: false });
		optional.onSubmit = (value) => {
			submitted = value;
		};
		optional.handleInput("\r");
		assert.equal(submitted, "");
	});

	test("a prefilled answer is edited from its end", () => {
		const field = new TextField(geometry(), { question: "What should this agent be called?", value: "denis" });
		let submitted: string | undefined;
		field.onSubmit = (value) => {
			submitted = value;
		};
		field.handleInput("\x15");
		for (const char of "alice") field.handleInput(char);
		field.handleInput("\r");
		assert.equal(submitted, "alice");
	});

	test("the value is the editor's, and the question is above it", () => {
		const field = new TextField(geometry(), { question: "Which model?", value: "faux-1", hint: "one of a few" });
		const lines = field.render(100);
		assert.equal(lines[0], "Which model?");
		assert.equal(lines[1], "one of a few");
		assert.ok(visible(lines[3] ?? "").includes("faux-1"));
		fits(lines, 100);
	});
});

describe("StatusList and NoteView", () => {
	test("a row draws its state, and a running row spins on the clock", () => {
		const rows = [
			{ label: "provider and model", state: "ok" as const, detail: "the provider answered" },
			{ label: "agent home", state: "run" as const },
			{ label: "checks", state: "skip" as const, detail: "already there" },
		];
		const list = new StatusList(geometry(), rows, { now: () => 0 });
		const lines = list.render(100);
		assert.ok(lines[0]?.includes(utf8.ok));
		assert.ok(
			lines.some((line) => line.includes(utf8.spinner[0] ?? "x")),
			lines.join("\n"),
		);
		assert.ok(lines.some((line) => line.includes("already there")));
		fits(lines, 100);
	});

	test("a note wraps a long line instead of cutting it", () => {
		const note = new NoteView(["mason is one agent, one home, one connector, and this line is far too long to fit"]);
		const lines = note.render(40);
		assert.ok(lines.length > 1);
		assert.equal(
			lines.join(" ").replace(/\s+/g, " ").trim(),
			"mason is one agent, one home, one connector, and this line is far too long to fit",
		);
		fits(lines, 40);
	});
});

describe("Frame", () => {
	function frame(): Frame {
		const built = new Frame(style);
		built.setContext({ brand: "mason", title: "Model and provider", index: 2, total: 7 });
		built.setHints([
			{ key: "enter", label: "select" },
			{ key: "esc", label: "back" },
			{ key: "ctrl+c", label: "quit" },
		]);
		built.mount(new NoteView(["a body"]));
		return built;
	}

	test("the brand, the step, the section and the hints", () => {
		const text = frame().render(100).join("\n");
		assert.ok(text.includes("mason"));
		assert.ok(text.includes("step 2 of 7"));
		assert.ok(text.includes("Model and provider"));
		assert.ok(text.includes("enter select"));
		assert.ok(text.includes("esc back"));
		assert.ok(text.includes("ctrl+c quit"));
	});

	test("every line fits, from a narrow window to a wide one", () => {
		for (const width of [24, 40, 70, 100, 140]) fits(frame().render(width), width);
	});

	test("a narrow window drops the least important hint rather than wrapping", () => {
		const lines = frame().render(20);
		const footer = lines[lines.length - 1] ?? "";
		assert.ok(widthOf(footer) <= 20);
		assert.ok(footer.startsWith("enter"), footer);
		assert.ok(!footer.includes("ctrl+c"), "the last hint is the one dropped");
	});

	test("the body sits two columns in", () => {
		const lines = frame().render(100);
		const body = lines.find((line) => line.includes("a body"));
		assert.ok(body?.startsWith("  a body"));
	});

	test("a flow of one says nothing about progress", () => {
		const single = new Frame(style);
		single.setContext({ brand: "mason", title: "Done", index: 1, total: 1 });
		single.mount(new NoteView(["x"]));
		assert.ok(!single.render(100).join("\n").includes("step 1 of 1"));
	});
});

describe("TerminalScreen", () => {
	/** The real application, on a terminal that keeps what was written to it. */
	function open(size: { columns: number; rows: number } = { columns: 100, rows: 30 }): {
		screen: TerminalScreen;
		terminal: FakeTerminal;
	} {
		const terminal = new FakeTerminal(size);
		const screen = new TerminalScreen({ terminal, paint: style.paint, glyphs: utf8 });
		screen.where({ title: "Model and provider", index: 2, total: 7 });
		return { screen, terminal };
	}

	test("a list answer arrives, and the frame is on the screen", async () => {
		const { screen, terminal } = open();
		const answer = screen.select("provider", "Which provider?", [
			{ value: "opencode-go", label: "opencode-go", description: "OpenCode's own gateway" },
			{ value: "faux", label: "faux", description: "the offline provider" },
		]);
		await settle();
		terminal.type("\x1b[B");
		terminal.type("\r");
		assert.equal(await answer, "faux");
		const text = screenText(terminal.writes, { columns: 100, rows: 30 }).join("\n");
		assert.ok(text.includes("mason"));
		assert.ok(text.includes("step 2 of 7"));
		assert.ok(text.includes("Model and provider"));
		assert.ok(text.includes("Which provider?"));
		assert.ok(text.includes("enter select   esc back   ctrl+c quit"), text);
		screen.close();
	});

	test("a secret is never written to the terminal", async () => {
		const { screen, terminal } = open();
		const answer = screen.secret("key", "The API key", { hint: "written once", flag: "--key <key>" });
		await settle();
		for (const char of "sk-live-0123456789") terminal.type(char);
		await settle();
		const shown = screenText(terminal.writes, { columns: 100, rows: 30 }).join("\n");
		terminal.type("\r");
		assert.equal(await answer, "sk-live-0123456789");
		const stream = terminal.writes.join("");
		assert.ok(!stream.includes("sk-live"), "the key reached the terminal");
		assert.ok(!stream.includes("0123456789"), "part of the key reached the terminal");
		assert.ok(shown.includes("•".repeat("sk-live-0123456789".length)), "the masks are on the screen");
		screen.close();
	});

	test("escape rejects as a cancel, and the screen is released", async () => {
		const { screen, terminal } = open();
		const answer = screen.text("name", "What should this agent be called?");
		await settle();
		terminal.type("\x1b");
		await assert.rejects(answer, Cancelled);
		screen.close();
		screen.close();
	});

	test("a narrow window keeps the frame, and scrolls the body", async () => {
		const { screen, terminal } = open({ columns: 70, rows: 20 });
		const answer = screen.note("review", "Review", {
			lines: Array.from({ length: 30 }, (_, index) => `line ${index} of the review, which is long`),
			note: "enter continues",
		});
		await settle();
		await settle();
		const lines = screenText(terminal.writes, { columns: 70, rows: 20 });
		assert.ok(lines.length <= 20);
		assert.ok(lines[0]?.includes("mason"));
		assert.ok(lines.join("\n").includes("Review"));
		assert.ok(lines.join("\n").includes("enter continue"), "the footer survives a body that does not fit");
		terminal.type("\r");
		await answer;
		screen.close();
	});

	test("a page longer than the window scrolls to its end, and enter continues from there", async () => {
		const { screen, terminal } = open();
		const answering = screen.note("long", "The plan", {
			lines: Array.from({ length: 40 }, (_, index) => `line ${index}`),
		});
		await settle();
		const first = screenText(terminal.writes, { columns: 100, rows: 30 }).join("\n");
		assert.ok(first.includes("line 0"));
		assert.ok(!first.includes("line 39"), "the page is longer than the window, which is what this test is about");
		assert.ok(first.includes("up/down scroll"), "the footer says the page goes on below the fold");
		// The arrows reach the scroll view: the page being read is never the thing that swallows them.
		// The arrows are the alt screen's own: it repaints on its frame timer, so a real tick is what makes them visible.
		for (let index = 0; index < 30; index += 1) terminal.type("\x1b[B");
		await new Promise((resolve) => setTimeout(resolve, 40));
		const last = screenText(terminal.writes, { columns: 100, rows: 30 }).join("\n");
		assert.ok(last.includes("line 39"), `scrolled to the end:\n${last}`);
		terminal.type("\r");
		await answering;
		screen.close();
	});

	test("a window that shrinks to nothing still has its frame, and every line fits it", async () => {
		const { screen, terminal } = open();
		const answering = screen.select(
			"connector",
			"How will you talk to it?",
			[
				{ value: "console", label: "the console", description: "built in: no token, no container" },
				{ value: "telegram", label: "telegram", description: "a bot token, and a container beside mason" },
			],
			{ hint: "the console needs nothing; telegram needs a token from the bot's father" },
		);
		await settle();
		terminal.resize(58, 16);
		screen.where({ title: "Connector", index: 4, total: 7 });
		await settle();
		const lines = screenText(terminal.writes, { columns: 58, rows: 16 });
		assert.equal(lines.length, 16);
		assert.ok(
			lines.every((line) => visible(line).length <= 58),
			`nothing is wider than the window:\n${lines.map(visible).join("\n")}`,
		);
		const text = lines.join("\n");
		assert.ok(text.includes("mason"), "the brand survives");
		assert.ok(text.includes("step 4 of 7"), "the counter survives even when the dots do not");
		assert.ok(!text.includes("●"), "the dots are the first thing the width drops");
		terminal.type("\r");
		await answering;
		screen.close();
	});

	test("a progress screen takes keys, and reports the rows it ended with", async () => {
		const { screen, terminal } = open();
		const progress = screen.progress("apply", "Installing", [{ label: "provider and model", state: "run" }]);
		await settle();
		progress.update([{ label: "provider and model", state: "fail", detail: "the provider did not answer" }]);
		await settle();
		await settle();
		const text = screenText(terminal.writes, { columns: 100, rows: 30 }).join("\n");
		assert.ok(text.includes("the provider did not answer"));
		const key = progress.key([
			{ key: "r", label: "retry what failed" },
			{ key: "enter", label: "stop here" },
		]);
		await settle();
		const hints = screenText(terminal.writes, { columns: 100, rows: 30 }).join("\n");
		assert.ok(hints.includes("retry what failed"), "the key carries its own label, not the keycode");
		terminal.type("r");
		assert.equal(await key, "r");
		progress.close();
		screen.close();
	});
});
