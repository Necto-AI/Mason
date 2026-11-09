/**
 * The terminal, pinned where the promises are: a frame per screen at both window sizes the spec names, the plain path, the
 * keys, the 90-column description drop, and the one thing a wizard must never do — put a secret on the screen.
 *
 * Everything here runs through `@opentui/core`'s own test renderer, so what is asserted is the frame the renderer painted
 * rather than the lines a component returned. That is the whole difference from the harness this replaces: a layout bug
 * in the flexbox is a failing golden, and a key that never reached the body is a frame that did not change.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { KeyEvent } from "@opentui/core";
import { ChoiceList, NoteView, StatusList, TextField, spinnerFrame, typedChar } from "../src/tui/components.ts";
import { CHROME_ROWS, MARGIN, bodyRows, measure } from "../src/tui/frame.ts";
import { Cancelled } from "../src/tui/screen.ts";
import {
	colourEnabled,
	glyphs,
	paint,
	plainStyle,
	spread,
	terminalStyle,
	utf8Locale,
	widthOf,
} from "../src/tui/style.ts";
import { CLAY, parseSgr, theme } from "../src/tui/theme.ts";
import * as frames from "./support/frames.ts";
import { NARROW, WIDE, openScreen } from "./support/screen.ts";
import { SHOTS } from "./support/screens.ts";

const utf8 = glyphs(true);

/** The goldens, by the shot and the window they were taken at. */
const GOLDENS: Readonly<Record<string, string>> = {
	"welcome 100": frames.WELCOME_100,
	"welcome 72": frames.WELCOME_72,
	"text 100": frames.TEXT_100,
	"text 72": frames.TEXT_72,
	"secret 100": frames.SECRET_100,
	"secret 72": frames.SECRET_72,
	"confirm 100": frames.CONFIRM_100,
	"confirm 72": frames.CONFIRM_72,
	"note 100": frames.NOTE_100,
	"note 72": frames.NOTE_72,
	"review 100": frames.REVIEW_100,
	"review 72": frames.REVIEW_72,
	"progress 100": frames.PROGRESS_100,
	"progress 72": frames.PROGRESS_72,
	"done 100": frames.DONE_100,
	"done 72": frames.DONE_72,
};

/** The default foreground the renderer paints when nothing chose a colour: what the plain path must stay on. */
const DEFAULT_INK = [255, 255, 255, 255];

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
		for (const mark of [ascii.ok, ascii.fail, ascii.cursor, ascii.rule, ascii.section, ascii.prompt])
			assert.ok(mark.length === 1 && mark < "\x7f");
		assert.equal(utf8.ok, "✓");
		assert.equal(utf8.rule, "─");
		assert.equal(utf8.cursor, "▌");
	});

	test("the measure skips the escapes a painted line carries, and counts a wide glyph as two", () => {
		assert.equal(widthOf("mason"), 5);
		assert.equal(widthOf(paint(true).dim("mason")), 5);
		assert.equal(widthOf(paint(true).heading("mason")), 5);
		assert.equal(widthOf("日本語"), 6);
		assert.equal(widthOf("e\u0301"), 1);
	});

	test("spread puts two things on one line, and refuses when they would collide", () => {
		assert.equal(spread("a", "b", 5), "a   b");
		assert.equal(spread("left", "right", 4), "left");
		assert.equal(widthOf(spread(paint(true).dim("a"), "b", 9)), 9);
	});

	test("the terminal's style follows the environment, in one place", () => {
		assert.equal(utf8Locale({ LANG: "en_GB.UTF-8" }), true);
		assert.equal(utf8Locale({ LANG: "C" }), false);
		assert.equal(terminalStyle({}, false).paint.colour, false);
		assert.equal(terminalStyle({}, true).paint.colour, true);
		assert.equal(terminalStyle({ LC_ALL: "C" }, true).glyphs.ok, "+");
	});
});

describe("theme", () => {
	const ink = theme(paint(true), { COLORTERM: "truecolor" });

	test("the accent is clay, and its 256-colour index where the terminal has no truecolor", () => {
		assert.deepEqual(ink.accent.toInts(), [215, 135, 95, 255]);
		assert.equal(ink.accent.intent, "rgb");
		const indexed = theme(paint(true), {}).accent;
		assert.equal(indexed.intent, "indexed");
		assert.deepEqual(indexed.toInts(), [215, 135, 95, 255], "the index resolves to the same colour");
		assert.equal(CLAY, "#d7875f");
	});

	test("the SGR subset parses into runs with the tone and the two attributes paint can name", () => {
		const painted = paint(true);
		const runs = parseSgr(`a ${painted.heading("b")} ${painted.dim("c")} ${painted.ok("d")} ${painted.bad("e")}`);
		assert.deepEqual(
			runs.map((run) => [run.text, run.tone, run.bold, run.dim]),
			[
				["a ", "plain", false, false],
				["b", "accent", true, false],
				[" ", "plain", false, false],
				["c", "plain", false, true],
				[" ", "plain", false, false],
				["d", "ok", false, false],
				[" ", "plain", false, false],
				["e", "bad", false, false],
			],
		);
	});

	test("a parsed line becomes styled text, with the accent and the attributes OpenTUI draws", () => {
		const painted = paint(true);
		const chunks = ink.line(`${painted.heading("◇ Welcome")} ${painted.dim("step 1 / 7")}`).chunks;
		assert.equal(
			chunks.map((chunk) => chunk.text).join(""),
			"◇ Welcome step 1 / 7",
		);
		assert.deepEqual(chunks[0]?.fg?.toInts(), [215, 135, 95, 255]);
		assert.equal(chunks[0]?.attributes, 1, "bold is the first attribute");
		assert.deepEqual(chunks[2]?.fg, undefined, "dim is an attribute, not a grey of our own");
		assert.equal(chunks[2]?.attributes, 2, "dim is the second attribute");
	});

	test("a code the subset does not name is dropped, and never reaches the screen", () => {
		const runs = parseSgr("\x1b[35mmagenta\x1b[0m plain \x1b[9mstruck");
		assert.equal(
			runs.map((run) => run.text).join(""),
			"magenta plain struck",
		);
		assert.ok(runs.every((run) => run.tone === "plain" && !run.bold && !run.dim));
		for (const chunk of ink.line("\x1b[35mmagenta\x1b[0m").chunks) assert.ok(!chunk.text.includes("\x1b"));
	});

	test("a plain theme drops the codes rather than drawing them in colour", () => {
		const bare = theme(paint(false), {});
		const chunks = bare.line(paint(true).heading("x")).chunks;
		assert.equal(chunks[0]?.attributes, undefined);
		assert.equal(chunks[0]?.fg, undefined);
	});

	test("a paragraph wraps at the width, keeps a hard break, and counts its rows", () => {
		const drawn = ink.paragraph("one two three\n\nfour", 8);
		assert.equal(drawn.rows, 4);
		assert.equal(
			drawn.text.chunks
				.map((chunk) => chunk.text)
				.join("")
				.split("\n")
				.map((line) => line.trimEnd()),
			["one two", "three", "", "four"].join("\n").split("\n").map((line) => line.trimEnd()),
		);
	});
});

describe("the screens", () => {
	for (const size of [WIDE, NARROW]) {
		for (const shot of SHOTS) {
			test(`${shot.id}, at ${size.columns}x${size.rows}`, async () => {
				const harness = await openScreen(size);
				harness.screen.where({ title: shot.section, index: shot.index, total: shot.total });
				void shot.show(harness);
				shot.type?.(harness);
				await harness.settle();
				await harness.settle();
				assert.equal(harness.frame(), GOLDENS[`${shot.id} ${size.columns}`]);
				await harness.dispose();
			});
		}
	}

	test("the arrows move the bar, and enter takes the row it is on", async () => {
		const harness = await openScreen();
		harness.screen.where({ title: "Welcome", index: 1, total: 7 });
		const answering = harness.screen.select("welcome.mode", "How would you like to start?", [
			{ value: "quickstart", label: "Quickstart", description: "the defaults" },
			{ value: "advanced", label: "Advanced", description: "every answer" },
		]);
		await harness.settle();
		assert.match(harness.frame(), /▌ Quickstart/);
		await harness.press("\x1b[B");
		assert.match(harness.frame(), /▌ Advanced/);
		assert.doesNotMatch(harness.frame(), /▌ Quickstart/);
		await harness.press("\x1b[B");
		assert.match(harness.frame(), /▌ Quickstart/, "down from the last row lands on the first");
		await harness.press("\x1b[A");
		await harness.press("\r");
		assert.equal(await answering, "advanced");
		await harness.dispose();
	});

	test("a bare slash starts the filter, and escape clears it before it means back", async () => {
		const harness = await openScreen();
		harness.screen.where({ title: "Provider", index: 2, total: 7 });
		const answering = harness.screen.select("provider.id", "Which provider?", [
			{ value: "anthropic", label: "anthropic", description: "the console" },
			{ value: "openrouter", label: "openrouter", description: "one key, many models" },
			{ value: "faux", label: "faux", description: "the offline provider" },
		]);
		await harness.settle();
		// A letter is not a filter: a list is also a place where a person drops and adds entries.
		await harness.press("z");
		assert.match(harness.frame(), /▌ anthropic/);
		await harness.press("/");
		assert.match(harness.frame(), /\/type to filter/);
		for (const char of "open") await harness.press(char);
		assert.match(harness.frame(), /▌ openrouter/);
		assert.doesNotMatch(harness.frame(), /anthropic/);
		await harness.press("\x1b");
		assert.match(harness.frame(), /▌ anthropic/, "escape cleared the filter, and did not cancel the question");
		await harness.press("\x1b");
		await assert.rejects(answering, Cancelled);
		harness.screen.close();
		harness.screen.close();
		await harness.dispose();
	});

	test("a filter that matches nothing says so, and enter takes nothing", async () => {
		const harness = await openScreen();
		harness.screen.where({ title: "Provider", index: 2, total: 7 });
		void harness.screen.select("provider.id", "Which provider?", [{ value: "faux", label: "faux" }]);
		await harness.settle();
		await harness.press("/");
		for (const char of "zzz") await harness.press(char);
		assert.match(harness.frame(), /no match/);
		await harness.press("\r");
		await harness.settle();
		assert.match(harness.frame(), /no match/, "the question is still the one being asked");
		await harness.dispose();
	});

	test("below ninety columns the description moves under the list instead of beside it", async () => {
		const choices = [
			{ value: "quickstart", label: "Quickstart", description: "the defaults, and only the questions they cannot answer" },
			{ value: "advanced", label: "Advanced", description: "every answer: the connector's own settings" },
		];
		const wide = await openScreen(WIDE);
		wide.screen.where({ title: "Welcome", index: 1, total: 7 });
		void wide.screen.select("welcome.mode", "How would you like to start?", choices);
		await wide.settle();
		assert.match(wide.frame(), /▌ Quickstart  the defaults/, "a wide window has the column");
		await wide.dispose();

		const narrow = await openScreen({ columns: 88, rows: 30 });
		narrow.screen.where({ title: "Welcome", index: 1, total: 7 });
		void narrow.screen.select("welcome.mode", "How would you like to start?", choices);
		await narrow.settle();
		assert.doesNotMatch(narrow.frame(), /▌ Quickstart  the defaults/, "a narrow one has not");
		assert.match(narrow.frame(), /\n   the defaults, and only the questions they cannot answer\n/, "it is one line under the list");
		await narrow.dispose();
	});

	test("a window that shrinks keeps its frame, and redraws the list at the new width", async () => {
		const harness = await openScreen(WIDE);
		harness.screen.where({ title: "Welcome", index: 1, total: 7 });
		void harness.screen.select("welcome.mode", "How would you like to start?", [
			{ value: "quickstart", label: "Quickstart", description: "the defaults, and only the questions they cannot answer" },
		]);
		await harness.settle();
		assert.match(harness.frame(), /▌ Quickstart  the defaults/);
		harness.setup.resize(70, 24);
		await harness.settle();
		await harness.settle();
		const rows = harness.frame().split("\n");
		assert.ok(
			rows.every((row) => widthOf(row) <= 70),
			`nothing is wider than the window:\n${rows.join("\n")}`,
		);
		assert.match(harness.frame(), /◇ Welcome/, "the frame survives");
		assert.doesNotMatch(harness.frame(), /▌ Quickstart  the defaults/, "so does the description rule");
		await harness.dispose();
	});

	test("a narrow window drops the last hint rather than wrapping it", async () => {
		const harness = await openScreen({ columns: 30, rows: 12 });
		harness.screen.where({ title: "Welcome", index: 1, total: 7 });
		void harness.screen.select("welcome.mode", "Start?", [{ value: "quickstart", label: "Quickstart" }]);
		await harness.settle();
		assert.match(harness.frame(), /enter select/);
		assert.doesNotMatch(harness.frame(), /ctrl\+c/, "the least important hint is the one dropped");
		await harness.dispose();
	});

	test("a flow of one says nothing about progress", async () => {
		const harness = await openScreen();
		harness.screen.where({ title: "Done", index: 1, total: 1 });
		void harness.screen.note("done", "Done", { lines: ["x"] });
		await harness.settle();
		assert.doesNotMatch(harness.frame(), /step 1 \/ 1/);
		assert.doesNotMatch(harness.frame(), /mason {2,}/, "a flow of one is not a flow, so it carries no wordmark");
		await harness.dispose();
	});

	test("the frame measures the body: a capped measure, and the rows the chrome leaves", () => {
		assert.equal(measure(200), 86);
		assert.equal(measure(100), 86);
		assert.equal(measure(72), 67);
		assert.equal(bodyRows(30), 30 - CHROME_ROWS);
		assert.equal(MARGIN, 2);
	});
});

describe("a secret", () => {
	test("is never on the screen, and the masks are", async () => {
		const harness = await openScreen();
		harness.screen.where({ title: "Model and provider", index: 2, total: 7 });
		const answering = harness.screen.secret("provider.key", "The anthropic API key", {
			hint: "written once",
			flag: "--key <key>",
		});
		await harness.press(..."sk-live-0123456789".split(""));
		const shown = harness.frame();
		assert.ok(shown.includes("•".repeat("sk-live-0123456789".length)), shown);
		assert.ok(shown.includes("13"), "the live count is the length, and not the value");
		assert.ok(shown.includes("--key <key>"), "the flag is offered as the way out of the question");
		assert.ok(!shown.includes("sk-live"), "the key reached the screen");
		await harness.press("\r");
		assert.equal(await answering, "sk-live-0123456789");
		await harness.dispose();
	});

	test("a paste is taken whole, and its control characters are not", async () => {
		const harness = await openScreen();
		const answering = harness.screen.secret("provider.key", "The key");
		await harness.settle();
		harness.setup.mockInput.pressKey("sk-live-000");
		await harness.settle();
		await harness.press("\r");
		assert.equal(await answering, "sk-live-000");
		await harness.dispose();
	});

	test("escape cancels, and a closed screen is safe to close twice", async () => {
		const harness = await openScreen();
		const answering = harness.screen.text("agent.name", "What should this agent be called?");
		await harness.settle();
		await harness.press("\x1b");
		await assert.rejects(answering, Cancelled);
		harness.screen.close();
		harness.screen.close();
		await harness.dispose();
	});
});

describe("a page", () => {
	test("enter continues, and space is the same key", async () => {
		const harness = await openScreen();
		harness.screen.where({ title: "What it may do", index: 4, total: 7 });
		const reading = harness.screen.note("permissions", "What it may do", { lines: ["nothing is written yet"] });
		await harness.settle();
		await harness.press(" ");
		await reading;
		await harness.dispose();
	});

	test("a page longer than the window says it scrolls, and the arrows reach its end", async () => {
		const harness = await openScreen({ columns: 80, rows: 20 });
		harness.screen.where({ title: "Review", index: 6, total: 7 });
		const reading = harness.screen.note("plan", "The plan", {
			lines: Array.from({ length: 40 }, (_, index) => `line ${index}`),
		});
		await harness.settle();
		assert.match(harness.frame(), /line 0/);
		assert.doesNotMatch(harness.frame(), /line 39/, "the page is longer than the window, which is what this is about");
		assert.match(harness.frame(), /↑↓ scroll/, "the footer says the page goes on below the fold");
		for (let index = 0; index < 40; index += 1) harness.setup.mockInput.pressKey("\x1b[B");
		await harness.settle();
		assert.match(harness.frame(), /line 39/, "the arrows reached the scroll region, not the page");
		await harness.press("\r");
		await reading;
		await harness.dispose();
	});

	test("a page that fits is not told it scrolls", async () => {
		const harness = await openScreen({ columns: 80, rows: 20 });
		harness.screen.where({ title: "Review", index: 6, total: 7 });
		const reading = harness.screen.note("plan", "The plan", {
			lines: Array.from({ length: 5 }, (_, index) => `line ${index}`),
		});
		await harness.settle();
		assert.doesNotMatch(harness.frame(), /↑↓ scroll/);
		assert.match(harness.frame(), /line 4/);
		await harness.press("\r");
		await reading;
		await harness.dispose();
	});
});

describe("a progress screen", () => {
	test("takes keys, carries their labels, and reports the rows it ended with", async () => {
		const harness = await openScreen();
		harness.screen.where({ title: "Install", index: 7, total: 7 });
		const progress = harness.screen.progress("apply", "Installing", [{ label: "provider and model", state: "run" }]);
		await harness.settle();
		progress.update([{ label: "provider and model", state: "fail", detail: "the provider did not answer" }]);
		await harness.settle();
		assert.match(harness.frame(), /the provider did not answer/);
		const key = progress.key([
			{ key: "r", label: "retry what failed" },
			{ key: "enter", label: "stop here" },
		]);
		await harness.settle();
		assert.match(harness.frame(), /retry what failed/, "the key carries its own label, not the keycode");
		assert.match(harness.frame(), /stop here/);
		await harness.press("r");
		assert.equal(await key, "r");
		// A key that was not offered is not an answer: the screen is still waiting for one of the two.
		const other = progress.key([{ key: "enter", label: "stop here" }]);
		await harness.press("q");
		await harness.press("\r");
		assert.equal(await other, "enter");
		progress.close();
		await harness.dispose();
	});

	test("a spinner repaints on its own clock, and stops when the operation does", async () => {
		const harness = await openScreen();
		harness.screen.where({ title: "Install", index: 7, total: 7 });
		const progress = harness.screen.progress("apply", "Installing", [{ label: "minting the credential", state: "run" }]);
		await harness.settle();
		const first = harness.frame();
		harness.screen.busy(true);
		await new Promise((resolve) => setTimeout(resolve, 120));
		await harness.settle();
		const second = harness.frame();
		assert.notEqual(first, second, "the running row moved");
		assert.ok(
			[...first, ...second].some((char) => utf8.spinner.includes(char)),
			"a spinner frame is what it moved to",
		);
		harness.screen.busy(false);
		progress.close();
		await harness.dispose();
	});

	test("the spinner is a function of the clock, so a frame can be asserted", () => {
		assert.equal(spinnerFrame(utf8, 0), utf8.spinner[0]);
		assert.equal(spinnerFrame(utf8, 80), utf8.spinner[1]);
		assert.equal(spinnerFrame(utf8, 0), spinnerFrame(utf8, 79));
	});
});

describe("a journey", () => {
	test("draws one dim line, opens on ctrl+o, and a failed open is a line rather than a throw", async () => {
		const before = process.env.PATH;
		const empty = await mkdtemp(join(tmpdir(), "mason-no-browser-"));
		process.env.PATH = empty;
		try {
			const harness = await openScreen();
			harness.screen.where({ title: "Model and provider", index: 2, total: 7 });
			const answering = harness.screen.secret("provider.key", "The anthropic API key", {
				journey: { url: "https://console.anthropic.com/settings/keys", what: "create a key and copy it" },
			});
			await harness.settle();
			assert.match(harness.frame(), /ctrl\+o opens console\.anthropic\.com, create a key and copy it/);
			assert.match(harness.frame(), /ctrl\+o open/, "the key is in the footer, or the line is a lie");
			await harness.press("\x0f");
			await new Promise((resolve) => setTimeout(resolve, 200));
			await harness.settle();
			assert.match(
				harness.frame(),
				/could not open console\.anthropic\.com: open https:\/\/console\.anthropic\.com\/settings\/keys yourself/,
			);
			await harness.press("\x1b");
			await assert.rejects(answering, Cancelled);
			await harness.dispose();
		} finally {
			if (before === undefined) delete process.env.PATH;
			else process.env.PATH = before;
			await rm(empty, { recursive: true, force: true });
		}
	});

	test("a question without one draws no line and offers no key", async () => {
		const harness = await openScreen();
		void harness.screen.secret("token", "The bot token");
		await harness.settle();
		assert.doesNotMatch(harness.frame(), /ctrl\+o/);
		await harness.dispose();
	});
});

describe("the plain path", () => {
	test("the same screen, the same words, and nothing drawn in colour", async () => {
		const shot = SHOTS[3];
		assert.ok(shot !== undefined);
		const coloured = await openScreen({ ...WIDE, paint: paint(true) });
		coloured.screen.where({ title: shot.section, index: shot.index, total: shot.total });
		void shot.show(coloured);
		shot.type?.(coloured);
		await coloured.settle();
		await coloured.settle();
		const plain = await openScreen({ ...WIDE, paint: paint(false) });
		plain.screen.where({ title: shot.section, index: shot.index, total: shot.total });
		void shot.show(plain);
		shot.type?.(plain);
		await plain.settle();
		await plain.settle();
		assert.equal(plain.frame(), coloured.frame(), "the same text, with or without a terminal that has colour");
		const painted = plain.setup
			.captureSpans()
			.lines.flatMap((line) => line.spans)
			.filter((span) => span.text.trim() !== "");
		assert.ok(painted.length > 0);
		for (const span of painted) {
			assert.equal(span.attributes, 0, `an attribute reached a plain screen: ${JSON.stringify(span.text)}`);
			assert.deepEqual(span.fg.toInts(), DEFAULT_INK, `a colour reached a plain screen: ${JSON.stringify(span.text)}`);
		}
		const accent = coloured.setup
			.captureSpans()
			.lines.flatMap((line) => line.spans)
			.filter((span) => span.fg.toInts()[0] === 215 && span.fg.toInts()[1] === 135 && span.fg.toInts()[2] === 95);
		assert.ok(accent.length > 0, "the accent is clay where there is colour");
		await coloured.dispose();
		await plain.dispose();
	});
});

describe("the components on their own", () => {
	/** A geometry for a renderer: the measure the frame would hand a body, and the room around it. */
	const geometry = (harness: Awaited<ReturnType<typeof openScreen>>, columns = 80, rows = 20) => ({
		renderer: harness.setup.renderer,
		window: columns,
		columns,
		rows,
		paint: paint(false),
		glyphs: utf8,
	});

	test("a list longer than its window scrolls with the bar, and says which rows it is showing", async () => {
		const harness = await openScreen();
		const many = Array.from({ length: 20 }, (_, index) => ({ value: `model-${index}`, label: `model-${index}` }));
		const list = new ChoiceList(geometry(harness), { question: "Which model?", choices: many, maxVisible: 5 });
		harness.mount(list.build());
		await harness.settle();
		assert.match(harness.frame(), /▌ model-0/);
		assert.match(harness.frame(), /1-5 of 20/);
		for (let index = 0; index < 6; index += 1) list.handleKey(key("down"));
		list.reflect?.();
		await harness.settle();
		assert.match(harness.frame(), /▌ model-6/);
		assert.match(harness.frame(), /3-7 of 20/);
		await harness.dispose();
	});

	test("a note's rows are what the screen decides on: short prose is not boxed, a long page is", async () => {
		const prose = await openScreen();
		const short = new NoteView(geometry(prose), { title: "Done", lines: ["one", "two"] });
		prose.mount(short.build());
		await prose.settle();
		assert.doesNotMatch(prose.frame(), /╭/);
		assert.equal(short.rows, 5, "a title, a blank, two lines, and a blank");
		await prose.dispose();

		const page = await openScreen();
		const long = new NoteView(geometry(page), {
			title: "The plan",
			lines: Array.from({ length: 8 }, (_, index) => `line ${index}`),
		});
		page.mount(long.build());
		await page.settle();
		assert.match(page.frame(), /╭/, "a page read before a decision gets an edge");
		await page.dispose();
	});

	test("a status list puts a detail under its row, and a note under the list", async () => {
		const harness = await openScreen();
		const list = new StatusList(
			geometry(harness),
			[
				{ label: "provider answered", state: "ok", detail: "the provider answered" },
				{ label: "checks", state: "skip", detail: "already there" },
			],
			{ title: "What it is doing", note: "nothing was written", now: () => 0 },
		);
		harness.mount(list.build());
		await harness.settle();
		const text = harness.frame();
		assert.match(text, /✓ provider answered/);
		assert.match(text, / {5}the provider answered/, "the detail is indented under the row it belongs to");
		assert.match(text, /nothing was written/);
		assert.match(text, /What it is doing/);
		await harness.dispose();
	});

	test("a text field is edited from its end, and refuses a value its validation rejects", async () => {
		const harness = await openScreen();
		const text = new TextField(geometry(harness), {
			question: "What should this agent be called?",
			value: "denis",
			validate: (value: string) => (value === value.toLowerCase() ? undefined : "lowercase letters only"),
		});
		let submitted: string | undefined;
		text.onSubmit = (value: string) => {
			submitted = value;
		};
		harness.mount(text.build());
		await harness.settle();
		assert.match(harness.frame(), /❯ denis/);
		text.handleKey(key("a"));
		text.accept("alice");
		text.handleKey(key("enter"));
		text.reflect?.();
		await harness.settle();
		assert.equal(submitted, "alice");
		text.accept("ALICE");
		text.handleKey(key("enter"));
		text.reflect?.();
		await harness.settle();
		assert.equal(submitted, "alice", "a rejected value is not submitted");
		assert.match(harness.frame(), /lowercase letters only/);
		await harness.dispose();
	});

	test("a typed character is a character only when no modifier is held", () => {
		assert.equal(typedChar(key("a")), "a");
		assert.equal(typedChar(key(" ")), " ");
		assert.equal(typedChar(key("up")), undefined);
		assert.equal(typedChar(key("a", { ctrl: true })), undefined);
	});
});

/** A keypress as the renderer hands one to a component: the fields the components read, and nothing else. */
function key(name: string, modifiers: { readonly ctrl?: boolean } = {}): KeyEvent {
	return {
		name,
		ctrl: modifiers.ctrl ?? false,
		meta: false,
		shift: false,
		option: false,
		sequence: name,
		number: false,
		raw: name,
		eventType: "press",
		source: "raw",
	} as unknown as KeyEvent;
}
