/**
 * The onboarding wizard against the real commands: a temporary root, the offline provider, and nothing mocked.
 *
 * `test/onboarding.test.ts` proves the flow — the questions, the navigation, the argv, the failure paths — with the
 * operations faked because those tests are about the flow. This file is the other half of that seam: the same
 * `runOnboarding`, the real `runInit`, `runNew`, `runSetup` and `runDoctor`, and the files they write. What it pins is
 * the promise the wizard makes on its review screen and cannot test about itself: this is what ends up on disk, a second
 * run adds nothing twice, and a soul somebody wrote by hand is never overwritten.
 *
 * `PI_FAUX_MODEL=1` is what makes it a proof rather than a mock: `mason init` still verifies with one real completion,
 * the offline provider answers it, and the wizard's provider screen behaves exactly as it does for a keyed provider.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { runOnboarding } from "../scripts/onboarding.ts";
import { TerminalScreen } from "../src/tui/app.ts";
import { ScriptedScreen } from "../src/tui/screen.ts";
import { plainStyle } from "../src/tui/style.ts";
import { FakeTerminal, screenText } from "./support/terminal.ts";

const roots: string[] = [];
const saved: NodeJS.ProcessEnv = { ...process.env };
after(async () => {
	for (const directory of roots) await rm(directory, { recursive: true, force: true });
	for (const key of ["PI_FAUX_MODEL", "PORT", "PI_PROVIDER", "PI_MODEL", "MASON_HOME", "MASON_BOT"] as const) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

async function tempRoot(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-onboarding-live-"));
	roots.push(directory);
	return directory;
}

/** The environment a first run needs to be offline, silent and invisible: no key, no port, no ambient model. */
function offline(): void {
	process.env.PI_FAUX_MODEL = "1";
	// A port nothing listens on: `doctor` asks, is refused, and reports "mason is not up yet", which is a passing check.
	process.env.PORT = "1";
	delete process.env.PI_PROVIDER;
	delete process.env.PI_MODEL;
	delete process.env.MASON_HOME;
	delete process.env.MASON_BOT;
}

/** One run of the wizard on a fresh root, with the answers a first run needs. */
function script(name: string): ScriptedScreen {
	return new ScriptedScreen({
		"welcome.mode": "quickstart",
		"provider.id": "faux",
		"provider.model": "faux-1",
		"agent.name": name,
		"connector.kind": "console",
		"review.action": "apply",
		"done.action": "finish",
	});
}

const read = (path: string): Promise<string> => readFile(path, "utf8");
const json = async (path: string): Promise<Record<string, unknown>> =>
	JSON.parse(await read(path)) as Record<string, unknown>;

describe("a first run, on disk", () => {
	test("a connector that runs elsewhere is granted, credentialed, and never claimed to be in a compose file", async () => {
		offline();
		const root = await tempRoot();
		const screen = new ScriptedScreen({
			"welcome.mode": "advanced",
			"provider.id": "faux",
			"provider.model": "faux-1",
			"agent.name": "alice",
			"connector.kind": "custom",
			"connector.url": "ws://127.0.0.1:8083/api/connector",
			"connector.owner": "@denis",
			"connector.targets": "@denis",
			"connector.events": "",
			"review.action": "apply",
			"done.action": "finish",
		});
		const code = await runOnboarding({ root, screen });
		assert.equal(code, 0, "the plan's argv is the argv mason setup reads, optional questions included");

		const grant = (await json(join(root, "alice", "service", "integrations.json"))) as {
			integrations: Record<string, { connector?: { user?: { owner?: string } } }>;
		};
		assert.equal(
			grant.integrations.custom?.connector?.user?.owner,
			"@denis",
			"the grant names the owner it was asked for",
		);
		assert.equal(
			existsSync(join(root, "alice", "service", "connectors", "custom")),
			false,
			"no compose project: it runs elsewhere",
		);

		// The credential is minted and printed once; the wizard does not keep it, so the screen that swallowed it has to say
		// where another comes from — and must not claim a compose file that does not exist.
		const read = [
			...(screen.asked.find((question) => question.id === "done.action")?.preface ?? []),
			...screen.pages.flatMap((entry) => entry.page.lines),
		].join("\n");
		assert.match(read, /mason connector add custom --replace/, "where a new credential comes from");
		assert.doesNotMatch(read, /compose/, "no credential went into a compose file");
		assert.doesNotMatch(read, /masonc_/, "nothing printed a credential into the summary");
	});

	test("writes the store, the home and the grant the review promised, and nothing in plaintext", async () => {
		offline();
		const root = await tempRoot();
		const code = await runOnboarding({ root, screen: script("alice") });
		assert.equal(code, 0);

		const home = join(root, "alice");
		for (const path of [
			join(root, "common", "settings.json"),
			join(root, "common", "auth.json"),
			join(root, "common", "runtime.json"),
			join(home, "service", "soul.md"),
			join(home, "service", "integrations.json"),
			join(home, "service", "config.json"),
			// `profile.md` is the agent's own and appears when it first writes it; a home is born with its geometry only.
			join(home, "agent", "workspace"),
			join(home, "service", "data"),
		])
			assert.ok(existsSync(path), `${path} was not written`);

		const settings = await json(join(root, "common", "settings.json"));
		assert.equal(settings.defaultProvider, "faux");
		assert.equal(settings.defaultModel, "faux-1");

		const integrations = await json(join(home, "service", "integrations.json"));
		const entries = integrations.integrations as Record<string, { connector?: { user?: unknown } }>;
		assert.ok(entries.console?.connector !== undefined, "the console connector is granted");

		// The credential is a hash on disk and its plaintext is nowhere: that is the one promise the install record cannot
		// keep on its own.
		const config = await read(join(home, "service", "config.json"));
		assert.ok(!config.includes("masonc_"), "a plaintext credential reached the file");
	});

	test("a second run adds nothing twice, asks nothing about the provider, and keeps a soul by hand", async () => {
		offline();
		const root = await tempRoot();
		assert.equal(await runOnboarding({ root, screen: script("alice") }), 0);
		const home = join(root, "alice");
		const soul = join(home, "service", "soul.md");
		const config = await read(join(home, "service", "config.json"));
		await writeFile(soul, "# the soul this person wrote\n\nBe brief.\n", "utf8");

		const second = new ScriptedScreen({
			"welcome.mode": "quickstart",
			"agent.name": "alice",
			"connector.kind": "console",
			"review.action": "apply",
			"done.action": "finish",
		});
		assert.equal(await runOnboarding({ root, screen: second }), 0);
		assert.equal(await read(soul), "# the soul this person wrote\n\nBe brief.\n", "a hand-written soul was kept");
		assert.equal(await read(join(home, "service", "config.json")), config, "no second credential was minted");
		assert.ok(
			second.asked.some((question) => question.id === "provider.already"),
			"the store was reported, not asked about",
		);
		assert.ok(!second.asked.some((question) => question.id === "provider.id"));
		// The run continues a root that already holds one bot: its name and its grant are what the screens start from, so a
		// person who presses enter three times finishes this run rather than installing a second home beside the first.
		assert.equal(
			second.asked.find((question) => question.id === "agent.name")?.value,
			"alice",
			"the name comes from the root, not from the login",
		);
		assert.equal(
			second.asked.find((question) => question.id === "connector.kind")?.value,
			"console",
			"so does the grant",
		);
	});

	test("an advanced run writes the same files, with the questions it adds", async () => {
		offline();
		const root = await tempRoot();
		const screen = new ScriptedScreen({
			"welcome.mode": "advanced",
			"provider.id": "faux",
			"provider.model": "faux-1",
			"agent.name": "alice",
			"agent.home": "",
			"connector.kind": "console",
			"review.action": "apply",
			"done.action": "finish",
		});
		assert.equal(await runOnboarding({ root, screen }), 0);
		assert.ok(
			screen.asked.some((question) => question.id === "agent.home"),
			"advanced explains the home",
		);
		assert.ok(existsSync(join(root, "alice", "service", "integrations.json")));
	});
});

describe("a first run on a terminal", () => {
	/**
	 * The whole wizard, driven the way a person drives it: real screens, real keys, the real commands behind them.
	 *
	 * The only thing that is not real is the terminal object, and it is the one component of this that a test should not
	 * have to own: the application's writes go into it and the keys come out of it, in the same order a pty would deliver
	 * them. What the assertions read is the reconstructed screen, which is what a person would have seen.
	 */
	test("goes from the first screen to the last, and ends in a conversation it can offer", async () => {
		offline();
		const root = await tempRoot();
		const terminal = new FakeTerminal({ columns: 100, rows: 30 });
		const screen = new TerminalScreen({ terminal, paint: plainStyle.paint, glyphs: plainStyle.glyphs });
		const seen: string[] = [];
		const shown = (): string => screenText(terminal.writes, { columns: 100, rows: 30 }).join("\n");
		/**
		 * Wait for the screen a person would be looking at, then answer it: one token per keypress, because an escape
		 * sequence is one keypress and a terminal delivers it as one chunk.
		 */
		const at = async (needle: string, keys: readonly string[]): Promise<void> => {
			for (let attempt = 0; attempt < 400; attempt += 1) {
				if (shown().includes(needle)) {
					seen.push(needle);
					for (const key of keys) terminal.type(key);
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error(`the screen never showed "${needle}"; it showed:\n${shown()}`);
		};
		const ENTER = "\r";
		const running = runOnboarding({
			root,
			screen,
			handoff: async () => 0,
		});
		await at("How would you like to start?", [ENTER]);
		await at("Which provider?", [ENTER]);
		await at("Which model?", [ENTER]);
		await at("What should this agent be called?", ["\x15", "a", "l", "i", "c", "e", ENTER]);
		await at("How will you talk to it?", ["\x1b[B", ENTER]);
		await at("The console connector", [ENTER]);
		await at("The plan", [ENTER]);
		await at("Apply this plan?", [ENTER]);
		await at("What next?", [ENTER]);
		assert.equal(await running, 0);
		assert.deepEqual(seen, [
			"How would you like to start?",
			"Which provider?",
			"Which model?",
			"What should this agent be called?",
			"How will you talk to it?",
			"The console connector",
			"The plan",
			"Apply this plan?",
			"What next?",
		]);
		assert.ok(existsSync(join(root, "alice", "service", "integrations.json")));
		assert.ok(
			!terminal.writes.join("").includes("masonc_"),
			"the credential was printed to a screen nobody can scroll",
		);
	});
});
