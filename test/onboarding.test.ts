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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { consoleGrant } from "../scripts/chat.ts";
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

/**
 * A catalog with one provider id, offline: the faux provider's models under the name the journey table either knows or
 * does not. The flow only reads the two lists off it, so where the models came from does not matter here.
 */
function catalogFor(id: string): Awaited<ReturnType<Operations["providers"]>> {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);
	const models = createModels();
	models.setProvider({ ...faux.provider, id, name: id });
	return { models, faux: false };
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
		/** How many checks the provider refuses before it answers: one is a key that has to be retyped. */
		verify: number;
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
function fixture(options: { readonly faux?: boolean; readonly catalog?: string } = {}): Fixture {
	const calls: string[] = [];
	const break_ = {
		init: false,
		create: false,
		setup: 0,
		verify: 0,
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
		providers: async () =>
			options.catalog === undefined ? { ...fauxAccess(), faux: options.faux ?? true } : catalogFor(options.catalog),
		verify: async () => {
			calls.push("verify");
			if (break_.verify > 0) {
				break_.verify -= 1;
				throw new Error("401 Unauthorized: the key was rejected");
			}
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
		"connectors.list": "continue",
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
				"connectors.list",
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

	test("an optional question the plan left empty is answered, not refused, when the operation asks it", async () => {
		// The operation asks its own optional questions — a proxy nobody needs, no targets of its own — and the plan
		// answered them by not answering. A refusal here is the bug the connector step would fail without a screen.
		const prompter = answeredPrompter();
		assert.equal(await prompter.text("SOME_OPTIONAL", { fallback: "", required: false }), "");
		assert.equal(await prompter.text("targets", { required: false }), "", "no fallback is the empty answer");
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
			["Welcome", "Model and provider", "Agent", "Connectors", "Review", "Installing", "Done"],
		);
	});
});

describe("the connectors page", () => {
	test("an advanced run that adds two installs both, in the order they were added", async () => {
		const { code, screen, calls } = await drive({
			"welcome.mode": "advanced",
			"provider.id": "faux",
			"provider.model": "faux-1",
			"agent.name": "alice",
			"connector.kind": ["console", "custom"],
			"connector.url": "ws://127.0.0.1:8083/api/connector",
			"connector.owner": "@denis",
			"connector.targets": "@denis",
			"connector.events": "",
			"connectors.list": ["add", "continue"],
			"review.action": "apply",
			"done.action": "finish",
		});
		assert.equal(code, 0);
		// One `mason setup` per connector, in the order the page listed them: `writeIntegration` merges by name and
		// `connector add` mints one credential per entry, so the two entries follow from these two calls.
		assert.deepEqual(
			calls.filter((call) => call.startsWith("setup")),
			[
				"setup --connector console",
				"setup --connector custom --url ws://127.0.0.1:8083/api/connector --owner @denis --targets @denis",
			],
		);
		// The review is where a person reads the plan back: one block per connector, each naming what it may send.
		const read = [
			...(screen.asked.find((question) => question.id === "review.action")?.preface ?? []),
			...screen.pages.filter((page) => page.id === "review.read").flatMap((page) => page.page.lines),
		].join("\n");
		assert.match(read, /Connector 1/);
		assert.match(read, /Connector 2/);
		assert.match(read, /console/);
		assert.match(read, /custom/);
		assert.match(read, /\/stop/, "each block says what that connector may send");
		// And the progress list is one row per connector, both done.
		const rows = screen.progressRows.get("apply.steps") ?? [];
		assert.deepEqual(
			rows
				.filter((row) => row.label.includes("console") || row.label.includes("custom"))
				.map((row) => `${row.label}: ${row.state}`),
			["console: credential: ok", "custom: credential: ok"],
		);
	});

	test("a repeated --connector pre-seeds both, and the screen asks nothing about either", async () => {
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
					setup: [
						"--connector",
						"custom",
						"--url",
						"ws://127.0.0.1:8083/api/connector",
						"--owner",
						"@denis",
						"--connector",
						"console",
					],
				},
			},
		);
		assert.equal(code, 0);
		assert.ok(screen.asked.some((question) => question.id === "connector.flags"));
		for (const id of ["connector.kind", "connector.owner", "connectors.list"])
			assert.ok(!screen.asked.some((question) => question.id === id), `nothing asked ${id}: a flag answered it`);
		assert.equal(calls.filter((call) => call.startsWith("setup")).length, 2, "both were installed, and nobody asked");
	});

	test("a connector dropped on the page is left out of the install", async () => {
		const { code, calls } = await drive({
			...quickstart(),
			"connector.kind": ["console", "custom"],
			"connector.url": "ws://127.0.0.1:8083/api/connector",
			"connector.owner": "@denis",
			"connector.targets": "@denis",
			"connector.events": "",
			"connectors.list": ["add", "remove:0", "continue"],
		});
		assert.equal(code, 0);
		const setup = calls.filter((call) => call.startsWith("setup"));
		assert.deepEqual(setup.length, 1, "the console was dropped before anything was written");
		assert.match(setup[0] ?? "", /^setup --connector custom --url/);
	});

	test("dropping the last one asks for a connector again, rather than installing nothing", async () => {
		const { code, screen, calls } = await drive({
			...quickstart(),
			"connector.kind": ["console", "console"],
			"connectors.list": ["remove:0", "continue"],
		});
		assert.equal(code, 0);
		assert.equal(
			screen.asked.filter((question) => question.id === "connector.kind").length,
			2,
			"the page with no row on it is the question that fills it",
		);
		assert.equal(calls.filter((call) => call.startsWith("setup")).length, 1);
	});

	test("the key question names the console that mints it, and only when this build knows one", async () => {
		const known = fixture({ faux: false, catalog: "anthropic" });
		const asked = await drive(
			quickstart({ "provider.id": "anthropic", "provider.key": "sk-test", "provider.check": false }),
			{ fixture: known },
		);
		assert.equal(asked.code, 0);
		assert.equal(
			asked.screen.asked.find((question) => question.id === "provider.key")?.journey?.url,
			"https://console.anthropic.com/settings/keys",
		);

		const unknown = fixture({ faux: false, catalog: "a-provider-this-table-has-never-seen" });
		const quiet = await drive(
			quickstart({
				"provider.id": "a-provider-this-table-has-never-seen",
				"provider.key": "sk-test",
				"provider.check": false,
			}),
			{ fixture: unknown },
		);
		assert.equal(quiet.code, 0);
		assert.equal(
			quiet.screen.asked.find((question) => question.id === "provider.key")?.journey,
			undefined,
			"a provider with no row gets no line: the wizard does not invent an address",
		);
	});

	test("the page lists what this run installs, with the state of each row", async () => {
		const { screen } = await drive(quickstart());
		const read = (screen.asked.find((question) => question.id === "connectors.list")?.preface ?? []).join("\n");
		assert.match(read, /This run installs/, "one row per connector this run will write");
		assert.match(read, /console/);
		assert.match(read, /written/);
	});

	test("a connector already on disk is reported as installed, and is not removable here", async () => {
		// A home from an earlier run: its grant is the answer it already gave, so the page reports it and writes nothing.
		// Removing an integration is `mason integration remove`, not a row on a wizard that has written nothing yet.
		const root = await tempRoot();
		await mkdir(join(root, "alice", "service"), { recursive: true });
		await writeFile(
			join(root, "alice", "service", "integrations.json"),
			JSON.stringify({ version: "0.1", integrations: { console: { enabled: true, connector: consoleGrant() } } }),
			"utf8",
		);
		const { code, screen, calls } = await drive(
			{
				"welcome.mode": "quickstart",
				"provider.id": "faux",
				"provider.model": "faux-1",
				"agent.name": "alice",
				"connectors.list": "continue",
				"review.action": "apply",
				"done.action": "finish",
			},
			{ root },
		);
		assert.equal(code, 0);
		assert.ok(!screen.asked.some((question) => question.id === "connector.kind"), "nothing asked which one to add");
		assert.ok(!calls.some((call) => call.startsWith("setup")), "nothing was installed twice");
		const page = screen.asked.find((question) => question.id === "connectors.list");
		const read = (page?.preface ?? []).join("\n");
		assert.match(read, /Already installed/);
		assert.match(read, /not removed from here/, "an entry on disk is not this page's to drop");
		assert.deepEqual(
			(page?.choices ?? []).filter((choice) => choice.startsWith("remove")),
			[],
			"and it is offered no row that would remove it",
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
				"connectors.list": "continue",
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
				"connectors.list",
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
		// `--connector custom` names the connector and nothing else: the url and the owner are still owed, and a plan
		// that went straight to the install would fail inside mason setup on a question nobody was shown.
		const { code, screen, calls } = await drive(
			{
				"welcome.mode": "quickstart",
				"provider.id": "faux",
				"provider.model": "faux-1",
				"agent.name": "alice",
				"connector.url": "ws://127.0.0.1:8083/api/connector",
				"connector.owner": "@denis",
				"connectors.list": "continue",
				"review.action": "apply",
				"done.action": "finish",
			},
			{ flags: { setup: ["--connector", "custom"] } },
		);
		assert.equal(code, 0);
		assert.ok(!screen.asked.some((question) => question.id === "connector.flags"), "half an answer is not an answer");
		assert.ok(!screen.asked.some((question) => question.id === "connector.kind"), "the flag named the kind");
		assert.ok(
			screen.asked.some((question) => question.id === "connector.url"),
			"the url was asked",
		);
		assert.ok(
			screen.asked.some((question) => question.id === "connector.owner"),
			"so was the owner",
		);
		const setup = calls.find((call) => call.startsWith("setup"));
		assert.equal(setup, "setup --connector custom --url ws://127.0.0.1:8083/api/connector --owner @denis");
	});

	test("a flag that names a connector this build does not ship is a picker, not a lost run", async () => {
		const { code, screen } = await drive(quickstart({ "connector.kind": "console" }), {
			flags: { setup: ["--connector", "nope"] },
		});
		assert.equal(code, 0, "the run survives the typo and installs what the next screen says");
		assert.ok(
			screen.pages.some((page) => page.id === "connector.unknown"),
			"the typo was named",
		);
		assert.ok(
			screen.asked.some((question) => question.id === "connector.kind"),
			"and the list was shown",
		);
	});

	test("a connector the flags half answered is still a step the review can go back into", async () => {
		// Escape at the review returns to the connectors page with what was typed kept, and the review keeps its way back:
		// a half-seeded plan is not "answered on the command line", whatever the flag said.
		const { code, screen } = await drive(
			quickstart({
				"connector.url": "ws://127.0.0.1:8083/api/connector",
				"connector.owner": "@denis",
				"connectors.list": ["continue", "continue"],
				"review.action": [CANCEL, "apply"],
			}),
			{ flags: { setup: ["--connector", "custom"] } },
		);
		assert.equal(code, 0);
		assert.ok(
			!screen.asked.some((question) => question.id === "connector.flags"),
			"nothing claims the flags answered it",
		);
		const urls = screen.asked.filter((question) => question.id === "connector.url");
		assert.equal(urls.length, 1, "the answers given once are the plan's: a re-entry does not ask them again");
		assert.equal(
			screen.asked.filter((question) => question.id === "connectors.list").length,
			2,
			"escape at the review landed on the page again",
		);
		assert.ok(
			!screen.asked.some((question) => question.id === "connector.kind"),
			"the flag named the kind: not asked again",
		);
		const review = screen.asked.filter((question) => question.id === "review.action").at(-1);
		assert.ok(review?.choices?.includes("connector"), "the review can go back into a step it asked itself");
	});

	test("an events pair that is not kind=hook is refused on its own screen, not as a lost run", async () => {
		const { code, screen } = await drive(
			quickstart({
				"welcome.mode": "advanced",
				"connector.kind": "custom",
				"connector.url": "ws://127.0.0.1:8083/api/connector",
				"connector.owner": "@denis",
				"connector.targets": "",
				"connector.events": ["stop", "wake=retry"],
			}),
		);
		assert.equal(code, 0, "the typo was corrected where it was typed");
		assert.equal(
			screen.asked.filter((question) => question.id === "connector.events").length,
			2,
			"refused once, answered once",
		);
		const read = [
			...(screen.asked.find((question) => question.id === "connector.events")?.preface ?? []),
			...screen.pages.flatMap((entry) => entry.page.lines),
		];
		assert.ok(!read.join("\n").includes("--events"), "a screen does not name a flag the person never typed");
	});
});

describe("failures", () => {
	test("a provider that does not answer sends the person back to the model, and writes nothing", async () => {
		const fake = fixture({ faux: false });
		fake.break_.verify = 1;
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
			2,
			"asked, failed, asked again",
		);
		assert.ok(calls.includes("init --provider faux --model faux-1 --key sk-test"), calls.join("\n"));
	});

	test("a key the provider refused is asked for again, not reused", async () => {
		const fake = fixture({ faux: false });
		fake.break_.verify = 1;
		const { code, screen, calls } = await drive(
			{
				...quickstart(),
				"provider.key": ["sk-bad", "sk-good"],
				"provider.check": true,
			},
			{ fixture: fake },
		);
		assert.equal(code, 0);
		assert.equal(
			screen.asked.filter((question) => question.id === "provider.key").length,
			2,
			"a key the provider refused is not an answer to the question about the key",
		);
		assert.ok(calls.includes("init --provider faux --model faux-1 --key sk-good"), calls.join("\n"));
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
		}) as { connectors?: readonly Record<string, unknown>[] };
		assert.equal(custom.connectors?.[0]?.kind, "custom");
		assert.equal(custom.connectors?.[0]?.owner, "@me");
		assert.equal(custom.connectors?.[0]?.start, false);
		assert.equal(custom.connectors?.[0]?.container, false);
	});

	test("a repeated --connector is a second connector, with the flags that follow it", () => {
		// Criterion 5 of #159: one headless run installs both, and the `--owner` written after the first connector belongs
		// to it and not to the second one.
		const seeded = preseed({
			init: [],
			setup: [
				"--connector",
				"custom",
				"--url",
				"ws://127.0.0.1:8083/api/connector",
				"--owner",
				"@denis",
				"--connector",
				"console",
			],
		});
		assert.deepEqual(
			seeded.connectors?.map((plan) => plan.kind),
			["custom", "console"],
		);
		assert.equal(seeded.connectors?.[0]?.owner, "@denis");
		assert.equal(seeded.connectors?.[1]?.owner, undefined, "the second connector took none of the first one's flags");
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
		const port = process.env.PORT;
		process.env.PI_FAUX_MODEL = "1";
		// A port nothing listens on, for the same reason every child process in this repo gets one: `doctor` asks 8787, and
		// a mason running on this machine would answer it and be reported as another home's server.
		process.env.PORT = "1";
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
			if (port === undefined) delete process.env.PORT;
			else process.env.PORT = port;
		}
	});
});
