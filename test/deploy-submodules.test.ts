import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `deploy/submodules.sh` runs on the host, inside the deployment checkout, and it is the only thing that moves
 * `vendor/pi` to the commit the checked-out ref pins. Issue #84 is what happens without it: the image is built from
 * the previous submodule and the log says nothing, and a checkout that was copied rather than cloned cannot even
 * report its own state.
 *
 * The fixtures are a real pair of repositories, because the failure is in what git does, not in what this repo thinks
 * git does: an outer repo whose submodule pin moves, and a deployment cloned from it.
 */
const SCRIPT = join(dirname(dirname(fileURLToPath(import.meta.url))), "deploy", "submodules.sh");

const identity = {
	GIT_AUTHOR_NAME: "mason test",
	GIT_AUTHOR_EMAIL: "test@example.invalid",
	GIT_COMMITTER_NAME: "mason test",
	GIT_COMMITTER_EMAIL: "test@example.invalid",
	// The rehearsal clones from local paths; a deployment clones over https, where git asks nothing.
	GIT_ALLOW_PROTOCOL: "file",
};

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity } });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
	return result.stdout.trim();
}

async function write(cwd: string, name: string, contents: string): Promise<void> {
	await writeFile(join(cwd, name), contents);
	git(cwd, "add", ".");
	git(cwd, "commit", "-qm", name);
}

describe("deploy/submodules.sh", () => {
	let root: string;
	let outer: string;
	let first = "";
	let second = "";

	before(async () => {
		root = await mkdtemp(join(tmpdir(), "mason-submodules-"));
		const inner = join(root, "inner");
		await mkdir(inner);
		git(inner, "init", "-q", "-b", "main");
		await write(inner, "f", "one");
		first = git(inner, "rev-parse", "--short", "HEAD");
		await write(inner, "f", "two");
		second = git(inner, "rev-parse", "--short", "HEAD");

		outer = join(root, "outer");
		await mkdir(outer);
		git(outer, "init", "-q", "-b", "main");
		git(outer, "submodule", "add", "-q", inner, "vendor/pi");
		git(outer, "commit", "-qm", "add the submodule");
		// One commit pinning the first generation, one pinning the second: a deployment that moves between them is the
		// case that used to build from the wrong pi.
		git(join(outer, "vendor", "pi"), "checkout", "-q", first);
		git(outer, "add", "vendor/pi");
		git(outer, "commit", "-qm", "pin the first");
		git(join(outer, "vendor", "pi"), "checkout", "-q", second);
		git(outer, "add", "vendor/pi");
		git(outer, "commit", "-qm", "pin the second");
	});

	after(async () => {
		await rm(root, { recursive: true, force: true });
	});

	async function deployment(name: string): Promise<string> {
		const path = join(root, name);
		git(root, "clone", "-q", "--recursive", outer, path);
		return path;
	}

	function run(path: string): string {
		const result = spawnSync("bash", [SCRIPT], { cwd: path, encoding: "utf8", env: { ...process.env, ...identity } });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout;
	}

	test("moves the submodule to the commit the ref pins", async () => {
		const path = await deployment("moving-pin");
		git(path, "checkout", "-q", "--detach", "HEAD~1");

		// Without the step, this is what the deployment runs: the previous generation, with the new ref's tag on it.
		assert.equal(git(join(path, "vendor", "pi"), "rev-parse", "--short", "HEAD"), second);

		const output = run(path);
		assert.equal(git(join(path, "vendor", "pi"), "rev-parse", "--short", "HEAD"), first);
		assert.match(output, new RegExp(`^\\s+vendor/pi ${first}$`, "m"));
	});

	test("repairs a checkout whose submodule gitfile points nowhere", async () => {
		const path = await deployment("dangling-gitfile");
		await rm(join(path, ".git", "modules", "vendor", "pi"), { recursive: true, force: true });
		const broken = spawnSync("git", ["-C", "vendor/pi", "rev-parse", "--git-dir"], { cwd: path, encoding: "utf8" });
		assert.notEqual(broken.status, 0, "the gitfile was supposed to dangle");

		const output = run(path);
		assert.equal(git(join(path, "vendor", "pi"), "rev-parse", "--short", "HEAD"), second);
		assert.match(output, /is there but is not its own repository/);
		// The point of the repair: the deployment can report what it runs again.
		assert.equal(git(path, "status", "--porcelain"), "");
	});

	test("replaces a plain directory with the pinned submodule", async () => {
		const path = await deployment("plain-directory");
		await rm(join(path, "vendor", "pi"), { recursive: true, force: true });
		await rm(join(path, ".git", "modules", "vendor", "pi"), { recursive: true, force: true });
		await mkdir(join(path, "vendor", "pi"));
		await writeFile(join(path, "vendor", "pi", "junk"), "not a repository\n");

		run(path);
		assert.equal(git(join(path, "vendor", "pi"), "rev-parse", "--short", "HEAD"), second);
		assert.throws(() => git(join(path, "vendor", "pi", "junk"), "status"), "the junk file is gone");
	});

	test("puts back a submodule that was moved by hand", async () => {
		const path = await deployment("tampered");
		git(join(path, "vendor", "pi"), "checkout", "-q", first);

		run(path);
		assert.equal(git(join(path, "vendor", "pi"), "rev-parse", "--short", "HEAD"), second);
	});
});
