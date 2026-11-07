/**
 * `src/server/doctor.ts` — the nine checks, each with a good fixture and the failure it exists to name.
 *
 * Doctor is read-only, so the fixtures are files: a bot whose common store and console grant are written, then one thing
 * broken in it. What is pinned is the shape of the report — a failing check says one repair command — plus the two
 * promises a CI job depends on: the exit code, and that a credential never appears in the output.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { consoleGrant } from "../scripts/chat.ts";
import { writeTextAtomic } from "../src/server/atomic.ts";
import { commonPaths, hashFile, writeCommonStore } from "../src/server/common.ts";
import { writeCompose } from "../src/server/connector-compose.ts";
import { doctorExitCode, formatCheck, runDoctor } from "../src/server/doctor.ts";
import { botPaths, ensureHouse, type HousePaths } from "../src/server/house.ts";
import { writeInstall } from "../src/server/install-state.ts";
import {
	bootRecordPath,
	readIntegrationBoot,
	recordIntegrationBoot,
	writeIntegration,
} from "../src/server/integrations.ts";
import type { CommandRunner, Prober } from "../src/server/podman.ts";
import { openAgentRuntime } from "../src/server/runtime.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-doctor-"));
	directories.add(directory);
	return directory;
}

/** A bot with a common store, a console grant and a soul: every check that does not need a container can pass. */
async function goodBot(): Promise<{ root: string; house: HousePaths }> {
	const root = await tempRoot();
	await writeCommonStore(root, { defaultProvider: "faux", defaultModel: "faux-1" });
	const home = join(root, "alice");
	const house = botPaths({ root, name: "alice", home });
	await ensureHouse(house, "a soul for the doctor");
	await writeIntegration(house, "console", { enabled: true, description: "the terminal", connector: consoleGrant() });
	return { root, house };
}

/** A bot whose one connector runs in a container, with whatever state the test wants it to be in. */
async function containerBot(state: string | undefined, credential: boolean): Promise<HousePaths> {
	const root = await tempRoot();
	await writeCommonStore(root, { defaultProvider: "faux", defaultModel: "faux-1" });
	const home = join(root, "alice");
	const house = botPaths({ root, name: "alice", home });
	await ensureHouse(house, "a soul for the doctor");
	await writeIntegration(house, "telegram", { enabled: true, description: "telegram", connector: consoleGrant() });
	await writeCompose(house, {
		connector: "telegram",
		image: "ghcr.io/example/mason-telegram:1.0.0",
		home,
		env: {
			MASON_CONNECTOR_URL: "ws://host.containers.internal:8787/api/connector",
			MASON_CONNECTOR_CREDENTIAL: "masonc_x",
		},
	});
	await writeInstall(house, "telegram", {
		source: "catalog:telegram@1.0.0",
		image: "ghcr.io/example/mason-telegram:1.0.0",
		version: "1.0.0",
		project: "abc12345-telegram",
		createdAt: new Date().toISOString(),
		started: state === "running",
	});
	if (credential) {
		// A credential whose hash is the one the compose file carries: the state a healthy install is in.
		const { mintConnectorCredential } = await import("../src/server/connectors.ts");
		const minted = await mintConnectorCredential(house.home, "telegram", { replace: true });
		await writeCompose(house, {
			connector: "telegram",
			image: "ghcr.io/example/mason-telegram:1.0.0",
			home,
			env: {
				MASON_CONNECTOR_URL: "ws://host.containers.internal:8787/api/connector",
				MASON_CONNECTOR_CREDENTIAL: minted.credential,
			},
		});
	}
	return house;
}

/** A runner that answers the version probes and reports one container in `state`. */
function runner(state: string | undefined): CommandRunner {
	return async (_command, argv) => {
		if (argv[0] === "ps") return { stdout: state === undefined ? "" : `mason-telegram\t${state}\n`, stderr: "" };
		return { stdout: "", stderr: "" };
	};
}

/** A prober with no user manager: no answer is not a complaint, so the boot-policy check passes. */
const noManager: Prober = async () => ({ code: 1, stdout: "", stderr: "no user manager" });

/** The doctor over one home, with the server check pinned to a port nothing listens on. */
async function doctor(house: HousePaths, options: { runner?: CommandRunner; credential?: boolean } = {}) {
	return runDoctor({
		house,
		env: { PORT: "1" },
		...(options.runner === undefined ? {} : { runner: options.runner }),
		probe: noManager,
	});
}

function check(checks: Awaited<ReturnType<typeof doctor>>, name: string) {
	const found = checks.find((entry) => entry.name === name);
	assert.ok(found !== undefined, `the report has a "${name}" check`);
	return found;
}

describe("the good fixture", () => {
	test("all nine pass, and the exit code is 0", async () => {
		const { house } = await goodBot();
		const checks = await doctor(house);
		assert.equal(checks.length, 9);
		assert.deepEqual(
			checks.filter((entry) => !entry.ok),
			[],
			checks.map(formatCheck).join("\n"),
		);
		assert.equal(doctorExitCode(checks), 0);
	});

	test("a credential is never printed", async () => {
		const root = await tempRoot();
		await writeCommonStore(root, { defaultProvider: "opencode-go", defaultModel: "deepseek", key: "sk-supersecret" });
		const home = join(root, "alice");
		const house = botPaths({ root, name: "alice", home });
		await ensureHouse(house, "a soul for the doctor");
		const text = (await doctor(house)).map(formatCheck).join("\n");
		assert.doesNotMatch(text, /sk-supersecret/);
		assert.match(text, /opencode-go\/deepseek, key stored/);
	});
});

describe("each failure names one repair", () => {
	test("a missing key names mason init", async () => {
		const root = await tempRoot();
		await writeCommonStore(root, { defaultProvider: "opencode-go", defaultModel: "deepseek" });
		const home = join(root, "alice");
		const house = botPaths({ root, name: "alice", home });
		await ensureHouse(house, "a soul for the doctor");
		const model = check(await doctor(house), "model");
		assert.equal(model.ok, false);
		assert.match(model.detail, /has no key/);
		assert.match(model.repair ?? "", /mason init/);
	});

	test("a bot override whose provider has no key fails the model check", async () => {
		const { house } = await goodBot();
		await writeFile(
			join(house.serviceDir, "settings.json"),
			JSON.stringify({ defaultProvider: "opencode-go", defaultModel: "deepseek" }),
		);
		const model = check(await doctor(house), "model");
		assert.equal(model.ok, false);
		assert.match(model.detail, /opencode-go\/deepseek from the bot's settings\.json has no key/);
		assert.match(model.repair ?? "", /mason init/);
	});

	test("an ssh runtime is reported as configured, not dialled", async () => {
		const { root, house } = await goodBot();
		await writeFile(commonPaths(root).runtime, JSON.stringify({ version: "0.1", kind: "ssh", host: "box" }));
		const runtime = check(await doctor(house), "runtime");
		assert.equal(runtime.ok, true);
		assert.match(runtime.detail, /ssh box, configured \(doctor does not open a session\)/);
	});

	test("an integration file changed since the boot says restart to apply", async () => {
		const { house } = await goodBot();
		await writeTextAtomic(
			bootRecordPath(house),
			JSON.stringify({
				version: "0.1",
				bootedAt: new Date().toISOString(),
				integrations: "a-hash-from-another-read",
			}),
		);
		const integrations = check(await doctor(house), "integrations");
		assert.equal(integrations.ok, false);
		assert.match(integrations.detail, /changed since the boot/);
		assert.match(integrations.repair ?? "", /restart to apply/);
	});

	test("a container that is not running names the command that starts it", async () => {
		const house = await containerBot("exited", true);
		const checks = await doctor(house, { runner: runner("exited") });
		const connectors = check(checks, "connectors");
		assert.equal(connectors.ok, false);
		assert.match(connectors.detail, /telegram: exited/);
		assert.match(connectors.repair ?? "", /podman compose -f .* up -d/);
	});

	test("a running container whose credential matches passes", async () => {
		const house = await containerBot("running", true);
		const connectors = check(await doctor(house, { runner: runner("running") }), "connectors");
		assert.equal(connectors.ok, true, connectors.detail);
		assert.match(connectors.detail, /telegram: up/);
	});

	test("a compose credential this home does not hold names mason setup", async () => {
		const house = await containerBot("running", false);
		const connectors = check(await doctor(house, { runner: runner("running") }), "connectors");
		assert.equal(connectors.ok, false);
		assert.match(connectors.detail, /credential is not one this home holds/);
		assert.match(connectors.repair ?? "", /mason setup --connector telegram/);
	});

	test("a home whose halves sit at the root names the move", async () => {
		const root = await tempRoot();
		const home = join(root, "alice");
		await mkdir(join(home, "agent"), { recursive: true, mode: 0o700 });
		await mkdir(join(home, "service"), { recursive: true, mode: 0o700 });
		await writeTextAtomic(join(home, "soul.md"), "a soul at the root");
		const house = botPaths({ root, name: "alice", home });
		const home_ = check(await doctor(house), "home");
		assert.equal(home_.ok, false);
		assert.match(home_.detail, /soul\.md/);
	});

	test("a bot with a container checks podman and the boot policy, and a bot without one does not", async () => {
		const console = await goodBot();
		assert.match(check(await doctor(console.house), "podman").detail, /no connector runs in a container/);
		const container = await containerBot("running", true);
		const failing: CommandRunner = async () => {
			throw new Error("podman: command not found");
		};
		const checks = await doctor(container, { runner: failing });
		assert.equal(check(checks, "podman").ok, false);
		assert.match(check(checks, "podman").detail, /podman is not installed/);
	});
});

describe("the boot's record", () => {
	test("the writer is what makes staleness visible: a recorded read passes, a changed file does not", async () => {
		const { house } = await goodBot();
		assert.match(check(await doctor(house), "integrations").detail, /not booted yet/);
		await recordIntegrationBoot(house);
		assert.match(check(await doctor(house), "integrations").detail, /unchanged since the last boot/);
		await writeIntegration(house, "console", {
			enabled: true,
			description: "a different line",
			connector: consoleGrant(),
		});
		const stale = check(await doctor(house), "integrations");
		assert.equal(stale.ok, false);
		assert.match(stale.detail, /changed since the boot/);
	});

	test("a boot writes the record, so the check is wired to the boot and not only to the writer", async () => {
		const { house } = await goodBot();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
			houseHome: house.home,
			storage: "memory",
			modelAccess: { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true },
		});
		await runtime.close();
		const boot = await readIntegrationBoot(house);
		assert.ok(boot !== undefined, "the boot recorded what it read");
		assert.equal(boot.integrations, await hashFile(house.integrations));
	});
});

describe("the report", () => {
	test("one line per check, a failure carrying its repair in the same line", async () => {
		const root = await tempRoot();
		await writeCommonStore(root, { defaultProvider: "opencode-go", defaultModel: "deepseek" });
		const home = join(root, "alice");
		const house = botPaths({ root, name: "alice", home });
		await ensureHouse(house, "a soul for the doctor");
		const lines = (await doctor(house)).map(formatCheck);
		assert.equal(lines.length, 9);
		assert.match(lines.find((line) => line.startsWith("[fail] model:")) ?? "", /\(repair: .*mason init.*\)/);
		assert.equal(doctorExitCode(await doctor(house)), 1);
		assert.match(lines.find((line) => line.startsWith("[ok] exit:")) ?? "", /this report exits 1/);
	});
});
