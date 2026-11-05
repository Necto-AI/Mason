/**
 * The integration list: one file in the server's half, the command that edits it, and the route that reports on it.
 *
 * What matters here is the shape of a failure. An empty integration list quietly removes tools, so a file mason cannot
 * read or cannot validate refuses the boot, naming the path — never an empty set. A rewrite keeps every key mason does
 * not understand, because the file grows and a hand-written note is not mason's to drop. The signed event door's
 * `trigger` is gone (#104), so a file that still names one is refused and the migration that removes it is tested here.
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
	type Integration,
	migrateIntegrationTriggers,
	readIntegrations,
	removeIntegration,
	setIntegrationEnabled,
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

	it("reads a file back and keeps the keys mason does not know", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				future: "a key from a later version",
				integrations: {
					github: {
						enabled: true,
						description: "Issues and pull requests",
						note: "hand-written, and not mason's to drop",
						tools: { url: "http://mason-github:8082/mcp", owner: "denis" },
					},
				},
			}),
		);

		const read = await readIntegrations(paths);
		assert.equal(read.integrations.github?.note, "hand-written, and not mason's to drop");
		assert.equal(read.integrations.github?.tools?.owner, "denis");

		await writeIntegration(paths, "docs", {
			enabled: true,
			description: "  The internal documentation server  ",
			tools: { url: "http://mason-docs:8080/mcp" },
		});

		const stored = JSON.parse(await readFile(paths.integrations, "utf8")) as {
			future?: string;
			integrations: Record<string, Record<string, unknown>>;
		};
		assert.equal(stored.future, "a key from a later version", "a key from the top level survived the rewrite");
		assert.equal(stored.integrations.github?.note, "hand-written, and not mason's to drop");
		assert.deepEqual(stored.integrations.github?.tools, { url: "http://mason-github:8082/mcp", owner: "denis" });
		assert.deepEqual(Object.keys(stored.integrations), ["docs", "github"], "the file is in a stable order");
		// The description is a line in the prompt: the space around it is nobody's intent.
		assert.equal(stored.integrations.docs?.description, "The internal documentation server");
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

	it("refuses a file that still names the signed event door, and points at the migration", async () => {
		const paths = await temporaryHome();
		// The door is gone (#104). Reading past a secret nothing checks would leave a sender that looks configured and
		// receives nothing, so the boot refuses and says which command removes it.
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: { github: { ...github, trigger: { hook: "github-activity", secret: "s".repeat(32) } } },
			}),
		);
		const trigger = await refusal(paths);
		assert.ok(trigger.includes(paths.integrations), `the refusal names the file: ${trigger}`);
		assert.match(trigger, /"trigger"/);
		assert.match(trigger, /npm run doctor -- migrate/);
		assert.match(trigger, /npm run connector -- add github/);

		await writeRaw(paths, JSON.stringify({ integrations: { github: { ...github, commands: ["stop"] } } }));
		const commands = await refusal(paths);
		assert.match(commands, /"commands"/);
		assert.match(commands, /connector\.commands/);
		assert.match(commands, /npm run doctor -- migrate/);
	});

	it("reads a user face that names one owner, and refuses the keys a room needed", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					telegram: {
						enabled: true,
						connector: { user: { owner: "8811", conversations: [] }, state: [], trustMarkers: false },
					},
				},
			}),
		);
		const booted = (await readIntegrations(paths)).integrations.telegram?.connector?.user;
		assert.equal(booted?.owner, "8811");

		// Each retired key is a file whose reader believes it still decides who may speak (#126). The refusal names the key
		// and the one command that rewrites it, rather than reading past a setting that no longer exists.
		for (const [key, retired] of [
			["actors", { "8811": "Denis" }],
			["unattributed", true],
			["approver", "8811"],
		] as const) {
			await writeRaw(
				paths,
				JSON.stringify({
					integrations: {
						telegram: {
							enabled: true,
							connector: {
								user: { owner: "8811", conversations: [], [key]: retired },
								state: [],
								trustMarkers: false,
							},
						},
					},
				}),
			);
			const refused = await refusal(paths);
			assert.match(refused, new RegExp(`connector\\.user\\.${key}`), key);
			assert.match(refused, /npm run doctor -- migrate/, key);
		}

		// An owner that is not an actor id is refused as well: an empty string is nobody, spelled as if it were somebody.
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					telegram: {
						enabled: true,
						connector: { user: { owner: "  ", conversations: [] }, state: [], trustMarkers: false },
					},
				},
			}),
		);
		assert.match(await refusal(paths), /"connector\.user\.owner" that is not an actor id/);
	});

	it("migrates both old keys away, once, and carries a granted vocabulary onto the grant", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					github: {
						...github,
						note: "a key mason has never heard of",
						trigger: { hook: "github-activity", secret: "s".repeat(32) },
						commands: ["stop"],
					},
					docs: { enabled: false, description: "The docs", tools: { url: "http://mason-docs:8080/mcp" } },
				},
			}),
		);

		assert.deepEqual(await migrateIntegrationTriggers(paths), [{ name: "github", moved: [], stranded: ["stop"] }]);
		const migrated = (await readIntegrations(paths)).integrations;
		assert.equal(migrated.github?.trigger, undefined);
		assert.equal(migrated.github?.commands, undefined);
		assert.equal((migrated.github as Record<string, unknown>).note, "a key mason has never heard of");
		assert.deepEqual(migrated.github?.tools, github.tools, "the tools face survives the migration");
		assert.deepEqual(migrated.docs?.tools, { url: "http://mason-docs:8080/mcp" });

		// Idempotent: a second run finds nothing to do and does not rewrite the file.
		const before = await readFile(paths.integrations, "utf8");
		assert.deepEqual(await migrateIntegrationTriggers(paths), []);
		assert.equal(await readFile(paths.integrations, "utf8"), before);
	});

	it("moves the old command list onto the grant rather than dropping a permission a person granted", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					telegram: {
						enabled: true,
						trigger: { hook: "team-chat", secret: "s".repeat(32) },
						commands: ["stop", "status"],
						connector: { events: { hooks: {} }, state: ["status"], trustMarkers: false },
					},
					// No connector block: there is nothing to hold the words, and doctor says so rather than inventing one.
					bare: { enabled: true, commands: ["compact"] },
				},
			}),
		);

		assert.deepEqual(await migrateIntegrationTriggers(paths), [
			{ name: "telegram", moved: ["stop", "status"], stranded: [] },
			{ name: "bare", moved: [], stranded: ["compact"] },
		]);
		const migrated = (await readIntegrations(paths)).integrations;
		assert.deepEqual(migrated.telegram?.connector?.commands, ["stop", "status"]);
		assert.deepEqual(migrated.telegram?.connector?.state, ["status"], "the rest of the grant is untouched");
	});

	it("writes the file private, through a rename, and leaves no temporary behind", async () => {
		const paths = await temporaryHome();
		await writeIntegration(paths, "github", github);
		assert.equal((await stat(paths.integrations)).mode & 0o777, 0o600, "the file holds connector credentials");
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
		return run(process.execPath, ["--experimental-strip-types", script, ...args], {
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
		assert.match(listed.stdout, /github\s+enabled\s+http:\/\/mason-github:8082\/mcp\s+no connector/);

		await integration(paths.home, "disable", "github");
		assert.match((await integration(paths.home, "list")).stdout, /github\s+disabled/);
		await integration(paths.home, "enable", "github");
		assert.match((await integration(paths.home, "list")).stdout, /github\s+enabled/);

		await integration(paths.home, "remove", "github");
		assert.match((await integration(paths.home, "list")).stdout, /no integrations/);
		await assert.rejects(() => integration(paths.home, "remove", "github"), /no integration github/);
		await assert.rejects(() => integration(paths.home, "enable", "github"), /no integration github/);
	});

	it("refuses a second add unless it is a replace, and a replace keeps the switch and the grant", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					github: {
						enabled: false,
						description: "The old endpoint",
						tools: { url: "http://mason-github:8082/mcp", required: true },
						connector: { state: [], trustMarkers: true },
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
		assert.equal(stored?.connector?.trustMarkers, true);
	});

	it("lists a connector by the faces it grants, and names no credential", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					github: {
						...github,
						connector: {
							user: { owner: "8811", conversations: [] },
							state: ["status"],
							trustMarkers: false,
						},
					},
				},
			}),
		);
		const listed = await integration(paths.home, "list");
		assert.match(listed.stdout, /connector \(user, tools\)/);
		assert.doesNotMatch(listed.stdout, /secret|credential/i);
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

describe("the integrations route", () => {
	it("answers nothing at the signed event door, because there is no door any more", async () => {
		const paths = await temporaryHome();
		await writeRaw(paths, JSON.stringify({ integrations: {} }));
		const server = await serve(paths, downAll);
		const base = server.url.slice(0, -"/api/integrations".length);
		try {
			// The path used to be the one door outside the owner's gate, authenticated by a sender's HMAC. It is not a
			// door now, so it is not outside the gate either: no token is refused like any other `/api` path, and a token
			// reaches the same `404` a path nobody serves gets.
			for (const path of ["/api/events/telegram", "/api/events/", "/api/events/telegram/more"]) {
				const anonymous = await fetch(`${base}${path}`, {
					method: "POST",
					headers: { "content-type": "application/json", "x-mason-signature": `sha256=${"0".repeat(64)}` },
					body: JSON.stringify({ v: 1, id: "1", kind: "chat.message", payload: "hello" }),
				});
				assert.equal(anonymous.status, 401, `${path} is not a door`);

				const owned = await fetch(`${base}${path}`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${server.token}`,
						"content-type": "application/json",
						"x-mason-signature": `sha256=${"0".repeat(64)}`,
					},
					body: JSON.stringify({ v: 1, id: "1", kind: "chat.message", payload: "hello" }),
				});
				assert.equal(owned.status, 404, `${path} has no route behind the gate either`);
			}
		} finally {
			await server.close();
		}
	});

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
					connected: false,
					tools: 0,
					error: 'MCP integration "docs" at http://mason-docs:8080/mcp: no container in a test',
				},
				{
					name: "github",
					enabled: true,
					hasTools: true,
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
