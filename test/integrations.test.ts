/**
 * The integration list: one file in the server's half, the command that edits it, and the route that reports on it.
 *
 * What matters here is the shape of a failure. An empty integration list quietly removes tools, so a file mason cannot
 * read or cannot validate refuses the boot, naming the path — never an empty set. A rewrite keeps every key mason does
 * not understand, because the file grows and a hand-written note is not mason's to drop. A trigger secret is never
 * printed, not even truncated.
 *
 * Stage A only: nothing connects. The health fields of the route are the place stage B fills in, and are asserted here
 * as the shape it will fill.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { housePaths, type HousePaths } from "../src/server/house.ts";
import {
	integrationStatus,
	integrationSummaries,
	readIntegrations,
	removeIntegration,
	setIntegrationEnabled,
	setIntegrations,
	writeIntegration,
	type Integration,
} from "../src/server/integrations.ts";
import { startServer } from "../src/server/main.ts";

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
			JSON.stringify({ integrations: { github: { enabled: true, tools: { url: "http://mason-github:8082/mcp" } } } }),
		);
		assert.match(await refusal(paths), /no "description": it is the only thing the model is told about it/);

		await writeRaw(
			paths,
			JSON.stringify({
				integrations: { github: { enabled: true, description: "   ", tools: { url: "http://mason-github:8082/mcp" } } },
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
			JSON.stringify({ integrations: { github: { ...github, tools: { url: "http://mason-github:8082/mcp", required: "yes" } } } }),
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
			JSON.stringify({ integrations: { github: { ...github, trigger: { hook: "github-activity", secret: "s".repeat(31) } } } }),
		);
		assert.match(await refusal(paths), /shorter than 32 characters/);

		await writeRaw(
			paths,
			JSON.stringify({ integrations: { github: { ...github, trigger: { hook: "github-activity", secret: "s".repeat(32) } } } }),
		);
		assert.equal((await readIntegrations(paths)).integrations.github?.trigger?.hook, "github-activity");
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

describe("the booted set", () => {
	it("answers for the list it booted with, sorted, with health for stage B", () => {
		setIntegrations({
			github: { ...github, tools: { url: "http://mason-github:8082/mcp", required: true } },
			docs: {
				enabled: false,
				description: "The internal documentation server",
				tools: { url: "http://mason-docs:8080/mcp" },
				trigger: { hook: "docs-activity", secret: "s".repeat(32) },
			},
		});
		// What stage B's client will write when it connects; stage A leaves the map empty.
		integrationStatus().set("github", { connected: true, tools: 7, error: null });
		integrationStatus().set("docs", { connected: false, tools: 0, error: "connect ECONNREFUSED mason-docs:8080" });

		assert.deepEqual(integrationSummaries(), [
			{
				name: "docs",
				enabled: false,
				hasTools: true,
				hasTrigger: true,
				connected: false,
				tools: 0,
				error: "connect ECONNREFUSED mason-docs:8080",
			},
			{
				name: "github",
				enabled: true,
				hasTools: true,
				hasTrigger: false,
				connected: true,
				tools: 7,
				error: null,
			},
		]);

		// A new boot's findings replace the last one's: a status from a previous process is not news.
		setIntegrations({});
		assert.deepEqual(integrationSummaries(), []);
		assert.equal(integrationStatus().size, 0);
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

	it("prints the home and the file it edits when it is asked how to be used", async () => {
		const paths = await temporaryHome();
		// No command: the usage block, which is where a person looks first.
		const usage = await integration(paths.home);
		assert.match(usage.stdout, new RegExp(`home: ${paths.home}`));
		assert.ok(usage.stdout.includes(paths.integrations), "the block names the file, not just the home");
		assert.match(usage.stdout, /--replace/);
	});
});

describe("the integrations route", () => {
	it("answers this boot's list, sorted, and refuses a request without a token", async () => {
		const paths = await temporaryHome();
		const directory = dirname(paths.home);
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					github,
					docs: { enabled: false, description: "The internal documentation server", tools: { url: "http://mason-docs:8080/mcp" } },
				},
			}),
		);
		const server = await startServer({
			port: 0,
			hostname: "127.0.0.1",
			storage: "memory",
			dataDir: join(directory, "data"),
			workspaceDir: join(directory, "workspace"),
			houseHome: paths.home,
			faux: true,
			onReport: () => {},
		});
		try {
			const url = `http://127.0.0.1:${server.port}/api/integrations`;
			assert.equal((await fetch(url)).status, 401, "the route is the owner's, like the rest of the API");

			assert.ok(server.pairingToken, "a fresh home mints one token, which is what pairs this test");
			const answer = await fetch(url, { headers: { authorization: `Bearer ${server.pairingToken}` } });
			assert.equal(answer.status, 200);
			const body = (await answer.json()) as { integrations: Record<string, unknown>[] };
			assert.deepEqual(body.integrations.map((entry) => entry.name), ["docs", "github"], "sorted by name");
			assert.deepEqual(body.integrations[1], {
				name: "github",
				enabled: true,
				hasTools: true,
				hasTrigger: false,
				connected: false,
				tools: 0,
				error: null,
			});
			// The shape is the boot's, not the file's: a change after boot is a restart, and nothing here saw it.
			assert.deepEqual(integrationStatus().size, 0, "stage A connects nothing, so nothing has a health yet");
		} finally {
			await server.close();
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
