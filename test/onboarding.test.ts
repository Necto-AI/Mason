/**
 * The onboarding flow, driven without a terminal: what is asked, in what order, what the answers become, and what happens
 * when an operation says no.
 *
 * The screens are the real ones (`onboarding.ts`), and the screen they talk to is `ScriptedScreen`: it answers from a
 * table and fails on a question the script does not answer, so "this run asks nothing twice" is a passing test rather
 * than a claim. The operations are a fake because the failures are the point — a provider that does not answer, a
 * connector that half-installs, a check that fails after everything was written — and a real one cannot be made to fail
 * on demand in a test that is not about podman.
 *
 * What is *not* faked is the flow: the same `runOnboarding`, the same steps, the same argv building, the same exit codes.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { runOnboard } from "../scripts/onboard.ts";
import {
	answeredPrompter,
	botNameProblem,
	type Operations,
	preseed,
	redact,
	runOnboarding,
} from "../scripts/onboarding.ts";
import type { DoctorCheck } from "../src/server/doctor.ts";
import { CANCEL, ScriptedScreen } from "../src/tui/screen.ts";

const roots: string[] = [];
after(async () => {
	for (const directory of roots) await rm(directory, { recursive: true, force: true });
	delete process.env.PI_FAUX_MODEL;
});

async function tempRoot(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-onboarding-"));
	roots.push(directory);
	return directory;
}

/** The offline provider's catalog: one provider, one model, and no network. */
function fauxAccess(): Awaited<ReturnType<Operations["providers"]>> {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, faux: true };
}

const PASSING: readonly DoctorCheck[] = [
	{ name: "home", ok: true, detail: "a home with both halves" },
	{ name: "model", ok: true, detail: "faux/faux-1, the offline provider needs no key" },
	{ name: "server", ok: true, detail: "nothing is listening on 127.0.0.1:8787 yet (mason up starts it)" },
];

interface Fixture {
	readonly calls: string[];
	readonly operations: Operations;
	/** Make one operation fail: `init` return 1, `setup` return 1, `verify` throw, `doctor` fail a check. */
	readonly break_: {
		init: boolean;
		create: boolean;
		setup: number;
		verify: boolean;
		checks: readonly DoctorCheck[];
		up: boolean;
		ready: boolean;
		podman: boolean;
		/** Fail the connector step before it prints anything: the other half of "what is on disk now". */
		quiet: boolean;
	};
}

/**
 * The operations the flow drives, recording every call and failing where a test says so.
 *
 * `faux: false` is a provider that wants a key and answers one: the check that screen 2 offers only runs for a provider
 * that can fail, so the fake catalog is handed over with its offline flag turned off.
 */
function fixture(options: { readonly faux?: boolean } = {}): Fixture {
	const calls: string[] = [];
	const break_ = {
		init: false,
		create: false,
		setup: 0,
		verify: false,
		checks: PASSING,
		up: true,
		ready: false,
		podman: true,
		quiet: false,
	};
	const operations: Operations = {
		ready: async () => break_.ready,
		settings: async () => (break_.ready ? { provider: "faux", model: "faux-1" } : undefined),
		hasKey: async () => false,
		providers: async () => ({ ...fauxAccess(), faux: options.faux ?? true }),
		verify: async () => {
			calls.push("verify");
			if (break_.verify) throw new Error("401 Unauthorized: the key was rejected");
			return "ok";
		},
		init: async (args) => {
			calls.push(`init ${args.join(" ")}`);
			return break_.init ? 1 : 0;
		},
		create: async (name) => {
			calls.push(`create ${name}`);
			return break_.create ? 1 : 0;
		},
		setup: async (args) => {
			calls.push(`setup ${args.join(" ")}`);
			if (break_.setup > 0) {
				break_.setup -= 1;
				// The real command writes the grant and then mints the credential before anything starts, so a failure after
				// this line is a failure with something on disk — which is what the failure page has to say. A failure that
				// prints nothing is the other case, and the page has to say the opposite.
				if (!break_.quiet) console.log("[setup] wrote the grant for console");
				return 1;
			}
			return 0;
		},
		doctor: async () => {
			calls.push("doctor");
			return break_.checks;
		},
		chat: async () => {
			calls.push("chat");
			return 0;
		},
		podman: async () =>
			break_.podman
				? ({ ok: true } as const)
				: {
						ok: false as const,
						fix: "podman is not installed (or not on PATH). Install it, and then run `mason setup` again",
					},
		up: async () => break_.up,
	};
	return { calls, operations, break_ };
}

/** An answer, or a queue of them for a question the flow asks more than once. */
type Answer = string | boolean | readonly (string | boolean)[];

/** The answers a quickstart run of a fresh root needs, and nothing more. */
function quickstart(overrides: Readonly<Record<string, Answer>> = {}): Readonly<Record<string, Answer>> {
	return {
		"welcome.mode": "quickstart",
		"provider.id": "faux",
		"provider.model": "faux-1",
		"agent.name": "alice",
		"connector.kind": "console",
		"review.action": "apply",
		"done.action": "finish",
		...overrides,
	};
}

/** One run of the flow against a temporary root, with a scripted terminal and a fake set of operations. */
async function drive(
	script: Readonly<Record<string, Answer>>,
	options: {
		readonly fixture?: Fixture;
		readonly root?: string;
		readonly flags?: { init?: string[]; setup?: string[] };
	} = {},
): Promise<{ code: number; screen: ScriptedScreen; calls: string[]; root: string }> {
	const root = options.root ?? (await tempRoot());
	const screen = new ScriptedScreen(script);
	const fake = options.fixture ?? fixture();
	const code = await runOnboarding({
		root,
		screen,
		operations: fake.operations,
		init: options.flags?.init ?? [],
		setup: options.flags?.setup ?? [],
		handoff: async () => {
			fake.calls.push("handoff");
			return 0;
		},
	});
	return { code, screen, calls: fake.calls, root };
}

describe("the flow", () => {
	test("a quickstart run asks seven screens and installs what they said", async () => {
		const { code, screen, calls } = await drive(quickstart());
		assert.equal(code, 0);
		assert.deepEqual(calls, [
			"init --provider faux --model faux-1",
			"create alice",
			"setup --connector console",
			"doctor",
		]);
		assert.deepEqual(
			screen.locations.map((place) => place.index),
			[1, 2, 3, 4, 5, 6, 7],
		);
		for (const place of screen.locations) assert.equal(place.total, 7);
		assert.deepEqual(
			screen.asked.map((question) => question.id),
			[
				"welcome.checks",
				"welcome.mode",
				"provider.id",
				"provider.model",
				"agent.name",
				"connector.kind",
				"connector.console",
				"review.read",
				"review.action",
				"apply.steps",
				"done.action",
			],
		);
	});

	test("a review too long for the window is a page and a decision, never a decision below the fold", async () => {
		const narrow = new ScriptedScreen(quickstart(), { columns: 70, rows: 20 });
		const root = await tempRoot();
		const fake = fixture();
		const code = await runOnboarding({
			root,
			screen: narrow,
			operations: fake.operations,
			handoff: async () => 0,
		});
		assert.equal(code, 0);
		assert.ok(
			narrow.asked.some((question) => question.id === "review.read"),
			"the plan was a page",
		);
		assert.ok(narrow.pages.some((page) => page.id === "review.read"));
		assert.ok(narrow.asked.some((question) => question.id === "review.action"));
		assert.equal(narrow.asked.find((question) => question.id === "review.action")?.value, undefined);
	});

	test("a connector's own questions become its flags, and an optional one left empty is no flag at all", async () => {
		const { code, calls } = await drive(
			quickstart({
				"connector.kind": "telegram",
				"connector.env.TELEGRAM_BOT_TOKEN": "123:abc",
				"connector.env.TELEGRAM_ALLOWED_CHATS": "@denis",
				"connector.env.HTTPS_PROXY": "",
				"connector.owner": "@denis",
			}),
		);
		assert.equal(code, 0);
		const setup = calls.find((call) => call.startsWith("setup"));
		assert.equal(
			setup,
			"setup --connector telegram --env TELEGRAM_BOT_TOKEN=123:abc --env TELEGRAM_ALLOWED_CHATS=@denis " +
				"--owner @denis --conversations @denis",
			"the token and the chat are flags; the proxy nobody needs is not a flag with an empty value",
		);
	});

	test("an optional question the plan left empty is answered, not refused, when the operation asks it", async () => {
		// The operation asks its own optional questions — no proxy, no conversations of its own — and the plan answered them
		// by not answering. A refusal here is the bug the connector step would fail with on a `--connector telegram` run.
		const prompter = answeredPrompter();
		assert.equal(await prompter.text("HTTPS_PROXY", { fallback: "", required: false }), "");
		assert.equal(await prompter.text("conversations", { required: false }), "", "no fallback is the empty answer");
		await assert.rejects(prompter.text("a token", { required: true }), /bug in the flow/);
	});

	test("the answers become the flags the commands already read", async () => {
		const { calls } = await drive(
			quickstart({
				"connector.kind": "custom",
				"connector.url": "ws://127.0.0.1:8083/api/connector",
				"connector.owner": "@denis",
			}),
		);
		assert.ok(
			calls.includes("setup --connector custom --url ws://127.0.0.1:8083/api/connector --owner @denis"),
			calls.join("\n"),
		);
	});

	test("the completion screen hands the terminal to the conversation when it is chosen", async () => {
		const previous = process.env.MASON_BOT;
		try {
			const { code, calls } = await drive(quickstart({ "done.action": "chat" }));
			assert.equal(code, 0);
			assert.equal(calls[calls.length - 1], "handoff");
			assert.equal(process.env.MASON_BOT, "alice", "the conversation targets the bot this run configured");
		} finally {
			if (previous === undefined) delete process.env.MASON_BOT;
			else process.env.MASON_BOT = previous;
		}
	});

	test("chat is offered only when mason answers, and finish is the way out when it does not", async () => {
		const fake = fixture();
		fake.break_.up = false;
		const { code, screen } = await drive(quickstart({ "done.action": "finish" }), { fixture: fake });
		assert.equal(code, 0);
		const done = screen.asked.find((question) => question.id === "done.action");
		assert.deepEqual(done?.choices, ["finish"]);
	});

	test("a missing dependency is a warning on the first screen, not a surprise at the install", async () => {
		const fake = fixture();
		fake.break_.podman = false;
		const { code, screen } = await drive(quickstart(), { fixture: fake });
		assert.equal(code, 0, "the console needs no container, so the run still finishes");
		const rows = screen.progressRows.get("welcome.checks") ?? [];
		const podman = rows.find((row) => row.label === "podman");
		assert.equal(podman?.state, "warn");
		assert.match(podman?.detail ?? "", /not usable/);
	});

	test("the steps are named in the frame, in order", async () => {
		const { screen } = await drive(quickstart());
		assert.deepEqual(
			screen.locations.map((place) => place.title),
			["Welcome", "Model and provider", "Agent", "Connector", "Review", "Installing", "Done"],
		);
	});
});

describe("navigation", () => {
	test("escape on the first screen writes nothing, and says so with the code for it", async () => {
		const { code, screen, calls } = await drive({ "welcome.mode": CANCEL });
		assert.equal(code, 2);
		assert.deepEqual(calls, []);
		assert.equal(screen.closes, 1);
	});

	test("escape on a later screen goes back instead of cancelling, and the answers survive", async () => {
		// Escape on the connector list is one screen back: the agent screen again, with the answer already on it.
		const { code, screen, calls } = await drive({
			...quickstart(),
			"connector.kind": [CANCEL, "console"],
			"agent.name": ["alice", "alice"],
		});
		assert.equal(code, 0);
		const asked = screen.asked.filter((question) => question.id === "agent.name");
		assert.equal(asked.length, 2);
		assert.equal(asked[1]?.value, "alice", "the second visit is prefilled with the first answer");
		assert.ok(calls.includes("create alice"));
	});

	test("a review can send the plan back to one section, and the plan keeps the rest", async () => {
		const { code, screen, calls } = await drive({
			...quickstart(),
			"review.action": ["agent", "apply"],
			"agent.name": ["alice", "bob"],
		});
		assert.equal(code, 0);
		assert.ok(calls.includes("create bob"), calls.join("\n"));
		const review = screen.asked.filter((question) => question.id === "review.action");
		assert.equal(review.length, 2);
	});

	test("leaving at the review writes nothing", async () => {
		const { code, calls } = await drive({ ...quickstart(), "review.action": "cancel" });
		assert.equal(code, 2);
		assert.deepEqual(calls, []);
	});
});

describe("what the disk already answers", () => {
	test("a store that is already there is reported, not asked about", async () => {
		const fake = fixture();
		fake.break_.ready = true;
		const { code, screen, calls } = await drive(
			{
				"welcome.mode": "quickstart",
				"agent.name": "alice",
				"connector.kind": "console",
				"review.action": "apply",
				"done.action": "finish",
			},
			{ fixture: fake },
		);
		assert.equal(code, 0);
		assert.deepEqual(
			screen.asked.map((question) => question.id),
			[
				"welcome.checks",
				"welcome.mode",
				"provider.already",
				"agent.name",
				"connector.kind",
				"connector.console",
				"review.read",
				"review.action",
				"apply.steps",
				"done.action",
			],
		);
		assert.equal(
			calls.some((call) => call.startsWith("init")),
			false,
			"the store was not written again",
		);
		// The review offers a way back into every section except the one that has nothing to ask: a choice that leads to
		// "nothing to ask" is a dead end wearing a choice's clothes.
		const review = screen.asked.find((question) => question.id === "review.action");
		assert.ok(!(review?.choices ?? []).includes("provider"), "the provider cannot change when the store answers it");
		for (const section of ["apply", "agent", "connector", "cancel"]) assert.ok(review?.choices?.includes(section));
		// And it says what the connector may do, on the screen that asks a person to install it.
		const read = screen.pages.flatMap((entry) => entry.page.lines).join("\n");
		assert.match(read, /may/, "the grant is read back, not only the connector's name");
		assert.match(read, /\/stop/, "including the commands it may send");
	});

	test("flags answer their own questions, and the screens say so", async () => {
		const { code, screen, calls } = await drive(
			{
				"welcome.mode": "quickstart",
				"agent.name": "alice",
				"review.action": "apply",
				"done.action": "finish",
			},
			{
				flags: {
					init: ["--provider", "faux", "--model", "faux-1"],
					setup: ["--connector", "console"],
				},
			},
		);
		assert.equal(code, 0);
		assert.ok(screen.asked.some((question) => question.id === "provider.flags"));
		assert.ok(screen.asked.some((question) => question.id === "connector.flags"));
		assert.ok(!screen.asked.some((question) => question.id === "provider.id"));
		assert.ok(!screen.asked.some((question) => question.id === "connector.kind"));
		assert.ok(calls.includes("init --provider faux --model faux-1"));
		assert.ok(calls.includes("setup --connector console"));
		// And the review offers no way back into a section the flags answered: that route ends on "nothing to ask".
		const review = screen.asked.find((question) => question.id === "review.action");
		assert.ok(
			!(review?.choices ?? []).includes("provider"),
			"a flag answered the provider: the review cannot change it",
		);
		assert.ok(!(review?.choices ?? []).includes("connector"), "and the same for the connector");
	});

	test("a seeded connector the flags only half answered asks for the rest before it installs", async () => {
		// `--connector telegram` names the connector and nothing else: the token and the owner are still owed, and a plan
		// that went straight to the install would fail inside mason setup on a question nobody was shown.
		const { code, screen, calls } = await drive(
			{
				"welcome.mode": "quickstart",
				"provider.id": "faux",
				"provider.model": "faux-1",
				"agent.name": "alice",
				"connector.env.TELEGRAM_BOT_TOKEN": "123:abc",
				"connector.env.TELEGRAM_ALLOWED_CHATS": "@denis",
				"connector.env.HTTPS_PROXY": "",
				"connector.owner": "@denis",
				"review.action": "apply",
				"done.action": "finish",
			},
			{ flags: { setup: ["--connector", "telegram"] } },
		);
		assert.equal(code, 0);
		assert.ok(!screen.asked.some((question) => question.id === "connector.flags"), "half an answer is not an answer");
		assert.ok(!screen.asked.some((question) => question.id === "connector.kind"), "the flag named the kind");
		assert.ok(
			screen.asked.some((question) => question.id === "connector.env.TELEGRAM_BOT_TOKEN"),
			"the token was asked",
		);
		assert.ok(
			screen.asked.some((question) => question.id === "connector.owner"),
			"so was the owner",
		);
		const setup = calls.find((call) => call.startsWith("setup"));
		assert.match(setup ?? "", /^setup --connector telegram --env TELEGRAM_BOT_TOKEN=123:abc/);
		assert.match(setup ?? "", /--owner @denis/);
	});
});

describe("failures", () => {
	test("a provider that does not answer sends the person back to the model, and writes nothing", async () => {
		const fake = fixture({ faux: false });
		fake.break_.verify = true;
		const { code, screen, calls } = await drive(
			{
				...quickstart(),
				"provider.key": "sk-test",
				"provider.check": [true, true, false],
				"provider.model": "faux-1",
				"provider.id": "faux",
			},
			{ fixture: fake },
		);
		assert.equal(code, 0);
		assert.ok(screen.pages.some((page) => page.id === "provider.failed"));
		assert.equal(
			screen.asked.filter((question) => question.id === "provider.model").length,
			3,
			"asked, failed, asked again",
		);
		assert.ok(calls.includes("init --provider faux --model faux-1 --key sk-test"), calls.join("\n"));
	});

	test("a connector step that fails says what is on disk, and the run ends 1", async () => {
		const fake = fixture();
		fake.break_.setup = 9;
		const { code, screen } = await drive(quickstart(), { fixture: fake });
		assert.equal(code, 1);
		const failed = screen.pages.find((page) => page.id === "apply.failed");
		assert.ok(failed, "the failure page was shown");
		const said = failed?.page.lines.join("\n") ?? "";
		assert.ok(said.includes("connector"), said);
		assert.ok(said.includes("mason doctor"), "the recovery is named");
		assert.match(
			said,
			/grant and the credential were written/,
			"what the step left on disk is read off what it printed, not assumed",
		);
		assert.ok(screen.asked.some((question) => question.id === "done.action"));
	});

	test("a connector step that failed before it printed anything says nothing was written", async () => {
		const fake = fixture();
		fake.break_.setup = 9;
		fake.break_.quiet = true;
		const { code, screen } = await drive(quickstart(), { fixture: fake });
		assert.equal(code, 1);
		const said = screen.pages.find((page) => page.id === "apply.failed")?.page.lines.join("\n") ?? "";
		assert.match(said, /Nothing was written/);
		assert.doesNotMatch(said, /grant and the credential were written/, "the page does not claim what it cannot see");
	});

	test("retrying runs the failed step only, and finishes", async () => {
		const fake = fixture();
		fake.break_.setup = 1;
		const { code, calls } = await drive({ ...quickstart(), "apply.steps.key": "r" }, { fixture: fake });
		assert.equal(code, 0, "the retry succeeded");
		assert.equal(calls.filter((call) => call.startsWith("setup")).length, 2);
		assert.equal(calls.filter((call) => call.startsWith("init")).length, 1, "the store was not written twice");
		assert.equal(calls.filter((call) => call === "create alice").length, 1);
	});

	test("a run that failed once and then went through says it went through", async () => {
		const fake = fixture();
		fake.break_.setup = 1;
		// Stop on the failure, read the summary, then go back and apply again: the second apply does the work, and the
		// completion screen is written from what happened last rather than from what happened first.
		const { code, screen } = await drive(
			{ ...quickstart(), "apply.steps.key": "enter", "done.action": [CANCEL, "finish"] },
			{ fixture: fake },
		);
		assert.equal(code, 0, "the retried run finished, so the exit code says it did");
		const read = [
			...(screen.asked.filter((question) => question.id === "done.action").at(-1)?.preface ?? []),
			...screen.pages.filter((entry) => entry.id === "done.read").flatMap((entry) => entry.page.lines),
		].join("\n");
		assert.match(read, /installed/);
		assert.doesNotMatch(read, /failed/, "a failure that was fixed is not the summary");
	});

	test("a check that fails after the install is a failed run with the repair named", async () => {
		const fake = fixture();
		fake.break_.checks = [
			{ name: "server", ok: false, detail: "listening on 8787, /api/health answers for another home" },
			{ name: "connectors", ok: true, detail: "console: granted" },
		];
		const { code, screen } = await drive(quickstart(), { fixture: fake });
		assert.equal(code, 1);
		const done = screen.asked.find((question) => question.id === "done.action");
		assert.deepEqual(done?.choices, ["chat", "finish"], "mason answers, so a conversation is still offered");
		// What the person reads, wherever the summary landed: the check that failed is named, not just counted.
		const read = [
			...(screen.asked.find((question) => question.id === "done.action")?.preface ?? []),
			...screen.pages.filter((entry) => entry.id === "done.read").flatMap((entry) => entry.page.lines),
		].join("\n");
		assert.match(read, /server/, "the failed check is named on the screen, not only counted");
	});
});

describe("what a progress screen may say", () => {
	test("a credential is replaced by a sentence, whatever shape the line has", () => {
		const minted = "masonc_zICsFaJqnnXx9wygQBvHoVcdOmipAYmf7I2ECNNQR7w";
		assert.ok(!redact(minted).includes("masonc_"));
		assert.ok(!redact(`[setup] ${minted}`).includes("masonc_"));
		assert.ok(!redact("a".repeat(64)).includes("aaaaaaaa"));
		assert.equal(redact("this is the only time it is printed."), "");
		assert.equal(redact('[setup] wrote the grant for "console"'), 'wrote the grant for "console"');
	});
});

describe("the name a bot may have", () => {
	test("the root's grammar, and the store is not a bot", () => {
		assert.equal(botNameProblem("alice"), undefined);
		assert.equal(botNameProblem("alice-2"), undefined);
		assert.match(botNameProblem("Alice") ?? "", /lowercase letters/);
		assert.match(botNameProblem("-alice") ?? "", /lowercase letters/);
		assert.match(botNameProblem("common") ?? "", /the store/);
	});

	test("a flag's answers become a plan, and a partial one is not a plan", () => {
		assert.deepEqual(preseed({ init: ["--provider", "faux"], setup: [] }), {}, "half a provider is not an answer");
		const seeded = preseed({ init: ["--provider", "faux", "--model", "faux-1"], setup: [] });
		assert.deepEqual(seeded.provider, { id: "faux", model: "faux-1" });
		const custom = preseed({
			init: [],
			setup: ["--url", "ws://127.0.0.1:9/x", "--owner", "@me", "--no-start"],
		});
		assert.equal(custom.connector?.kind, "custom");
		assert.equal(custom.connector?.owner, "@me");
		assert.equal(custom.connector?.start, false);
		assert.equal(custom.connector?.container, false);
	});
});

describe("the command", () => {
	test("a terminal takes the wizard, and --yes never does", async () => {
		const root = await tempRoot();
		const screen = new ScriptedScreen(quickstart());
		const fake = fixture();
		const code = await runOnboard([], {
			root,
			interactive: true,
			onboarding: { screen, operations: fake.operations, handoff: async () => 0 },
		});
		assert.equal(code, 0);
		assert.ok(screen.asked.length > 0, "the wizard ran");
		assert.ok(fake.calls.includes("create alice"));

		// `--yes` is the promise that a script is never asked anything: it takes the other path, and the wizard's screen
		// is not touched at all.
		const untouched = new ScriptedScreen({});
		const previous = process.env.PI_FAUX_MODEL;
		process.env.PI_FAUX_MODEL = "1";
		try {
			const scripted = await runOnboard(["--yes", "--connector", "console", "-b", "bot"], {
				root: await tempRoot(),
				interactive: true,
				onboarding: { screen: untouched, operations: fake.operations },
			});
			assert.equal(scripted, 0);
			assert.equal(untouched.asked.length, 0, "the wizard asked nothing");
		} finally {
			if (previous === undefined) delete process.env.PI_FAUX_MODEL;
			else process.env.PI_FAUX_MODEL = previous;
		}
	});
});
