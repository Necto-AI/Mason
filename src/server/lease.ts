/**
 * The per-checkout write lease: one write-capable child at a time on one checkout, refused rather than queued.
 *
 * A child that may write works in a real checkout, and two of them writing at once is the one thing the delegation
 * cannot make safe: `git status` in one would report the other's half-done edit, and a review pass that started before
 * the implement pass settled would read a tree that is still moving. So a write-capable child takes the checkout's lease
 * for its run and gives it back at settlement, and the next writer — the review pass, the next slice, the parent once
 * its child is done — proceeds. Nothing is ever queued behind it: a second writer that arrives while the lease is held
 * is refused with a sentence naming who holds it, because a tool call that waits an unknown time is worse for a turn
 * than one that is told to come back.
 *
 * Four decisions this file makes, and why each is not the store lock (`atomic.ts`):
 *
 * - **The key is the checkout, not a file in it.** `atomic.ts` locks one store under the home for the length of a write,
 *   with a 50 × 20 ms wait and a 30 s staleness reaper. A child's run is minutes long, so the wait is wrong (refuse), the
 *   reaper is wrong (never by age), and the path is wrong.
 * - **The lock file is outside the checkout, and outside the home.** A child that writes tools reports `git status`, and a
 *   lease file inside the tree it leases is noise in the one output the person reads. The directory is machine-wide and per
 *   user — under the temp dir — so two bots serving one checkout from two homes name the same file; a directory under one
 *   bot's `dataDir` would give each bot its own lock and call that exclusion. A lease cannot outlive a reboot, which is
 *   the right lifetime for one.
 * - **Refused, not reaped.** A holder that is provably gone — same host, a pid that no longer exists — is cleared and the
 *   caller retries once. Nothing is cleared because it is old: a child that has been thinking for ten minutes is a child
 *   that is still writing, and the whole point of the lease is that nobody guesses otherwise.
 * - **Released by token.** The lease file carries a token this holder generated; release unlinks it only when the file
 *   still carries that token, so a release that arrives after a stale-clear and a re-acquire cannot steal the new
 *   writer's lease.
 */
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** What a lease file says: who holds the checkout, and since when. A sentence about it is built from these fields. */
export interface LeaseHolder {
	readonly token: string;
	/** The process that holds it. A pid is only meaningful on the host beside it. */
	readonly pid: number;
	readonly host: string;
	readonly checkout: string;
	readonly startedAt: string;
	/** What holds it, for the refusal: a tool call's role, or a test's name for itself. */
	readonly writer: string;
}

/** One held lease. `release` is idempotent and safe to call in a `finally`. */
export interface WriteLease {
	/** The checkout as it was resolved when the lease was taken. */
	readonly checkout: string;
	/** The file that is the lease, so a test can look at what a refusal is about. */
	readonly path: string;
	release(): Promise<void>;
}

/** Either the lease, or who has it: `undefined` only when the file vanished between the attempt and the read. */
export type LeaseResult =
	| { readonly held: true; readonly lease: WriteLease }
	| { readonly held: false; readonly holder: LeaseHolder | undefined };

/**
 * The one directory leases live in: outside every checkout and outside every home, scoped to the user, so every process
 * on this machine that leases the same checkout names the same file.
 */
export function leaseDirOf(): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : "user";
	return join(tmpdir(), `mason-leases-${uid}`);
}

/**
 * The lease file for one checkout: its realpath, hashed, so `~/dev/x` and `/home/me/dev/x` and a symlink to either are
 * one checkout with one lease. A path that does not exist has no realpath, and is resolved as given: refusing to lease a
 * checkout that is not there is the caller's job, because only the caller knows whether that matters.
 */
export async function leasePath(dir: string, checkout: string): Promise<string> {
	const canonical = await realpath(checkout).catch(() => resolve(checkout));
	return join(dir, `${createHash("sha256").update(canonical).digest("hex")}.lease`);
}

/** Whether a process on this host still exists. `EPERM` is alive: it is somebody else's, not a corpse. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: unknown }).code !== "ESRCH";
	}
}

/** The holder a lease file names, or `undefined` when it cannot be read as one (which is never treated as free). */
async function holderOf(path: string): Promise<LeaseHolder | undefined> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const holder = parsed as Partial<LeaseHolder>;
	if (typeof holder.pid !== "number" || typeof holder.host !== "string" || typeof holder.token !== "string")
		return undefined;
	return holder as LeaseHolder;
}

/**
 * Whether the holder is provably gone: the same host, and a pid that no longer exists. Age is never a reason, and a
 * holder on another host is never provable from here.
 */
function abandoned(holder: LeaseHolder): boolean {
	return holder.host === hostname() && !alive(holder.pid);
}

/**
 * Take the checkout's lease, or answer who has it.
 *
 * The write is one `link`, which is the whole mutual exclusion: two callers racing get one file and one `EEXIST`, and the
 * loser never touches what the winner wrote. The file is staged complete beside it first, so a lease on disk always has a
 * holder in it or is cleared as debris. A holder that is provably gone is cleared and retried
 * once — the crash of a previous process is the only way a lease outlives its run, and the retry is bounded so a
 * perpetual race cannot spin.
 */
export async function acquireWriteLease(input: {
	readonly checkout: string;
	readonly dir: string;
	readonly writer: string;
}): Promise<LeaseResult> {
	await mkdir(input.dir, { recursive: true, mode: 0o700 });
	const path = await leasePath(input.dir, input.checkout);
	const canonical = await realpath(input.checkout).catch(() => resolve(input.checkout));
	const token = randomUUID();
	const lease: LeaseHolder = {
		token,
		pid: process.pid,
		host: hostname(),
		checkout: canonical,
		startedAt: new Date().toISOString(),
		writer: input.writer,
	};
	for (let attempt = 0; attempt < 2; attempt += 1) {
		// `link` is the mutual exclusion and it lands a complete file: an `O_EXCL` write is a create and a write, so a
		// holder that dies between them leaves a lease no reader can name and no run behind it — and nothing reaps it.
		const staged = join(input.dir, `.${token}.staged`);
		await writeFile(staged, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
		try {
			await link(staged, path);
			let released = false;
			return {
				held: true,
				lease: {
					checkout: canonical,
					path,
					async release() {
						if (released) return;
						released = true;
						await releaseIfOurs(path, token);
					},
				},
			};
		} catch (error) {
			if ((error as { code?: unknown }).code !== "EEXIST") throw error;
			const holder = await holderOf(path);
			// Unreadable is not held: a file with no holder in it is one whose writer never finished announcing itself. A
			// readable one is cleared only when its holder is provably gone, and either way the retry is bounded.
			if (attempt === 0 && (holder === undefined || abandoned(holder))) {
				if (holder === undefined) await unlink(path).catch(() => undefined);
				else await releaseIfOurs(path, holder.token);
				continue;
			}
			return { held: false, holder };
		} finally {
			await unlink(staged).catch(() => undefined);
		}
	}
	return { held: false, holder: await holderOf(path) };
}

/** Unlink a lease file when it still carries `token`: the only way a release can be sure it is its own. */
async function releaseIfOurs(path: string, token: string): Promise<void> {
	const holder = await holderOf(path);
	if (holder === undefined || holder.token !== token) return;
	await unlink(path).catch(() => undefined);
}

/** What a refusal says: who holds the checkout, and that coming back later is the answer. */
export function leaseRefusalText(holder: LeaseHolder | undefined): string {
	if (holder === undefined) return "another writer holds this checkout's write lease and it could not be read";
	const since = Date.parse(holder.startedAt);
	const minutes = Number.isFinite(since) ? Math.max(0, Math.round((Date.now() - since) / 60_000)) : 0;
	return `another writer holds the write lease for ${holder.checkout}: ${holder.writer}, pid ${holder.pid} on ${holder.host}, held for ${minutes} min. Wait for it to settle and call delegate again; the lease is not a queue`;
}
