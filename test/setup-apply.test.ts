/**
 * `src/setup/apply.ts` — one call makes what the plan decided true.
 *
 * The tests apply real plans to a temporary home with `noopRunner`, so most of them need no podman and start nothing: what
 * is pinned is what `mason setup` has always written — the grant, the credential's hash, the project, the record — plus
 * the two promises that make a second run safe, the note that names a home the boot will refuse when a write makes a
 * second enabled user grant, and the order the failures keep: the record is written even when the start did not happen,
 * and the failure comes back afterwards. The two tests that do start ask a runner that records the one call, and a
 * `podman` shim first on `PATH` so the checks before the start answer yes.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, test } from "node:test";
import { composePath, projectName, readComposeCredential } from "../src/server/connector-compose.ts";
import { listConnectorCredentials } from "../src/server/connectors.ts";
import { housePaths } from "../src/server/house.ts";
import { readInstalls } from "../src/server/install-state.ts";
import { assertOneUserGrant, readIntegrations, userGrantNames, writeIntegration } from "../src/server/integrations.ts";
import { applyPlan, type PlanNote } from "../src/setup/apply.ts";
import { type ConnectorAnswers, type MintedCredential, planConnector } from "../src/setup/plan.ts";
import { noopRunner, type Runner } from "../src/setup/runner.ts";
import { TELEGRAM_CATALOG } from "./support/catalog.ts";

const homes: string[] = [];
after(async () => {
	for (const home of homes) await rm(home, { recursive: true, force: true });
});

async function emptyHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "mason-apply-"));
	homes.push(home);
	return home;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** A mint with a fixed answer, so the files this run writes are the same on every machine. */
function fixedMint(plaintext: string, id: string) {
	return (connector: string): MintedCredential => ({
		plaintext,
		record: { id, connector, sha256: sha256(plaintext), createdAt: "2026-01-01T00:00:00.000Z" },
	});
}

/** The answers a `--yes` run of telegram gives. */
const telegram: ConnectorAnswers = {
	kind: "catalog",
	name: "telegram",
	env: { TELEGRAM_BOT_TOKEN: "123:fake", TELEGRAM_ALLOWED_CHATS: "8811" },
	owner: "8811",
};

/** Only the command's own words: the two `value` lines are the credential itself, and a test does not read those twice. */
const advice = (notes: readonly PlanNote[]): string[] =>
	notes.filter((note) => note.kind === "advice").map((note) => note.text);

/** A runner that records what it was asked to start: the call it was asked for, or the empty list it was not. */
function recordingRunner(): { readonly runner: Runner; readonly calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		runner: {
			up: async (composeFile, project) => {
				calls.push(`${composeFile} ${project}`);
				return "started";
			},
		},
	};
}

/**
 * A `podman` first on `PATH`, so the checks `applyPlan` makes before a start answer yes.
 *
 * A start asks `podman --version` and `podman compose version` first, and this machine may have neither: the shim is the
 * only thing that makes "the runner was asked" a test that runs anywhere. It answers the two checks and is never asked
 * to start anything, because the runner is.
 */
async function withPodmanOnPath<T>(body: () => Promise<T>): Promise<T> {
	const bin = await mkdtemp(join(tmpdir(), "mason-podman-shim-"));
	await writeFile(join(bin, "podman"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	const before = process.env.PATH;
	process.env.PATH = `${bin}${delimiter}${before ?? ""}`;
	try {
		return await body();
	} finally {
		if (before === undefined) delete process.env.PATH;
		else process.env.PATH = before;
		await rm(bin, { recursive: true, force: true });
	}
}

/** Runs with `HOST` set, and puts it back: the loopback refusal is the process's, and a leak would be the next test's. */
async function withHost<T>(host: string, body: () => Promise<T>): Promise<T> {
	const before = process.env.HOST;
	process.env.HOST = host;
	try {
		return await body();
	} finally {
		if (before === undefined) delete process.env.HOST;
		else process.env.HOST = before;
	}
}

describe("applying a plan", () => {
	test("writes the grant, the credential, the project and the record, and starts nothing", async () => {
		const home = await emptyHome();
		const paths = housePaths(home);
		const plan = await planConnector(telegram, paths, {
			catalog: TELEGRAM_CATALOG,
			mint: fixedMint("masonc_written", "con_written"),
		});

		const applied = await applyPlan(plan, { runner: noopRunner, start: false });

		const { integrations } = await readIntegrations(paths);
		assert.equal(integrations.telegram?.enabled, true);
		assert.deepEqual(integrations.telegram?.connector, plan.grant);
		// The value is printed and the hash is kept: the store must not hold the credential itself.
		const issued = await listConnectorCredentials(paths.home);
		assert.deepEqual(
			issued.map((record) => record.id),
			["con_written"],
		);
		assert.doesNotMatch(await readFile(paths.config, "utf8"), /masonc_written/);
		// The project the container would be started from carries the same value.
		const value = await readComposeCredential(composePath(paths, "telegram"));
		assert.equal(value, "masonc_written");
		assert.equal(sha256(value ?? ""), issued[0]?.sha256);

		const record = (await readInstalls(paths)).connectors.telegram;
		assert.equal(record?.source, plan.source);
		assert.equal(record?.image, plan.image);
		assert.equal(record?.project, projectName(home, "telegram"));
		assert.equal(record?.started, false, "--no-start says the files are there and the container is not");
		assert.match(record?.createdAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

		assert.deepEqual(applied.written, [composePath(paths, "telegram")]);
		assert.equal(applied.credential, "minted");
		assert.equal(applied.started, false);
		assert.equal(applied.failure, undefined);
		// The notes are the command's output, in the order it has always printed it.
		assert.deepEqual(advice(applied.notes), [
			`wrote the grant for "telegram" to ${paths.integrations}`,
			`minted connector credential con_written (stored as a hash in ${paths.config})`,
			`wrote ${composePath(paths, "telegram")}`,
			`--no-start: nothing was started. When mason is up: podman compose -f ${composePath(paths, "telegram")} -p ${projectName(home, "telegram")} up -d`,
		]);
		// The value travels between them, and nowhere else.
		assert.deepEqual(
			applied.notes.filter((note) => note.kind === "value").map((note) => note.text),
			["masonc_written", "this is the only time it is printed."],
		);
		// The lock is released and no store is left half-written.
		assert.equal((await readdir(paths.serviceDir)).filter((name) => name.endsWith(".lock")).length, 0);
	});

	test("a second run mints nothing, rewrites nothing, and keeps the record's birthday", async () => {
		const home = await emptyHome();
		const paths = housePaths(home);
		const start = { runner: noopRunner, start: false };
		const first = await applyPlan(
			await planConnector(telegram, paths, { catalog: TELEGRAM_CATALOG, mint: fixedMint("masonc_one", "con_one") }),
			start,
		);
		assert.equal(first.credential, "minted");
		const grant = await readFile(paths.integrations, "utf8");
		const config = await readFile(paths.config, "utf8");
		const record = await readFile(paths.connectors, "utf8");

		// A different mint, to prove it is never called: the credential the home holds is the one the project carries.
		const again = await applyPlan(
			await planConnector(telegram, paths, { catalog: TELEGRAM_CATALOG, mint: fixedMint("masonc_two", "con_two") }),
			start,
		);

		assert.deepEqual(advice(again.notes), [
			`"telegram" is already granted in ${paths.integrations}; the grant is unchanged`,
			`"telegram" already has connector credential con_one; nothing minted`,
			`${composePath(paths, "telegram")} is up to date`,
			`--no-start: nothing was started. When mason is up: podman compose -f ${composePath(paths, "telegram")} -p ${projectName(home, "telegram")} up -d`,
		]);
		assert.equal(again.credential, undefined);
		assert.deepEqual(again.written, [], "nothing to write is nothing written");
		assert.equal(await readFile(paths.integrations, "utf8"), grant);
		assert.equal(await readFile(paths.config, "utf8"), config);
		assert.equal(await readFile(paths.connectors, "utf8"), record, "the record's createdAt is the first run's");
		assert.equal((await listConnectorCredentials(paths.home)).length, 1);
	});

	test("a start that cannot happen still leaves the record written, and the failure comes back after it", async () => {
		const home = await emptyHome();
		const paths = housePaths(home);
		const plan = await planConnector(telegram, paths, {
			catalog: TELEGRAM_CATALOG,
			mint: fixedMint("masonc_boom", "con_boom"),
		});
		const { runner, calls } = recordingRunner();
		// mason is bound to loopback by default, and a container cannot reach it: the start refuses before the runner is
		// asked to do anything, which is the failure that leaves a record saying the files are there.
		const previous = process.env.HOST;
		process.env.HOST = "127.0.0.1";
		let applied: Awaited<ReturnType<typeof applyPlan>>;
		try {
			applied = await applyPlan(plan, { runner, start: true });
		} finally {
			if (previous === undefined) delete process.env.HOST;
			else process.env.HOST = previous;
		}

		assert.ok(applied.failure instanceof Error);
		assert.match((applied.failure as Error).message, /HOST=0\.0\.0\.0 mason up/);
		assert.deepEqual(calls, [], "a runner that was never asked");
		const record = (await readInstalls(paths)).connectors.telegram;
		assert.equal(record?.started, false, "the record is the one thing a failed start still writes");
		assert.equal(record?.source, plan.source);
		assert.deepEqual(applied.written, [composePath(paths, "telegram")], "and the files came first");
		assert.ok(
			advice(applied.notes).some((note) => note.startsWith("wrote ")),
			"the notes say what landed",
		);
	});

	test("a start the plan asks for is one call to the runner, and the record says it started", async () => {
		const home = await emptyHome();
		const paths = housePaths(home);
		const plan = await planConnector(telegram, paths, {
			catalog: TELEGRAM_CATALOG,
			mint: fixedMint("masonc_started", "con_started"),
		});
		const { runner, calls } = recordingRunner();
		// A reachable bind and a podman that answers the two checks: this is the start a machine that can run it makes.
		const applied = await withPodmanOnPath(() => withHost("0.0.0.0", () => applyPlan(plan, { runner, start: true })));

		assert.deepEqual(calls, [`${composePath(paths, "telegram")} ${projectName(home, "telegram")}`]);
		assert.equal(applied.started, true);
		assert.equal(applied.failure, undefined);
		assert.ok(advice(applied.notes).includes(`started project ${projectName(home, "telegram")}`));
		const record = (await readInstalls(paths)).connectors.telegram;
		assert.equal(record?.started, true, "the record says the container is up, or the next setup starts it again");
	});

	test("a runner that rejects still leaves the record written, and the failure comes back after it", async () => {
		const home = await emptyHome();
		const paths = housePaths(home);
		const plan = await planConnector(telegram, paths, {
			catalog: TELEGRAM_CATALOG,
			mint: fixedMint("masonc_rejected", "con_rejected"),
		});
		const boom = new Error("podman compose -f promote -p telegram up -d exited 125: no provider");
		const applied = await withPodmanOnPath(() =>
			withHost("0.0.0.0", () =>
				applyPlan(plan, {
					runner: {
						up: async () => {
							throw boom;
						},
					},
					start: true,
				}),
			),
		);

		assert.equal(applied.failure, boom, "the start's own error, not a wrapper around it");
		assert.equal(applied.started, false);
		assert.deepEqual(applied.written, [composePath(paths, "telegram")], "and the files came first");
		const record = (await readInstalls(paths)).connectors.telegram;
		assert.equal(record?.source, plan.source, "the record is the one thing a failed start still writes");
		assert.equal(record?.project, projectName(home, "telegram"));
		assert.equal(record?.started, false);
	});

	test("a failed image pull is reported as a pull, and writes no record that says installed", async () => {
		const home = await emptyHome();
		const paths = housePaths(home);
		const plan = await planConnector(telegram, paths, {
			catalog: TELEGRAM_CATALOG,
			mint: fixedMint("masonc_pull", "con_pull"),
		});
		// The shape of the error a private ghcr image gives: `compose up` exits 125 with podman's pull refusal.
		const pulled = new Error(
			"podman compose -f promote -p telegram up -d exited 125: Error: initializing source " +
				"docker://ghcr.io/denissud/mason-telegram:0.2.0: reading manifest 0.2.0 in " +
				"ghcr.io/denissud/mason-telegram: unauthorized: authentication required",
		);
		const applied = await withPodmanOnPath(() =>
			withHost("0.0.0.0", () =>
				applyPlan(plan, {
					runner: {
						up: async () => {
							throw pulled;
						},
					},
					start: true,
				}),
			),
		);

		assert.ok(applied.failure instanceof Error);
		const line = applied.failure.message;
		// The line a stranger reads names the image with its tag, the host it came from, and the two repairs that fit.
		assert.match(line, /could not pull ghcr\.io\/denissud\/mason-telegram:0\.2\.0 from ghcr\.io/);
		assert.match(line, /podman login ghcr\.io/);
		assert.match(line, /check the image name/);
		assert.equal(applied.failure.cause, pulled, "podman's own words travel as the cause");
		assert.equal(applied.started, false);
		// The files and the grant stay, so a retry does not mint a second credential — and nothing on disk says the
		// connector is installed, which is what `mason doctor` would otherwise read as a stopped container.
		assert.deepEqual(applied.written, [composePath(paths, "telegram")], "the project stays for the retry");
		assert.equal(await readFile(paths.connectors, "utf8").catch(() => undefined), undefined);
		assert.equal((await readInstalls(paths)).connectors.telegram, undefined);
	});

	test("a file that is already there is kept when the plan says only if missing", async () => {
		const home = await emptyHome();
		const paths = housePaths(home);
		const plan = await planConnector(telegram, paths, {
			catalog: TELEGRAM_CATALOG,
			mint: fixedMint("masonc_kept", "con_kept"),
		});
		const kept = join(paths.serviceDir, "operator.json");
		await mkdir(paths.serviceDir, { recursive: true });
		await writeFile(kept, "the operator's own");

		const applied = await applyPlan(
			{ ...plan, writes: [{ path: kept, text: "rendered", onlyIfMissing: true }] },
			{
				runner: noopRunner,
				start: false,
			},
		);

		assert.equal(await readFile(kept, "utf8"), "the operator's own");
		assert.deepEqual(applied.written, []);
		assert.ok(advice(applied.notes).includes(`${kept} is already there and is kept`));
	});

	test("a credential the project no longer holds is rotated, and the store it replaced is kept beside it", async () => {
		const home = await emptyHome();
		const paths = housePaths(home);
		const start = { runner: noopRunner, start: false };
		await applyPlan(
			await planConnector(telegram, paths, {
				catalog: TELEGRAM_CATALOG,
				mint: fixedMint("masonc_first", "con_first"),
			}),
			start,
		);
		const config = await readFile(paths.config, "utf8");
		// The plaintext the container was given is gone: only the hash in the home says what it was.
		await rm(composePath(paths, "telegram"));

		const applied = await applyPlan(
			await planConnector(telegram, paths, {
				catalog: TELEGRAM_CATALOG,
				mint: fixedMint("masonc_second", "con_second"),
			}),
			start,
		);

		assert.equal(applied.credential, "rotated");
		assert.ok(
			advice(applied.notes).includes(
				`no credential this home holds was in ${composePath(paths, "telegram")}, so one was minted: con_second`,
			),
		);
		assert.equal(await readComposeCredential(composePath(paths, "telegram")), "masonc_second");
		const live = (await listConnectorCredentials(paths.home)).map((record) => record.id);
		assert.deepEqual(live, ["con_second"], "the credential nobody holds any more is retired in the same write");
		// `updateConfig` stages the file it replaces: a setup that went wrong costs one `.bak`, not a configuration.
		const staged = (await readdir(paths.serviceDir)).filter((name) => /^config\.json\..*\.bak$/.test(name));
		assert.equal(staged.length, 1);
		assert.equal(
			await readFile(join(paths.serviceDir, staged[0] ?? ""), "utf8"),
			config,
			"the copy is the store as it was, so a rotation is undoable",
		);
	});

	test("a second enabled connector that carries a person's words is named as a home the boot will refuse", async () => {
		const home = await emptyHome();
		const paths = housePaths(home);
		const start = { runner: noopRunner, start: false };
		const first = await applyPlan(
			await planConnector(telegram, paths, {
				catalog: TELEGRAM_CATALOG,
				mint: fixedMint("masonc_solo", "con_solo"),
			}),
			start,
		);
		assert.ok(
			!advice(first.notes).some((note) => note.includes("person's words")),
			"one enabled grant is the shape a home is for, so the first install says nothing about the rule",
		);

		// The second install is what the operator asked for, and the write lands: the refusal is the boot's, not this.
		const applied = await applyPlan(
			await planConnector(
				{ kind: "url", name: "custom", url: "ws://127.0.0.1:9999/api/connector", owner: "denis", events: {} },
				paths,
				{ mint: fixedMint("masonc_second", "con_second") },
			),
			start,
		);

		const { integrations } = await readIntegrations(paths);
		assert.deepEqual(userGrantNames(integrations), ["custom", "telegram"], "the file holds the two grants");
		// The command says what its own write made, before `mason up` is the first to say it.
		assert.ok(
			advice(applied.notes).includes(
				`this home grants a person's words to "custom" and "telegram": one bot works for one person, so mason ` +
					"refuses this home at boot until one of them is switched off, by hand",
			),
			advice(applied.notes).join("\n"),
		);
		// And it is the boot's own rule: the state the note describes is the state `assertOneUserGrant` refuses.
		assert.throws(
			() => assertOneUserGrant(paths.integrations, integrations),
			/at most one enabled connector may carry a person's words/,
		);
	});

	test("an events-only neighbour is not a second surface, and the write says nothing about the rule", async () => {
		const home = await emptyHome();
		const paths = housePaths(home);
		// A connector granted by hand that only raises events: no `connector.user`, so it is not where an answer arrives.
		await writeIntegration(paths, "alarm", {
			enabled: true,
			connector: { events: { hooks: { "alarm.ringing": "workspace-check" } } },
		});

		const applied = await applyPlan(
			await planConnector(
				{ kind: "url", name: "custom", url: "ws://127.0.0.1:9999/api/connector", owner: "denis", events: {} },
				paths,
				{ mint: fixedMint("masonc_alone", "con_alone") },
			),
			{ runner: noopRunner, start: false },
		);

		const { integrations } = await readIntegrations(paths);
		assert.deepEqual(userGrantNames(integrations), ["custom"], "the events face carries nobody's words");
		assert.ok(
			!advice(applied.notes).some((note) => note.includes("person's words")),
			"this home boots, so there is nothing to warn about on the way in",
		);
		assert.doesNotThrow(() => assertOneUserGrant(paths.integrations, integrations));
	});
});
