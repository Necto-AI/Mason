/**
 * The per-checkout write lease: one writer, refused rather than queued, released at settlement.
 *
 * The unit is a checkout, not a home: two bots with two data directories can work on one tree, so the key is the
 * checkout's realpath and the file lives outside the tree it leases — a writer that reports `git status` must not find
 * the lease in its own output. Nothing here is reaped by age: a stale holder is one whose process is gone, and a child
 * that has been thinking for ten minutes is a child that is still writing.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { acquireWriteLease, leaseDirOf, leasePath, leaseRefusalText } from "../src/server/lease.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function workspace(prefix: string): Promise<{ directory: string; checkout: string; dir: string }> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	const checkout = join(directory, "checkout");
	await mkdir(checkout, { recursive: true });
	await writeFile(join(checkout, "README.md"), "# checkout\n");
	return { directory, checkout, dir: leaseDirOf(join(directory, "data")) };
}

test("one holder: a second writer is refused, and admitted once the first releases", async () => {
	const { checkout, dir } = await workspace("mason-lease-");
	const first = await acquireWriteLease({ checkout, dir, writer: "implement" });
	assert.equal(first.held, true);

	const second = await acquireWriteLease({ checkout, dir, writer: "review" });
	assert.equal(second.held, false, "refused, not queued");
	assert.equal(second.held === false ? second.holder?.writer : undefined, "implement");
	assert.match(leaseRefusalText(second.held === false ? second.holder : undefined), /holds the write lease/);

	if (first.held) await first.lease.release();
	const third = await acquireWriteLease({ checkout, dir, writer: "review" });
	assert.equal(third.held, true, "released at settlement, admitted at once");
	if (third.held) await third.lease.release();
});

test("the key is the checkout's realpath, and the file is outside the checkout", async () => {
	const { directory, checkout, dir } = await workspace("mason-lease-key-");
	const link = join(directory, "link");
	await symlink(checkout, link);
	assert.equal(await leasePath(dir, checkout), await leasePath(dir, link), "a symlink is one checkout");

	const taken = await acquireWriteLease({ checkout: link, dir, writer: "one" });
	assert.equal(taken.held, true);
	if (!taken.held) return;
	assert.equal(basename(dirname(taken.lease.path)), basename(dir), "the lease lives in the lease directory");
	assert.deepEqual(await readdir(checkout), ["README.md"], "and nothing is written into the checkout");
	const other = await acquireWriteLease({ checkout, dir, writer: "two" });
	assert.equal(other.held, false, "the other spelling of the same checkout is the same lease");
	await taken.lease.release();
});

test("a holder whose process is gone is cleared; a live one is never cleared by age", async () => {
	const { checkout, dir } = await workspace("mason-lease-stale-");
	await mkdir(dir, { recursive: true });
	const path = await leasePath(dir, checkout);
	const long = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();

	// A day old and held by a pid that does not exist: the previous process crashed mid-run, and the next writer goes.
	await writeFile(
		path,
		JSON.stringify({ token: "gone", pid: 999_999, host: hostname(), checkout, startedAt: long, writer: "dead" }),
	);
	const afterCrash = await acquireWriteLease({ checkout, dir, writer: "next" });
	assert.equal(afterCrash.held, true, "a provably gone holder does not block the next writer");
	if (afterCrash.held) await afterCrash.lease.release();

	// A day old and held by this process: still held. Age is not evidence that a writer stopped writing.
	await writeFile(
		path,
		JSON.stringify({ token: "alive", pid: process.pid, host: hostname(), checkout, startedAt: long, writer: "live" }),
	);
	const blocked = await acquireWriteLease({ checkout, dir, writer: "next" });
	assert.equal(blocked.held, false, "a live holder is never reaped by age");
	assert.equal(blocked.held === false ? blocked.holder?.writer : undefined, "live");

	// Another host is never provable from here, so it is held.
	await writeFile(
		path,
		JSON.stringify({ token: "remote", pid: 999_999, host: "elsewhere", checkout, startedAt: long, writer: "ssh" }),
	);
	const remote = await acquireWriteLease({ checkout, dir, writer: "next" });
	assert.equal(remote.held, false, "a holder on another host is not provably gone");
});

test("a release only removes the lease it took", async () => {
	const { checkout, dir } = await workspace("mason-lease-token-");
	const mine = await acquireWriteLease({ checkout, dir, writer: "mine" });
	assert.equal(mine.held, true);
	if (!mine.held) return;
	assert.match(await readFile(mine.lease.path, "utf8"), /"mine"/);
	// Somebody else's lease, at the same path: the stale-clear-and-reacquire window a token closes.
	await writeFile(
		mine.lease.path,
		JSON.stringify({ token: "other", pid: process.pid, host: hostname(), checkout, startedAt: "", writer: "other" }),
	);
	await mine.lease.release();
	assert.equal(
		(await acquireWriteLease({ checkout, dir, writer: "third" })).held,
		false,
		"the other holder's lease survived my release",
	);
});
