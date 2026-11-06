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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { listConnectorCredentials } from "../src/server/connectors.ts";
import { housePaths } from "../src/server/house.ts";
import { readInstalls } from "../src/server/install-state.ts";
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
			env: { ...process.env, MASON_HOME: home },
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
		assert.deepEqual(integrations.console?.connector?.user, {
			owner: "local",
			conversations: [{ externalConversationId: "terminal", kind: "person" }],
		});
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
			tools: { url: "http://127.0.0.1:8082/mcp", note: "a key mason has never heard of" },
			connector: { user: { owner: "8811", conversations: [{ externalConversationId: "8811", kind: "person" }] } },
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
			["--connector", "telegram", "--env", "TELEGRAM_BOT_TOKEN=123:fake", "--env", "TELEGRAM_ALLOWED_CHATS=8811", "--owner", "8811", "--yes"],
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
		// The one conversation this home knows about is the owner's, and the command says the list may need editing.
		assert.deepEqual(grant?.user?.conversations, [{ externalConversationId: "denis", kind: "person" }]);
		assert.deepEqual(grant?.commands, ["stop", "compact", "clear", "status"]);
		assert.match(result.stdout, /edit connector\.user\.conversations/);

		const record = (await readInstalls(paths)).connectors.custom;
		assert.equal(record?.source, `url:${url}`);
		assert.equal(record?.image, undefined, "nothing is pulled for a connector mason does not run");
		assert.equal(record?.started, false);
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
