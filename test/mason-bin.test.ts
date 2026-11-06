/**
 * `bin/mason.ts` — the installed package's one command.
 *
 * Every command here is executed exactly as an operator types it, from the source the npm scripts run, and every home
 * is a temporary directory passed in `MASON_HOME`: the real one is never read, let alone written. What is pinned is
 * what survives a review of the subcommand set: usage names the closed set and none of the retired nouns, `onboard`
 * creates a house and mints a connector's credential exactly once, and a home from before the split is refused with
 * its names and nothing created.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { listConnectorCredentials } from "../src/server/connectors.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "bin", "mason.ts");

const homes: string[] = [];
after(async () => {
	for (const home of homes) await rm(home, { recursive: true, force: true });
});

async function tempHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "mason-bin-home-"));
	homes.push(home);
	return home;
}

/** Run `mason …` the way a person does, against one temporary home. A non-zero exit is a result, not an error. */
async function mason(args: readonly string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout } = await run(process.execPath, ["--experimental-strip-types", script, ...args], {
			cwd: root,
			env: { ...process.env, MASON_HOME: home },
			maxBuffer: 8 * 1024 * 1024,
		});
		return { code: 0, stdout, stderr: "" };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

test("usage() names the closed subcommand set, and none of the retired nouns", async () => {
	const result = await mason([], await tempHome());
	assert.equal(result.code, 1, "no command is usage, and usage is a refusal");
	for (const command of [
		"mason up",
		"mason onboard",
		"mason setup",
		"mason chat",
		"mason integration",
		"mason connector",
		"mason prompt",
		"mason surface",
		"mason eval",
	]) {
		assert.match(result.stdout, new RegExp(command.replace(" ", "\\s+")));
	}
	for (const retired of ["doctor", "token", "team", "person"]) {
		assert.doesNotMatch(result.stdout, new RegExp(`\\b${retired}\\b`), `${retired} went with the prune`);
	}
});

test("a command the set does not know is a refusal, not a default", async () => {
	const result = await mason(["frotz"], await tempHome());
	assert.equal(result.code, 1);
	assert.match(result.stdout, /usage: mason/);
});

test("onboard() creates a fresh home, prints the doors, and asks for a connector it cannot mint", async () => {
	const home = await tempHome();
	const result = await mason(["onboard"], home);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /no connector is granted yet/, "there is nothing to mint for yet");
	assert.match(result.stdout, /mason integration add/, "the next commands, not a blank file");
	assert.match(result.stdout, /\/api\/health/, "the one unauthenticated door");
	assert.match(result.stdout, /mason up/);
	assert.equal(existsSync(join(home, "service", "soul.md")), true, "the house was created");
	assert.equal(existsSync(join(home, "agent", "skills", "ocr", "SKILL.md")), true, "the shipped skills were seeded");
	assert.equal(existsSync(join(home, "service", "config.json")), false, "no credential minted when refused to");
});

test("onboard() mints one credential for an entry with a grant and none, then mints nothing twice", async () => {
	const home = await tempHome();
	await mkdir(join(home, "service"), { recursive: true });
	await writeFile(
		join(home, "service", "integrations.json"),
		JSON.stringify(
			{
				integrations: {
					"external-chat": {
						enabled: true,
						connector: { user: { owner: "u-1" } },
					},
				},
			},
			null,
			"\t",
		),
		{ mode: 0o600 },
	);
	const first = await mason(["onboard"], home);
	assert.equal(first.code, 0);
	assert.match(first.stdout, /masonc_/, "the credential itself, printed once");
	const credentials = await listConnectorCredentials(home);
	assert.equal(credentials.length, 1);

	const second = await mason(["onboard"], home);
	assert.equal(second.code, 0);
	assert.doesNotMatch(second.stdout, /masonc_/, "the credential only ever prints once");
	assert.match(second.stdout, /has a connector credential/, "what exists is named, not replaced");
	assert.equal((await listConnectorCredentials(home)).length, 1, "onboard is idempotent");
});

test("onboard() refuses a home from before the split, on its names, creating nothing", async () => {
	const home = await tempHome();
	await writeFile(join(home, "profile.md"), "# Denis\n", "utf8");
	const result = await mason(["onboard"], home);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /predates the split/);
	assert.match(result.stderr, /profile\.md/);
	assert.equal(existsSync(join(home, "agent")), false, "Nothing was created.");
});

test("a mapped command runs the same script the npm script runs", async () => {
	const home = await tempHome();
	const result = await mason(["integration", "list"], home);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /no integrations/, "the integration script's own words, not a new one's");
});
