/**
 * `scripts/setup.ts` — the first run, driven the way CI drives it.
 *
 * Every command here is spawned exactly as a person or a Dockerfile would run it, against a temporary `MASON_HOME`, with
 * no TTY: that is the promise the wizard makes (a thin shell over functions that take answers), and a test that called
 * `runSetup` in-process would prove the functions and not the flags. What is pinned is the whole outcome of a first run —
 * the entry, the grant, the credential *hash*, the install record — plus the two promises that make a second run safe:
 * an existing connector is not touched, and running it again mints nothing and rewrites nothing.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readComposeCredential } from "../src/server/connector-compose.ts";
import {
	listConnectorCredentials,
	mintConnectorCredential,
	revokeConnectorCredential,
} from "../src/server/connectors.ts";
import { housePaths } from "../src/server/house.ts";

import { readInstalls, writeInstall } from "../src/server/install-state.ts";
import { readIntegrations } from "../src/server/integrations.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "setup.ts");

const homes: string[] = [];
after(async () => {
	for (const home of homes) await rm(home, { recursive: true, force: true });
});

async function tempHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "mason-setup-"));
	homes.push(home);
	return home;
}

/** Run `mason setup …` against one temporary home. A non-zero exit is a result, not an error. */
async function setup(args: readonly string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await run(process.execPath, ["--experimental-strip-types", script, ...args], {
			cwd: root,
			// `HOST` is pinned: setup reads it to decide whether a container could reach mason, and a machine where the
			// documented `HOST=0.0.0.0` is exported would turn this refusal into a real `podman compose up -d`.
			env: { ...process.env, MASON_HOME: home, HOST: "127.0.0.1" },
			maxBuffer: 8 * 1024 * 1024,
		});
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

describe("a first run with the console connector", () => {
	test("writes the entry, the grant, the credential hash and the install record, and starts nothing", async () => {
		const home = await tempHome();
		const result = await setup(["--connector", "console", "--yes", "--no-start"], home);
		assert.equal(result.code, 0, result.stderr || result.stdout);

		const paths = housePaths(home);
		const { integrations } = await readIntegrations(paths);
		assert.equal(integrations.console?.enabled, true);
		assert.deepEqual(integrations.console?.connector?.user, { owner: "local" });
		assert.deepEqual(integrations.console?.connector?.targets, [
			{ id: "terminal", label: "the terminal this bot runs in", capabilities: ["text", "markdown"] },
		]);
		assert.deepEqual(integrations.console?.connector?.commands, ["stop", "compact", "clear", "status"]);

		// The token is printed once and stored as a hash: the file must not hold the credential itself.
		const issued = await listConnectorCredentials(paths.home);
		assert.equal(issued.length, 1);
		assert.equal(issued[0]?.connector, "console");
		const printed = result.stdout.match(/masonc_[A-Za-z0-9_-]+/g) ?? [];
		assert.equal(printed.length, 1, "the credential is printed exactly once");
		assert.doesNotMatch(await readFile(paths.config, "utf8"), new RegExp(printed[0] ?? "never-matches"));

		// The console runs in this terminal, so setup records it and starts nothing: no compose file, no project.
		const { connectors } = await readInstalls(paths);
		const record = connectors.console;
		assert.equal(record?.started, false);
		assert.equal(record?.project, undefined, "nothing to start means nothing to name");
		assert.match(record?.source ?? "", /^url:ws:\/\/127\.0\.0\.1:\d+\/api\/connector$/);
	});

	test("a home that already holds a granted connector keeps it exactly as it was", async () => {
		const home = await tempHome();
		const paths = housePaths(home);
		// A connector an operator granted by hand, with the keys mason does not read: they have to survive a write that
		// was about a different connector.
		const telegram = {
			enabled: true,
			description: "my own line",
			mcp: { url: "http://127.0.0.1:8082/mcp", note: "a key mason has never heard of" },
			connector: {
				user: { owner: "8811" },
				targets: [{ id: "8811", label: "the DM with Denis", capabilities: ["text"] }],
			},
		};
		await mkdir(paths.serviceDir, { recursive: true, mode: 0o700 });
		await writeFile(paths.integrations, JSON.stringify({ integrations: { telegram } }));
		const before = await readFile(paths.integrations, "utf8");

		const result = await setup(["--connector", "console", "--yes", "--no-start"], home);
		assert.equal(result.code, 0, result.stderr || result.stdout);
		const { integrations } = await readIntegrations(paths);
		assert.deepEqual(integrations.telegram, telegram, "the other connector is not rewritten");
		assert.notEqual(await readFile(paths.integrations, "utf8"), before, "and the new one is added beside it");
		assert.ok(integrations.console?.connector !== undefined);
	});

	test("a second run mints nothing and rewrites nothing", async () => {
		const home = await tempHome();
		const first = await setup(["--connector", "console", "--yes", "--no-start"], home);
		assert.equal(first.code, 0, first.stderr);
		const paths = housePaths(home);
		const grant = await readFile(paths.integrations, "utf8");
		const records = await readFile(paths.connectors, "utf8");

		const second = await setup(["--connector", "console", "--yes", "--no-start"], home);
		assert.equal(second.code, 0, second.stderr);
		assert.match(second.stdout, /already granted/);
		assert.match(second.stdout, /already has connector credential/);
		assert.equal((second.stdout.match(/masonc_/g) ?? []).length, 0, "no second credential is printed");
		assert.equal((await listConnectorCredentials(paths.home)).length, 1, "and none is minted");
		assert.equal(await readFile(paths.integrations, "utf8"), grant);
		assert.equal(await readFile(paths.connectors, "utf8"), records, "the record's createdAt is the first run's");
	});
});

describe("a start that cannot happen", () => {
	test("records what it wrote, and names the change instead of a stack trace", async () => {
		const home = await tempHome();
		// mason is bound to loopback by default, and a container cannot reach it: setup refuses before starting anything,
		// and the record says the files are there and the container is not.
		const result = await setup(
			[
				"--connector",
				"telegram",
				"--env",
				"TELEGRAM_BOT_TOKEN=123:fake",
				"--env",
				"TELEGRAM_ALLOWED_CHATS=8811",
				"--owner",
				"8811",
				"--yes",
			],
			home,
		);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /HOST=0\.0\.0\.0 mason up/);
		const paths = housePaths(home);
		assert.equal((await readInstalls(paths)).connectors.telegram?.started, false);
		// The files that make the second attempt cheap are all there, including the project setup rendered.
		assert.match(await readFile(join(paths.connectorsDir, "telegram", "compose.yaml"), "utf8"), /restart: always/);
	});
});

describe("the credential a container is given", () => {
	/** The value the rendered project hands the container, unescaped, as the container would read it. */
	async function composeCredential(home: string): Promise<string | undefined> {
		const paths = housePaths(home);
		return readComposeCredential(join(paths.connectorsDir, "telegram", "compose.yaml"));
	}

	/** The hash mason holds, so the value in the file can be checked against what the server would accept. */
	function sha256(value: string): string {
		return createHash("sha256").update(value, "utf8").digest("hex");
	}

	const answers = [
		"--connector",
		"telegram",
		"--env",
		"TELEGRAM_BOT_TOKEN=123:fake",
		"--env",
		"TELEGRAM_ALLOWED_CHATS=8811",
		"--owner",
		"8811",
		"--yes",
		"--no-start",
	];

	test("is one mason accepts: the file's value hashes to the record that was minted", async () => {
		const home = await tempHome();
		const result = await setup(answers, home);
		assert.equal(result.code, 0, result.stderr);
		const value = await composeCredential(home);
		assert.equal(typeof value, "string");
		const records = await listConnectorCredentials(housePaths(home).home);
		assert.deepEqual(
			records.filter((record) => record.connector === "telegram").map((record) => record.sha256),
			[sha256(value ?? "")],
		);
	});

	test("a --no-start run does not report a running container as stopped", async () => {
		const home = await tempHome();
		assert.equal((await setup(answers, home)).code, 0);
		// A home that was started once, then asked to write without starting: the record says it is up because it is.
		const paths = housePaths(home);
		const record = (await readInstalls(paths)).connectors.telegram;
		assert.ok(record !== undefined);
		await writeInstall(paths, "telegram", { ...record, started: true });
		assert.equal((await setup(answers, home)).code, 0);
		assert.equal((await readInstalls(paths)).connectors.telegram?.started, true);
	});

	test("is replaced when it was rotated elsewhere, which is the one case a file can lie about", async () => {
		// `mason connector add <name> --replace` is a rotation mas on does not perform, so the file's line survives it:
		// only the hash says whether the plaintext in the project is still the credential this home holds.
		const home = await tempHome();
		assert.equal((await setup(answers, home)).code, 0);
		const paths = housePaths(home);
		const before = await composeCredential(home);
		await mintConnectorCredential(paths.home, "telegram", { replace: true });
		assert.equal((await setup(answers, home)).code, 0);
		const after = await composeCredential(home);
		assert.notEqual(after, before, "a plaintext whose hash is gone is not reused");
		const live = (await listConnectorCredentials(paths.home)).filter((record) => record.connector === "telegram");
		assert.deepEqual(
			live.map((record) => record.sha256),
			[sha256(after ?? "")],
			"and the project matches what is live",
		);
	});

	test("is replaced when the home no longer holds it, so a revoke is not a container that crash-loops", async () => {
		const home = await tempHome();
		assert.equal((await setup(answers, home)).code, 0);
		const paths = housePaths(home);
		const before = await composeCredential(home);
		for (const record of await listConnectorCredentials(paths.home))
			await revokeConnectorCredential(paths.home, record.id);
		assert.equal((await setup(answers, home)).code, 0);
		const after = await composeCredential(home);
		assert.notEqual(after, before, "a credential nobody holds any more is not reused");
		const live = (await listConnectorCredentials(paths.home)).filter((record) => record.connector === "telegram");
		assert.deepEqual(
			live.map((record) => record.sha256),
			[sha256(after ?? "")],
			"and exactly one is live",
		);
	});
});

describe("a connector that is already running somewhere else", () => {
	test("--connector custom --url writes a grant with an owner and no image", async () => {
		const home = await tempHome();
		const url = "ws://127.0.0.1:9999/api/connector";
		const result = await setup(
			["--connector", "custom", "--url", url, "--owner", "denis", "--yes", "--no-start"],
			home,
		);
		assert.equal(result.code, 0, result.stderr || result.stdout);
		const paths = housePaths(home);
		const { integrations } = await readIntegrations(paths);
		const grant = integrations.custom?.connector;
		assert.equal(grant?.user?.owner, "denis");
		// The one place this home knows about is the owner's, and the command says the list may need editing.
		assert.deepEqual(grant?.targets, [{ id: "denis", label: "denis", capabilities: ["text", "markdown"] }]);
		assert.deepEqual(grant?.commands, ["stop", "compact", "clear", "status"]);
		assert.match(result.stdout, /--targets <ids>/);

		const record = (await readInstalls(paths)).connectors.custom;
		assert.equal(record?.source, `url:${url}`);
		assert.equal(record?.image, undefined, "nothing is pulled for a connector mason does not run");
		assert.equal(record?.started, false);
	});

	test("--conversations and --events are written through the grant writer, with no hand-written JSON", async () => {
		const home = await tempHome();
		// The hooks a grant may fire are the ones the boot defines: the retry hook, plus the routines the agent owns. A
		// grant that names a hook nobody defines is refused before anything is written (the next test), so this one writes
		// the routines first, the way a person would.
		await mkdir(join(home, "agent"), { recursive: true });
		await writeFile(
			join(home, "agent", "routines.json"),
			JSON.stringify([
				{ name: "check-mail", intervalSeconds: 600, prompt: "Read the mail." },
				{ name: "check-calendar", intervalSeconds: 600, prompt: "Read the calendar." },
			]),
		);
		const url = "ws://127.0.0.1:9999/api/connector";
		const result = await setup(
			[
				"--connector",
				"custom",
				"--url",
				url,
				"--owner",
				"denis",
				"--conversations",
				"denis,-100200",
				"--events",
				"mail=check-mail, calendar=check-calendar",
				"--yes",
				"--no-start",
			],
			home,
		);
		assert.equal(result.code, 0, result.stderr || result.stdout);
		const paths = housePaths(home);
		const { integrations } = await readIntegrations(paths);
		const grant = integrations.custom?.connector;
		// One target per chat the connector asked for, with the chat id as its label.
		assert.deepEqual(
			grant?.targets?.map((target) => [target.id, target.label]),
			[
				["denis", "denis"],
				["100200", "-100200"],
			],
		);
		assert.deepEqual(grant?.events?.hooks, { mail: "check-mail", calendar: "check-calendar" });
		// The file the boot reads is the one the wizard wrote: a hand edit is still valid input, and this one needed none.
		const raw = JSON.parse(await readFile(paths.integrations, "utf8")) as { version?: string };
		assert.equal(raw.version, "0.1");
	});

	test("an event pair that is not kind=hook is refused before anything is written", async () => {
		const home = await tempHome();
		const result = await setup(
			[
				"--connector",
				"custom",
				"--url",
				"ws://127.0.0.1:9999/api/connector",
				"--owner",
				"denis",
				"--events",
				"mail",
				"--yes",
			],
			home,
		);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /"mail" is not kind=hook/);
		const paths = housePaths(home);
		assert.equal(await readFile(paths.integrations, "utf8").catch(() => undefined), undefined);
	});

	test("a url that is not a socket is refused before anything is written", async () => {
		const home = await tempHome();
		const result = await setup(
			["--connector", "custom", "--url", "http://127.0.0.1:9999", "--owner", "denis", "--yes", "--no-start"],
			home,
		);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /not a WebSocket URL/);
		const paths = housePaths(home);
		assert.equal(await readFile(paths.integrations, "utf8").catch(() => undefined), undefined);
	});
});

describe("a headless run that cannot answer", () => {
	test("refuses with the flag to pass, and writes nothing", async () => {
		const home = await tempHome();
		// No --connector and no terminal: the list cannot be picked, and a default would be a guess about which bot.
		const result = await setup(["--yes", "--no-start"], home);
		assert.equal(result.code, 2, "a missing answer is not a failed install");
		assert.match(result.stderr, /pass --connector <name>/);

		const custom = await setup(
			["--connector", "custom", "--url", "ws://127.0.0.1:9999/x", "--yes", "--no-start"],
			home,
		);
		assert.equal(custom.code, 2);
		assert.match(custom.stderr, /who owns this chat\?.*--owner/s);
	});

	test("says what it does not know how to install yet", async () => {
		const home = await tempHome();
		const result = await setup(["--connector", "npm-slack", "--yes", "--no-start"], home);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /there is no connector "npm-slack"/);
	});
});
