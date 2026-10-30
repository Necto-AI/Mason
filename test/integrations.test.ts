/**
 * The integration list: one file in the server's half, the command that edits it, and the route that reports on it.
 *
 * What matters here is the shape of a failure. An empty integration list quietly removes tools, so a file mason cannot
 * read or cannot validate refuses the boot, naming the path — never an empty set. A key inside an entry is refused
 * rather than ignored, because a key mason skips is a capability its author believes in; a key at the document's own
 * level survives a rewrite, because there mason reads exactly one key and a note is not its business. A trigger secret
 * is never printed, not even truncated.
 *
 * The two files are tested apart from each other: the list on disk through `readIntegrations` and the command, and the
 * route through a started server — a reachable server is a fake MCP server on an in-memory transport, never a port.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type HousePaths, housePaths } from "../src/server/house.ts";
import {
	commandsFor,
	type Integration,
	readIntegrations,
	removeIntegration,
	setIntegrationEnabled,
	triggerFor,
	writeIntegration,
} from "../src/server/integrations.ts";
import { startServer } from "../src/server/main.ts";
import type { McpTransportFactory } from "../src/server/mcp.ts";
import { fakeServer, ISSUE_TOOL, SEARCH_TOOL } from "./support/mcp.ts";

const run = promisify(execFile);

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

/** A home that exists but holds nothing: the state a fresh install is in before anything is written. */
async function temporaryHome(): Promise<HousePaths> {
	const directory = await mkdtemp(join(tmpdir(), "mason-integrations-"));
	directories.add(directory);
	const paths = housePaths(join(directory, "house"));
	await mkdir(paths.home, { recursive: true, mode: 0o700 });
	return paths;
}

/** A file as a person would leave it: hand-written, possibly before this code knew the shape. */
async function writeRaw(paths: HousePaths, text: string): Promise<void> {
	await mkdir(dirname(paths.integrations), { recursive: true, mode: 0o700 });
	await writeFile(paths.integrations, text, { encoding: "utf8", mode: 0o600 });
}

const github: Integration = {
	enabled: true,
	description: "Issues and pull requests for the team's repositories",
	tools: { url: "http://mason-github:8082/mcp" },
};

/** The refusal a file earns, as the operator reads it. */
async function refusal(paths: HousePaths): Promise<string> {
	try {
		await readIntegrations(paths);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	assert.fail(`${paths.integrations} was accepted, so a broken entry would silently lose a capability`);
}

describe("the integration list on disk", () => {
	it("reads a home with no file as an empty set", async () => {
		const paths = await temporaryHome();
		assert.deepEqual(await readIntegrations(paths), { integrations: {} });
	});

	it("reads a file back, keeps the document's own keys and normalises the entry", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				$schema: "a key from a later version",
				integrations: {
					github: { enabled: true, description: "Issues and pull requests", tools: { url: "http://mason-github:8082/mcp" } },
				},
			}),
		);

		const read = await readIntegrations(paths);
		assert.deepEqual(read.integrations.github, {
			enabled: true,
			description: "Issues and pull requests",
			tools: { url: "http://mason-github:8082/mcp" },
		});

		await writeIntegration(paths, "docs", {
			enabled: true,
			description: "  The internal documentation server  ",
			tools: { url: "http://mason-docs:8080/mcp" },
		});

		const stored = JSON.parse(await readFile(paths.integrations, "utf8")) as {
			$schema?: string;
			integrations: Record<string, Record<string, unknown>>;
		};
		assert.equal(stored.$schema, "a key from a later version", "a key of the document's own survived the rewrite");
		assert.deepEqual(Object.keys(stored.integrations), ["docs", "github"], "the file is in a stable order");
		// The description is a line in the prompt: the space around it is nobody's intent.
		assert.equal(stored.integrations.docs?.description, "The internal documentation server");
	});

	it("refuses a key inside an entry, naming it, instead of storing something mason will not read", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({ integrations: { github: { ...github, note: "hand-written, and not mason's to drop" } } }),
		);
		const message = await refusal(paths);
		assert.ok(message.includes(paths.integrations));
		assert.match(message, /has the key "note"/, "the refusal names the key it would otherwise ignore");
		assert.match(message, /commands, description, enabled, tools, trigger/, "and the set it should have drawn from");
	});

	/**
	 * The sentence `docs/CONNECTOR-PROTOCOL.md` has promised since it was written: an entry that uses a channel this
	 * build does not have refuses the boot naming the field. The code used to spread these through, so an operator had a
	 * reply route that was accepted, stored and never routed.
	 */
	it("refuses a channel the contract declares and this build does not have", async () => {
		for (const channel of [{ reply: "send_message" }, { state: ["projection"] }, { also: ["slack"] }]) {
			const paths = await temporaryHome();
			const key = Object.keys(channel)[0] as string;
			await writeRaw(paths, JSON.stringify({ integrations: { github: { ...github, ...channel } } }));
			const message = await refusal(paths);
			assert.match(message, new RegExp(`uses "${key}"`), `${key} is refused rather than accepted and ignored`);
			assert.match(message, /CONNECTOR-PROTOCOL/, "the refusal says where the channel is promised");
		}
	});

	/**
	 * The security case behind the same rule (`#85`): a credential an operator added for a hosted MCP server used to be
	 * dropped on the floor by the index signature on the tools face, which is worse than a refused boot because they
	 * believed they had authenticated.
	 */
	it("refuses a key inside the tools face, so a dropped credential cannot pass as one that landed", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: { github: { ...github, tools: { url: "http://mason-github:8082/mcp", headers: { authorization: "x" } } } },
			}),
		);
		const message = await refusal(paths);
		assert.match(message, /has the key "headers"/);
		assert.match(message, /required, url/);
	});

	it("refuses a file it cannot parse, naming the path rather than reading as empty", async () => {
		const paths = await temporaryHome();
		await writeRaw(paths, '{"integrations": {');
		const message = await refusal(paths);
		assert.ok(message.includes(paths.integrations), `the refusal names the file: ${message}`);
		assert.match(message, /not JSON/);
	});

	it("refuses a file whose one key is misspelled", async () => {
		const paths = await temporaryHome();
		await writeRaw(paths, JSON.stringify({ integration: { github } }));
		const message = await refusal(paths);
		assert.ok(message.includes(paths.integrations));
		assert.match(message, /no "integrations" key/, "a typo must not read as no integrations at all");
	});

	it("refuses an entry whose name a tool cannot be built from", async () => {
		for (const name of ["GitHub", "my_server", "_github"]) {
			const paths = await temporaryHome();
			await writeRaw(paths, JSON.stringify({ integrations: { [name]: github } }));
			const message = await refusal(paths);
			assert.ok(message.includes(paths.integrations), `the refusal names the file: ${message}`);
			assert.match(message, /not a usable name/, `${name} is not a name \`mcp__<name>__<tool>\` can carry`);
		}
		const unnamed = await temporaryHome();
		await writeRaw(unnamed, JSON.stringify({ integrations: { "": github } }));
		assert.match(await refusal(unnamed), /has no name: the key is the name/);
	});

	it("refuses a tools face with no description, and an empty one", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: { github: { enabled: true, tools: { url: "http://mason-github:8082/mcp" } } },
			}),
		);
		assert.match(await refusal(paths), /no "description": it is the only thing the model is told about it/);

		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					github: { enabled: true, description: "   ", tools: { url: "http://mason-github:8082/mcp" } },
				},
			}),
		);
		assert.match(await refusal(paths), /empty "description"/);
	});

	it("refuses a tools url that is not an http endpoint", async () => {
		// `mason-github:8082/mcp` is the shape a person writes without the scheme: a real URL, of no usable protocol.
		for (const url of ["mason-github:8082/mcp", "ftp://mason-github/mcp", "file:///mcp", ""]) {
			const paths = await temporaryHome();
			await writeRaw(paths, JSON.stringify({ integrations: { github: { ...github, tools: { url } } } }));
			assert.match(await refusal(paths), /usable tools url/, `${url} is not an MCP endpoint`);
		}
	});

	it("refuses a tools.required that is not a boolean, and an enabled that is a string", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: { github: { ...github, tools: { url: "http://mason-github:8082/mcp", required: "yes" } } },
			}),
		);
		assert.match(await refusal(paths), /"tools.required" that is not true or false/);

		await writeRaw(paths, JSON.stringify({ integrations: { github: { ...github, enabled: "false" } } }));
		// The string "false" is truthy: read as a boolean it would leave an integration on that its author believed off.
		assert.match(await refusal(paths), /needs "enabled": true or "enabled": false/);
	});

	it("refuses a trigger with no hook or a secret that can be guessed", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({ integrations: { github: { ...github, trigger: { hook: "  ", secret: "s".repeat(32) } } } }),
		);
		assert.match(await refusal(paths), /"trigger" with no "hook"/);

		await writeRaw(
			paths,
			JSON.stringify({
				integrations: { github: { ...github, trigger: { hook: "github-activity", secret: "s".repeat(31) } } },
			}),
		);
		assert.match(await refusal(paths), /shorter than 32 characters/);

		await writeRaw(
			paths,
			JSON.stringify({
				integrations: { github: { ...github, trigger: { hook: "github-activity", secret: "s".repeat(32) } } },
			}),
		);
		assert.equal((await readIntegrations(paths)).integrations.github?.trigger?.hook, "github-activity");
	});

	it("refuses a command mason does not have, naming the whole set", async () => {
		const paths = await temporaryHome();
		await writeRaw(paths, JSON.stringify({ integrations: { github: { ...github, commands: ["stop", "restart"] } } }));
		const message = await refusal(paths);
		assert.ok(message.includes(paths.integrations), `the refusal names the file: ${message}`);
		assert.match(message, /"restart"/);
		assert.match(message, /stop, compact, clear, status/);

		// Empty is the one honest list: a trigger with no commands is an existing secret that gained nothing.
		await writeRaw(paths, JSON.stringify({ integrations: { github: { ...github, commands: [] } } }));
		assert.deepEqual((await readIntegrations(paths)).integrations.github?.commands, []);
	});

	it("writes the file private, through a rename, and leaves no temporary behind", async () => {
		const paths = await temporaryHome();
		await writeIntegration(paths, "github", github);
		assert.equal((await stat(paths.integrations)).mode & 0o777, 0o600, "the file holds a trigger secret");
		assert.equal((await stat(paths.serviceDir)).mode & 0o777, 0o700);
		assert.deepEqual(
			(await readdir(paths.serviceDir)).filter((name) => name.endsWith(".tmp")),
			[],
		);
	});

	it("enables, disables and removes an entry, and says when there is none", async () => {
		const paths = await temporaryHome();
		await writeIntegration(paths, "github", github);

		assert.equal((await setIntegrationEnabled(paths, "github", false))?.enabled, false);
		assert.equal((await readIntegrations(paths)).integrations.github?.enabled, false);
		assert.equal(await setIntegrationEnabled(paths, "nope", true), undefined);

		assert.equal(await removeIntegration(paths, "github"), true);
		assert.equal(await removeIntegration(paths, "github"), false, "a typo must not read as a removal");
		assert.deepEqual(await readIntegrations(paths), { integrations: {} });
	});

	it("refuses to write a name or an endpoint the server could not boot with", async () => {
		const paths = await temporaryHome();
		await assert.rejects(() => writeIntegration(paths, "Bad Name", github), /not a usable name/);
		await assert.rejects(
			() => writeIntegration(paths, "github", { ...github, tools: { url: "not a url" } }),
			/usable tools url/,
		);
	});
});

/**
 * The command itself, spawned the way an operator runs it: `npm run integration -- …` with `MASON_HOME` pointing at a
 * temporary home, so the assertion is the file it wrote and the line it printed rather than the module's API.
 */
describe("the integration command", () => {
	const script = fileURLToPath(new URL("../scripts/integration.ts", import.meta.url));

	function integration(home: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
		return run(process.execPath, ["--conditions=source", "--experimental-strip-types", script, ...args], {
			env: { ...process.env, MASON_HOME: home },
		});
	}

	it("adds, lists, switches and removes an integration in the home it is pointed at", async () => {
		const paths = await temporaryHome();

		const added = await integration(
			paths.home,
			"add",
			"github",
			"--url",
			"http://mason-github:8082/mcp",
			"--description",
			"Issues and pull requests",
		);
		assert.match(added.stdout, /wrote enabled github/);
		assert.match(added.stdout, /read once at boot: start the server again/, "a change is a restart, and it says so");
		assert.equal((await readIntegrations(paths)).integrations.github?.enabled, true);

		const listed = await integration(paths.home, "list");
		assert.match(listed.stdout, /github\s+enabled\s+http:\/\/mason-github:8082\/mcp\s+no trigger/);

		await integration(paths.home, "disable", "github");
		assert.match((await integration(paths.home, "list")).stdout, /github\s+disabled/);
		await integration(paths.home, "enable", "github");
		assert.match((await integration(paths.home, "list")).stdout, /github\s+enabled/);

		await integration(paths.home, "remove", "github");
		assert.match((await integration(paths.home, "list")).stdout, /no integrations/);
		await assert.rejects(() => integration(paths.home, "remove", "github"), /no integration github/);
		await assert.rejects(() => integration(paths.home, "enable", "github"), /no integration github/);
	});

	it("refuses a second add unless it is a replace, and a replace keeps the switch and the trigger", async () => {
		const paths = await temporaryHome();
		const secret = "0123456789abcdef0123456789abcdef";
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					github: {
						enabled: false,
						description: "The old endpoint",
						tools: { url: "http://mason-github:8082/mcp", required: true },
						trigger: { hook: "github-activity", secret },
					},
				},
			}),
		);

		await assert.rejects(
			() => integration(paths.home, "add", "github", "--url", "http://new:8082/mcp", "--description", "New"),
			/already an integration/,
		);

		const replaced = await integration(
			paths.home,
			"add",
			"github",
			"--url",
			"http://new:8082/mcp",
			"--description",
			"New",
			"--replace",
		);
		assert.match(replaced.stdout, /wrote disabled github/, "a replace does not switch an integration on");
		const stored = (await readIntegrations(paths)).integrations.github;
		assert.equal(stored?.description, "New");
		assert.deepEqual(stored?.tools, { url: "http://new:8082/mcp", required: true });
		assert.equal(stored?.trigger?.secret, secret);
	});

	it("lists a trigger by the hook it fires, and never by its secret", async () => {
		const paths = await temporaryHome();
		const secret = "0123456789abcdef0123456789abcdef";
		await writeRaw(
			paths,
			JSON.stringify({ integrations: { github: { ...github, trigger: { hook: "github-activity", secret } } } }),
		);
		const listed = await integration(paths.home, "list");
		assert.match(listed.stdout, /trigger github-activity/);
		assert.ok(!listed.stdout.includes(secret), "a secret in a printed line is a secret in a log");
		assert.ok(!listed.stdout.includes(secret.slice(0, 8)), "not even a prefix of one");
	});

	it("mints a trigger secret once, stores it 0600, and keeps the rest of the entry", async () => {
		const paths = await temporaryHome();
		await writeIntegration(paths, "telegram", {
			enabled: true,
			description: "The team's Telegram group",
			tools: { url: "http://mason-telegram:8082/mcp" },
		});

		const minted = await integration(paths.home, "secret", "telegram", "--hook", "workspace-check");
		const secret = /^ {2}([0-9a-f]{64})$/m.exec(minted.stdout)?.[1];
		assert.ok(secret, `the secret is printed once, on a line of its own: ${minted.stdout}`);
		assert.equal(minted.stdout.split(secret).length - 1, 1, "one delivery of one secret, never a second mention");
		const stored = (await readIntegrations(paths)).integrations.telegram;
		assert.equal(stored?.trigger?.hook, "workspace-check");
		assert.equal(stored?.trigger?.secret, secret);
		assert.deepEqual(stored?.tools, { url: "http://mason-telegram:8082/mcp" }, "the rest of the entry is kept");
		assert.equal((await stat(paths.integrations)).mode & 0o777, 0o600);

		// A rotation replaces the key and keeps the hook, so the door's identity does not move with its secret.
		const rotated = await integration(paths.home, "secret", "telegram");
		const rotatedSecret = /^ {2}([0-9a-f]{64})$/m.exec(rotated.stdout)?.[1];
		assert.ok(rotatedSecret);
		assert.notEqual(rotatedSecret, secret);
		assert.equal((await readIntegrations(paths)).integrations.telegram?.trigger?.hook, "workspace-check");

		// A --hook beside an existing trigger is refused rather than silently ignored, and a first secret needs one.
		await assert.rejects(
			() => integration(paths.home, "secret", "telegram", "--hook", "morning-brief"),
			/already has a trigger/,
		);
		await writeIntegration(paths, "docs", {
			enabled: true,
			description: "The docs",
			tools: { url: "http://mason-docs:8080/mcp" },
		});
		await assert.rejects(() => integration(paths.home, "secret", "docs"), /--hook/);

		// The list and the refusal name the hook and never the secret.
		const listed = (await integration(paths.home, "list")).stdout;
		assert.match(listed, /trigger workspace-check/);
		assert.ok(!listed.includes(rotatedSecret), "a secret in a printed line is a secret in a log");
	});

	it("declares the commands its trigger may issue, and refuses one mason does not have", async () => {
		const paths = await temporaryHome();
		await writeIntegration(paths, "telegram", {
			enabled: true,
			description: "The team's Telegram group",
			tools: { url: "http://mason-telegram:8082/mcp" },
			trigger: { hook: "team-chat", secret: "0123456789abcdef0123456789abcdef" },
		});

		// An absent list is no vocabulary at all: an existing trigger secret gains nothing by being read.
		assert.deepEqual((await readIntegrations(paths)).integrations.telegram?.commands, undefined);

		await integration(paths.home, "commands", "telegram", "stop, compact ,clear");
		assert.deepEqual((await readIntegrations(paths)).integrations.telegram?.commands, ["stop", "compact", "clear"]);
		assert.match((await integration(paths.home, "list")).stdout, /trigger team-chat, commands stop,compact,clear/);

		// A name this build does not have is refused rather than stored, and the refusal names the whole set.
		await assert.rejects(
			() => integration(paths.home, "commands", "telegram", "stop,stopp"),
			(error: Error) => {
				assert.match(error.message, /"stopp"/);
				assert.match(error.message, /stop, compact, clear, status/);
				assert.ok(error.message.includes(paths.integrations), "the refusal names the file to fix");
				return true;
			},
		);
		assert.deepEqual(
			(await readIntegrations(paths)).integrations.telegram?.commands,
			["stop", "compact", "clear"],
			"a refused write leaves the file as it was",
		);

		// An empty list is how the vocabulary is taken away again, and it reads as none either way.
		await integration(paths.home, "commands", "telegram", "");
		assert.deepEqual((await readIntegrations(paths)).integrations.telegram?.commands, []);
		assert.doesNotMatch((await integration(paths.home, "list")).stdout, /commands/);
		await assert.rejects(() => integration(paths.home, "commands", "nobody", "stop"), /no integration nobody/);
	});

	it("prints the home and the file it edits when it is asked how to be used", async () => {
		const paths = await temporaryHome();
		// No command: the usage block, which is where a person looks first.
		const usage = await integration(paths.home);
		assert.match(usage.stdout, new RegExp(`home: ${paths.home}`));
		assert.ok(usage.stdout.includes(paths.integrations), "the block names the file, not just the home");
		assert.match(usage.stdout, /--replace/);
	});
});

/**
 * A running server over `paths`, booted with the transport its connections use. The route is the subject of these
 * tests, so nothing here reaches into the module's registry: a server is started, and the answer is what it says.
 */
async function serve(
	paths: HousePaths,
	transport: McpTransportFactory,
	token?: string,
): Promise<{ url: string; token: string; close: () => Promise<void> }> {
	const directory = dirname(paths.home);
	const server = await startServer({
		port: 0,
		hostname: "127.0.0.1",
		storage: "memory",
		dataDir: join(directory, "data"),
		workspaceDir: join(directory, "workspace"),
		houseHome: paths.home,
		faux: true,
		onReport: () => {},
		mcpTransport: transport,
	});
	// A fresh home mints one token, and a second boot over the same home does not: the token outlives the process, so a
	// caller that has it, has it.
	const paired = token ?? server.pairingToken;
	assert.ok(paired, "a fresh home mints one token, which is what pairs this test");
	return {
		url: `http://127.0.0.1:${server.port}/api/integrations`,
		token: paired,
		close: () => server.close(),
	};
}

/** What the route answers, as a client reads it. */
async function reported(url: string, token: string): Promise<Record<string, unknown>[]> {
	const answer = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
	assert.equal(answer.status, 200);
	const body = (await answer.json()) as { integrations: Record<string, unknown>[] };
	return body.integrations;
}

/** Every server down: the shape of a boot nobody's containers have come up for. */
function downAll(): never {
	throw new Error("no container in a test");
}

describe("the trigger a door may use", () => {
	it("is a trigger face on an enabled integration, and nothing else", () => {
		const integrations: Record<string, Integration> = {
			on: { enabled: true, trigger: { hook: "workspace-check", secret: "0f".repeat(32) } },
			off: { enabled: false, trigger: { hook: "workspace-check", secret: "1e".repeat(32) } },
			"tools-only": { ...github },
		};
		assert.equal(triggerFor(integrations, "on")?.hook, "workspace-check");
		assert.equal(triggerFor(integrations, "off"), undefined, "a disabled integration's door is nowhere");
		assert.equal(triggerFor(integrations, "tools-only"), undefined, "tools are not a door");
		assert.equal(triggerFor(integrations, "nobody"), undefined);
	});
});

describe("the vocabulary a trigger may issue", () => {
	it("is the declared commands of an enabled entry with a trigger, and nothing else", () => {
		// This is the privilege gate itself: what one integration's secret may ask mason to do. Everything else — a
		// declaration with no trigger to spend it with, a switched-off entry, an absent list — is nothing at all, so a
		// later `secret` minting a trigger is what first makes an old declaration live.
		const integrations: Record<string, Integration> = {
			telegram: {
				enabled: true,
				trigger: { hook: "workspace-check", secret: "0f".repeat(32) },
				commands: ["stop", "status"],
			},
			silent: { enabled: true, trigger: { hook: "workspace-check", secret: "1e".repeat(32) } },
			off: { enabled: false, trigger: { hook: "workspace-check", secret: "2a".repeat(32) }, commands: ["stop"] },
			"no-trigger": { enabled: true, commands: ["stop"] },
			"off-and-no-trigger": { enabled: false, commands: ["stop"] },
		};
		assert.deepEqual(commandsFor(integrations, "telegram"), ["stop", "status"]);
		assert.deepEqual(commandsFor(integrations, "silent"), [], "an absent list is no vocabulary at all");
		assert.deepEqual(
			commandsFor(integrations, "off"),
			[],
			"a switched-off entry's door is nowhere, so its words are too",
		);
		assert.deepEqual(
			commandsFor(integrations, "no-trigger"),
			[],
			"a declaration with no secret to spend it with grants nothing",
		);
		assert.deepEqual(commandsFor(integrations, "off-and-no-trigger"), []);
		assert.deepEqual(commandsFor(integrations, "nobody"), []);
	});
});

describe("the integrations route", () => {
	it("answers this boot's list, sorted, and refuses a request without a token", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					github,
					docs: {
						enabled: false,
						description: "The internal documentation server",
						tools: { url: "http://mason-docs:8080/mcp" },
					},
				},
			}),
		);
		// A boot with a tools face reaches for it, so the test hands it a transport that is down instead of a port.
		const server = await serve(paths, downAll);
		try {
			assert.equal((await fetch(server.url)).status, 401, "the route is the owner's, like the rest of the API");

			const integrations = await reported(server.url, server.token);
			assert.deepEqual(
				integrations.map((entry) => entry.name),
				["docs", "github"],
				"sorted by name",
			);
			assert.deepEqual(integrations[1], {
				name: "github",
				enabled: true,
				hasTools: true,
				hasTrigger: false,
				connected: false,
				tools: 0,
				error: 'MCP integration "github" at http://mason-github:8082/mcp: no container in a test',
			});
			// A disabled integration is not attempted at all, so it has no health to report: the route says what is, not what
			// would be if the switch were flipped.
			assert.deepEqual(integrations[0], {
				name: "docs",
				enabled: false,
				hasTools: true,
				hasTrigger: false,
				connected: false,
				tools: 0,
				error: null,
			});
		} finally {
			await server.close();
		}
	});

	it("reports a server it reached, with the tools it offered", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					github,
					docs: {
						enabled: true,
						description: "The internal documentation server",
						tools: { url: "http://mason-docs:8080/mcp" },
						trigger: { hook: "workspace-check", secret: "s".repeat(32) },
					},
				},
			}),
		);
		const reachable = await fakeServer([ISSUE_TOOL, SEARCH_TOOL], () => ({ content: [] }));
		// The container that came up and the one that did not, told apart by the url the boot asks for.
		const server = await serve(paths, (url) => (url.includes("mason-github") ? reachable.transport : downAll()));
		try {
			assert.deepEqual(await reported(server.url, server.token), [
				{
					name: "docs",
					enabled: true,
					hasTools: true,
					hasTrigger: true,
					connected: false,
					tools: 0,
					error: 'MCP integration "docs" at http://mason-docs:8080/mcp: no container in a test',
				},
				{
					name: "github",
					enabled: true,
					hasTools: true,
					hasTrigger: false,
					connected: true,
					tools: 2,
					error: null,
				},
			]);
		} finally {
			await server.close();
		}
	});

	it("does not report a connection the boot before this one made", async () => {
		const paths = await temporaryHome();
		await writeRaw(paths, JSON.stringify({ integrations: { github } }));
		const reachable = await fakeServer([ISSUE_TOOL, SEARCH_TOOL], () => ({ content: [] }));
		const first = await serve(paths, () => reachable.transport);
		try {
			assert.deepEqual((await reported(first.url, first.token))[0]?.connected, true, "the first boot reached it");
		} finally {
			await first.close();
		}

		// The same home, the same process, and this time nothing answers: what the route says is this boot's finding,
		// because a status left over from a connection that has since died is worse than no status at all.
		const second = await serve(paths, downAll, first.token);
		try {
			const [github] = await reported(second.url, second.token);
			assert.equal(github?.connected, false, "the previous boot's connection is not news");
			assert.match(String(github?.error), /no container in a test/);
			assert.equal(github?.tools, 0);
		} finally {
			await second.close();
		}
	});

	it("refuses to boot on an integration list it cannot read", async () => {
		const paths = await temporaryHome();
		const directory = dirname(paths.home);
		await writeRaw(paths, '{"integrations": {');
		await assert.rejects(
			() =>
				startServer({
					port: 0,
					hostname: "127.0.0.1",
					storage: "memory",
					dataDir: join(directory, "data"),
					workspaceDir: join(directory, "workspace"),
					houseHome: paths.home,
					faux: true,
					onReport: () => {},
				}),
			(error: Error) => error.message.includes(paths.integrations),
			"a server that booted with an empty set would be missing tools nobody knows it lost",
		);
	});
});
