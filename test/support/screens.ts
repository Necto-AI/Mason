/**
 * The screens the wizard shows, built the way a flow builds them: the same calls, the same copy, no mocked component.
 *
 * The golden test and the script that regenerates its frames both read this, so the frame in the test file is the frame
 * this code draws and not a second description of it. The copy here is representative rather than final — a flow owns what
 * its own screens say — but the shape of each screen is the shape the frame rules are about.
 */
import { paint } from "../../src/tui/style.ts";
import type { Harness } from "./screen.ts";

/** One screen to render: where the flow says it is, and the question it asks there. */
export interface Shot {
	readonly id: string;
	readonly section: string;
	readonly index: number;
	readonly total: number;
	/** Ask the question. The promise settles the way a flow's would: it is left pending while the frame is read. */
	show(harness: Harness): Promise<unknown>;
	/** Keys the screen's own question types before the frame is read, emitted in one burst the way a paste arrives. */
	type?(harness: Harness): void;
}

const ink = paint(true);
const glyphs = (text: string): string => text;

/** The rows a status list shows while an apply runs: never a `run` row, so the frame does not carry a clock. */
const INSTALL_ROWS = [
	{ label: "provider answered", state: "ok" as const, detail: "1.2s" },
	{ label: "store written", state: "ok" as const, detail: "~/.mason/common" },
	{ label: "home created", state: "ok" as const, detail: "~/.mason/alice" },
	{ label: "grant written", state: "ok" as const },
	{ label: "mason doctor", state: "wait" as const, detail: "nine read-only checks" },
];

/** The summary of a finished install: long enough that its edge is what says where it ends. */
const SUMMARY = [
	ink.ok("✓ installed"),
	"",
	`${ink.dim("agent".padEnd(12))}~/.mason/alice`,
	`${ink.dim("grants".padEnd(12))}console`,
	`${ink.dim("checks".padEnd(12))}${ink.ok("9 of 9 passed")}`,
	`${ink.dim("running".padEnd(12))}${ink.warn("not up yet")}`,
	"",
	ink.heading("Start it"),
	`${ink.dim(glyphs("❯"))} mason up -b alice`,
	`${ink.dim(glyphs("❯"))} mason chat -b alice`,
];

/** The plan a person approves: the one thing on any screen that is boxed because a decision is made against it. */
const PLAN = [
	`${ink.heading("The plan")}  ${ink.dim("nothing is written yet")}`,
	"",
	`${ink.dim("agent".padEnd(12))}alice`,
	`${ink.dim("home".padEnd(12))}~/.mason/alice`,
	"",
	`${ink.dim("model".padEnd(12))}anthropic/claude-sonnet-4-5`,
	`${ink.dim("key".padEnd(12))}from the store, never printed`,
	"",
	`${ink.dim("connector".padEnd(12))}console, built in`,
	`${ink.dim("may".padEnd(12))}the terminal's words; /stop /compact /clear /status`,
];

export const SHOTS: readonly Shot[] = [
	{
		id: "welcome",
		section: "Welcome",
		index: 1,
		total: 7,
		show: (harness) =>
			harness.screen.select(
				"welcome.mode",
				"How would you like to start?",
				[
					{
						value: "quickstart",
						label: "Quickstart",
						description: "the defaults, and only the questions they cannot answer",
					},
					{
						value: "advanced",
						label: "Advanced",
						description: "every answer: the connector's own settings, and whether it starts",
					},
				],
				{
					preface: [
						"This run sets up the model it thinks with, the home it works in, and the way you talk to it.",
						"",
						ink.dim("Both modes run the same commands; advanced only asks more questions about them."),
					],
				},
			),
	},
	{
		id: "text",
		section: "The bot",
		index: 2,
		total: 7,
		show: (harness) =>
			harness.screen.text("agent.name", "What should this agent be called?", {
				hint: "the name of its home under ~/.mason, and the bot `mason up -b` starts",
				value: "alice",
				validate: (value: string) => (value === value.toLowerCase() ? undefined : "lowercase letters only"),
			}),
	},
	{
		id: "secret",
		section: "Model and provider",
		index: 3,
		total: 7,
		type: (harness) => {
			for (const char of "sk-ant-api03-abcdefghijklmnop") void harness.press(char);
		},
		show: (harness) =>
			harness.screen.secret("provider.key", "The anthropic API key", {
				hint: "It is written to ~/.mason/common/provider.json and never shown again.",
				flag: "--key <key>",
				journey: {
					url: "https://console.anthropic.com/settings/keys",
					what: "create a key and copy it",
				},
			}),
	},
	{
		id: "confirm",
		section: "Start it now?",
		index: 4,
		total: 7,
		show: (harness) =>
			harness.screen.confirm("connector.start", "Start it now?", {
				yes: "start it beside mason",
				no: "write the compose file and leave it stopped",
			}),
	},
	{
		id: "note",
		section: "What it may do",
		index: 5,
		total: 7,
		show: (harness) =>
			harness.screen.note("connector.permissions", "What it may do", {
				lines: [
					`${ink.ok("✓")} the terminal's words reach the agent as the owner's`,
					`${ink.dim("·")} /stop, /compact, /clear and /status answer from the socket`,
					"",
					ink.dim("A credential for this connector is minted at the end of the run, and printed once."),
				],
			}),
	},
	{
		id: "review",
		section: "Review",
		index: 6,
		total: 7,
		show: (harness) =>
			harness.screen.select("review.action", "Apply this plan?", [{ value: "apply", label: "install it" }], {
				preface: PLAN,
			}),
	},
	{
		id: "progress",
		section: "Install",
		index: 7,
		total: 7,
		show: (harness) => {
			harness.screen.progress("apply.steps", "What it is doing", INSTALL_ROWS);
			return new Promise(() => {});
		},
	},
	{
		id: "done",
		section: "Done",
		index: 7,
		total: 7,
		show: (harness) =>
			harness.screen.note("done.read", "The summary", {
				lines: SUMMARY,
				note: "enter continues",
			}),
	},
];
