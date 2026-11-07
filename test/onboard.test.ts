/**
 * `mason onboard` — a first run driven exactly as CI drives it: the installed command, no terminal, no network.
 *
 * `PI_FAUX_MODEL=1` is what makes this a proof rather than a mock: `mason init` still verifies with one completion, it
 * is just the offline provider answering, the same switch `evals/` uses. Everything else is real — the root, the common
 * store, the bot's home, the grant, the credential hash, the nine checks.
 *
 * The three criteria from #147 this file pins: a clean machine finishes a first run and ends green; the second run asks
 * nothing about providers or keys and adds nothing twice; and a second bot is created, listed and targeted (`-b` over
 * `MASON_BOT` over the only bot over a refusal that names them).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "bin", "mason.ts");

const roots: string[] = [];
after(async () => {
	for (const directory of roots) await rm(directory, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-onboard-"));
	roots.push(directory);
	return directory;
}

/** The child's environment: one temporary root, offline, no port, and none of this process's own model choice. */
function childEnv(directory: string, extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		MASON_ROOT: directory,
		MASON_HOME: "",
		PORT: "1",
		PI_FAUX_MODEL: "1",
		...extra,
	};
	// The agent running the tests exports its own provider and model; a test that inherited them would be reading the
	// ambient machine instead of the root it built.
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	return env;
}

/** `mason …` against one temporary root, offline, on a port nothing listens on. */
async function mason(
	args: readonly string[],
	directory: string,
	extra: Readonly<Record<string, string>> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await run(process.execPath, ["--experimental-strip-types", script, ...args], {
			cwd: root,
			env: childEnv(directory, extra),
			maxBuffer: 8 * 1024 * 1024,
		});
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

/** A script run the way `npm run …` runs it: no wrapper, so the flag the usage advertises is the script's own. */
async function runScript(
	name: string,
	args: readonly string[],
	directory: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await run(
			process.execPath,
			["--experimental-strip-types", join(root, "scripts", `${name}.ts`), ...args],
			{
				cwd: root,
				env: childEnv(directory),
				maxBuffer: 8 * 1024 * 1024,
			},
		);
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

describe("a first run on a clean root", () => {
	test("initialises the root, creates a bot with a connector, and ends in a green doctor", async () => {
		const directory = await tempRoot();
		const first = await mason(["onboard", "--yes", "--connector", "console"], directory);
		assert.equal(first.code, 0, first.stderr || first.stdout);
		assert.match(first.stdout, /the provider answered/);
		assert.match(first.stdout, /9 checks: 9 ok, 0 failed/);
		assert.match(first.stdout, /mason up -b bot/);

		const settings = JSON.parse(await readFile(join(directory, "common", "settings.json"), "utf8")) as Record<
			string,
			unknown
		>;
		assert.equal(settings.defaultProvider, "faux");
		const grant = JSON.parse(await readFile(join(directory, "bot", "service", "integrations.json"), "utf8")) as {
			version?: string;
			integrations: Record<string, { connector?: { user?: { owner?: string } } }>;
		};
		assert.equal(grant.version, "0.1");
		assert.equal(grant.integrations.console?.connector?.user?.owner, "local");
		assert.equal(
			existsSync(join(directory, "bot", "service", "config.json")),
			true,
			"the credential is stored as a hash",
		);
	});

	test("a second run asks nothing, mints nothing and adds nothing twice", async () => {
		const directory = await tempRoot();
		assert.equal((await mason(["onboard", "--yes", "--connector", "console"], directory)).code, 0);
		const second = await mason(["onboard", "--yes"], directory);
		assert.equal(second.code, 0, second.stderr || second.stdout);
		assert.match(second.stdout, /nothing asked about providers or keys/);
		assert.match(second.stdout, /already granted: console/);
		assert.doesNotMatch(second.stdout, /masonc_/, "no credential is printed a second time");
		assert.match(second.stdout, /9 checks: 9 ok, 0 failed/);
	});
});

describe("a fleet of two", () => {
	test("mason new creates the second bot, bots lists both, and no target refuses with the names", async () => {
		const directory = await tempRoot();
		assert.equal((await mason(["onboard", "--yes", "--connector", "console"], directory)).code, 0);
		const created = await mason(["new", "alice", "--yes", "--connector", "console", "--no-start"], directory);
		assert.equal(created.code, 0, created.stderr || created.stdout);
		assert.equal(
			existsSync(join(directory, "alice", "agent", "profile.md")),
			false,
			"a fresh home has no profile yet",
		);

		const listed = await mason(["bots"], directory);
		assert.equal(listed.code, 0);
		assert.match(listed.stdout, /^alice\t/m);
		assert.match(listed.stdout, /^bot\t/m);
		assert.doesNotMatch(listed.stdout, /\(current\)/, "two bots and no target is no target");

		const untargeted = await mason(["doctor"], directory);
		assert.equal(untargeted.code, 1);
		assert.match(untargeted.stderr, /holds 2 bots: alice, bot/);
		assert.match(untargeted.stderr, /-b <name>/);

		const targeted = await mason(["doctor", "-b", "alice"], directory);
		assert.equal(targeted.code, 0, targeted.stdout);
		assert.match(targeted.stdout, /9 checks: 9 ok, 0 failed/);

		const marked = await mason(["bots", "-b", "alice"], directory);
		assert.match(marked.stdout, /^alice\t.*\(current\)$/m);

		const viaEnv = await mason(["status"], directory, { MASON_BOT: "alice" });
		assert.equal(viaEnv.code, 0);
		assert.match(viaEnv.stdout, /^bot alice \(/);
		assert.match(viaEnv.stdout, /model faux\/faux-1/);
		assert.match(viaEnv.stdout, /1 integration, 1 connector/);
		assert.match(viaEnv.stdout, /mason not running/);
	});

	test("the npm path takes -b too: the scripts parse the flag they advertise", async () => {
		const directory = await tempRoot();
		assert.equal((await mason(["onboard", "--yes", "--connector", "console"], directory)).code, 0);
		assert.equal((await mason(["new", "alice", "--yes", "--connector", "console", "--no-start"], directory)).code, 0);

		const doctor = await runScript("doctor", ["-b", "alice"], directory);
		assert.equal(doctor.code, 0, doctor.stderr);
		assert.match(doctor.stdout, /9 checks: 9 ok, 0 failed/);

		const status = await runScript("status", ["-b", "alice"], directory);
		assert.equal(status.code, 0, status.stderr);
		assert.match(status.stdout, /^bot alice \(/);
	});

	test("status reads no pi store for a bot: with the common settings gone the model is none", async () => {
		const directory = await tempRoot();
		assert.equal((await mason(["onboard", "--yes", "--connector", "console"], directory)).code, 0);
		assert.equal((await mason(["new", "alice", "--yes", "--connector", "console", "--no-start"], directory)).code, 0);
		await rm(join(directory, "common", "settings.json"));
		const status = await mason(["status", "-b", "alice"], directory);
		assert.equal(status.code, 0, status.stderr);
		// The faux switch is on in this test's environment, so the line names what a turn would run *and* what the store
		// holds: the configured model is none, and pi's own store is never the fallback for a bot under a root.
		assert.match(status.stdout, /configured none\/none/);
		assert.doesNotMatch(status.stdout, /pi's settings\.json/);
	});

	test("a bot with no common store refuses new, and says which command writes one", async () => {
		const directory = await tempRoot();
		const result = await mason(["new", "alice", "--yes", "--connector", "console"], directory);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /has no common store/);
		assert.match(result.stderr, /mason init/);
	});
});
