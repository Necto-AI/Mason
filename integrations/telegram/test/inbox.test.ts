/**
 * The inbox: the one filesystem writer in this package, and the two promises behind it — a file lands where a payload
 * says it does, and a volume nobody watches does not fill.
 *
 * The directory here is real, because the question *did it land* is a question about a filesystem and a fake would answer
 * it too easily. Telegram is scripted instead: each test says what `getFile` and the download answer, so the paths
 * through this file are one sequence of answers rather than a mock of a client.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Attachment } from "../src/filter.ts";
import { Inbox, RETENTION_MS, type FileSource } from "../src/inbox.ts";
import { createLog } from "../src/log.ts";
import type { TelegramFile } from "../src/telegram.ts";

const directories = new Set<string>();
const DAY_MS = 24 * 60 * 60 * 1_000;
/** A mebibyte, because the cap and the fixture both state themselves in one of these. */
const MIB = 1024 * 1024;

after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

/** A throwaway root, never the developer's home: the whole volume of one test. */
async function tempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mason-inbox-"));
	directories.add(root);
	return root;
}

/** A megabyte of nothing in particular: the tests are about sizes and names, not about what a PDF contains. */
function bytes(size: number): Uint8Array {
	return new Uint8Array(size).fill(0x25);
}

/** What Telegram answered, and every call made — so "refused without downloading" is an assertion rather than trust. */
class ScriptedFiles implements FileSource {
	readonly asked: string[] = [];
	readonly downloaded: { readonly filePath: string }[] = [];
	readonly #file: TelegramFile | Error;
	readonly #body: Uint8Array | Error;

	constructor(file: TelegramFile | Error, body: Uint8Array | Error) {
		this.#file = file;
		this.#body = body;
	}

	async getFile(options: { readonly fileId: string }): Promise<TelegramFile> {
		this.asked.push(options.fileId);
		if (this.#file instanceof Error) throw this.#file;
		return this.#file;
	}

	async downloadFile(options: { readonly filePath: string }): Promise<Uint8Array> {
		this.downloaded.push({ filePath: options.filePath });
		if (this.#body instanceof Error) throw this.#body;
		return this.#body;
	}
}

interface Rig {
	readonly inbox: Inbox;
	readonly files: ScriptedFiles;
	/** The inbox directory itself, which is where a payload's path points. */
	readonly dir: string;
	readonly lines: string[];
	/** The inbox's own clock, which is what the retention is measured against. */
	at(): number;
}

/** A throwaway volume, a scripted Telegram and a clock the test holds: no network, and no real week. */
async function rig(file: TelegramFile | Error, body: Uint8Array | Error): Promise<Rig> {
	const dir = join(await tempRoot(), "inbox");
	await mkdir(dir);
	const files = new ScriptedFiles(file, body);
	const lines: string[] = [];
	const now = Date.parse("2026-10-26T12:00:00Z");
	const inbox = new Inbox({
		api: files,
		dir,
		log: createLog([], (line) => lines.push(line)),
		now: () => now,
	});
	return {
		inbox,
		files,
		dir,
		lines,
		at: () => now,
	};
}

function attachment(overrides: Partial<Attachment> = {}): Attachment {
	return { fileId: "f1", name: "report.pdf", kind: "document", size: 4_096, ...overrides };
}

describe("saving an attachment", () => {
	it("writes <update_id>-<name> with mode 0600 and answers the path a payload names", async () => {
		const { inbox, dir } = await rig({ filePath: "documents/report.pdf", fileSize: 4 }, bytes(4));

		const outcome = await inbox.save(attachment(), { updateId: 448_860_480 });

		assert.deepEqual(outcome, {
			kind: "saved",
			file: {
				path: join(dir, "448860480-report.pdf"),
				name: "448860480-report.pdf",
				size: 4,
				kind: "document",
			},
		});
		assert.deepEqual([...(await readFile(join(dir, "448860480-report.pdf")))], [0x25, 0x25, 0x25, 0x25]);
		assert.equal((await stat(join(dir, "448860480-report.pdf"))).mode & 0o777, 0o600);
	});

	it("creates the directory on the first file, because a fresh volume has none", async () => {
		const root = await tempRoot();
		const fresh = join(root, "inbox");
		const inbox = new Inbox({
			api: new ScriptedFiles({ filePath: "photos/a.jpg" }, bytes(2)),
			dir: fresh,
			log: createLog([], () => {}),
		});

		const outcome = await inbox.save(attachment({ name: "photo-u1.jpg", kind: "photo" }), { updateId: 1 });

		assert.equal(outcome.kind, "saved");
		assert.deepEqual(await readdir(fresh), ["1-photo-u1.jpg"]);
	});

	it("downloads the path getFile named, not the file id it was asked about", async () => {
		const { inbox, files } = await rig({ filePath: "documents/report.pdf" }, bytes(2));

		await inbox.save(attachment(), { updateId: 1 });

		assert.deepEqual(files.asked, ["f1"]);
		assert.deepEqual(files.downloaded, [{ filePath: "documents/report.pdf" }]);
	});

	it("keeps two files sent under one name apart, because the update id prefixes both", async () => {
		const { inbox, dir } = await rig({ filePath: "documents/report.pdf" }, bytes(2));

		await inbox.save(attachment(), { updateId: 10 });
		await inbox.save(attachment(), { updateId: 11 });

		assert.deepEqual((await readdir(dir)).sort(), ["10-report.pdf", "11-report.pdf"]);
	});
});

describe("a file Telegram will not hand over", () => {
	it("refuses a 21 MiB file by size, before it downloads a byte of it", async () => {
		const { inbox, files, dir } = await rig({ filePath: "videos/huge.mov", fileSize: 21 * MIB }, bytes(1));

		const outcome = await inbox.save(attachment({ name: "huge.mov", kind: "video" }), { updateId: 7 });

		assert.equal(outcome.kind, "refused");
		assert.match(outcome.kind === "refused" ? outcome.reason : "", /21 MiB, and a bot may download 20 MiB/);
		assert.deepEqual(files.downloaded, [], "the size was known, so nothing had to be fetched to find out");
		assert.deepEqual(await readdir(dir), []);
	});

	it("refuses the same file when Telegram sent no size and the bytes turned out too many", async () => {
		const { inbox, dir } = await rig({ filePath: "voice/huge.oga" }, bytes(21 * MIB));

		const outcome = await inbox.save(attachment({ name: "voice-u1.ogg", kind: "voice", size: undefined }), {
			updateId: 8,
		});

		assert.equal(outcome.kind, "refused");
		assert.deepEqual(await readdir(dir), [], "a file over the cap never reaches the volume, not even briefly");
	});

	it("leaves nothing behind when the download fails, and says what failed", async () => {
		const { inbox, dir } = await rig({ filePath: "documents/report.pdf" }, new Error("connect ECONNREFUSED"));

		const outcome = await inbox.save(attachment(), { updateId: 9 });

		assert.equal(outcome.kind, "refused");
		assert.match(outcome.kind === "refused" ? outcome.reason : "", /the download failed: connect ECONNREFUSED/);
		assert.deepEqual(await readdir(dir), []);
	});

	it("says so in a line rather than throwing when Telegram will not name the file", async () => {
		const { inbox } = await rig(new Error("Telegram getFile failed (400): Bad Request"), bytes(1));

		const outcome = await inbox.save(attachment(), { updateId: 10 });

		assert.equal(outcome.kind, "refused");
		assert.match(outcome.kind === "refused" ? outcome.reason : "", /would not name it/);
	});
});

describe("the name a file is written under", () => {
	it("takes the last path segment, so a name cannot walk out of the inbox", async () => {
		const { inbox, dir } = await rig({ filePath: "documents/passwd" }, bytes(2));

		await inbox.save(attachment({ name: "../../etc/passwd" }), { updateId: 3 });
		await inbox.save(attachment({ name: "a/b" }), { updateId: 4 });

		assert.deepEqual((await readdir(dir)).sort(), ["3-passwd", "4-b"]);
	});

	it("drops a leading dot, a control character and a trailing .part, and never writes an empty name", async () => {
		const { inbox, dir } = await rig({ filePath: "documents/x" }, bytes(2));

		await inbox.save(attachment({ name: ".bashrc" }), { updateId: 5 });
		await inbox.save(attachment({ name: "re\u0000port.pdf" }), { updateId: 6 });
		await inbox.save(attachment({ name: "report.pdf.part" }), { updateId: 7 });
		await inbox.save(attachment({ name: ".." }), { updateId: 8 });

		assert.deepEqual((await readdir(dir)).sort(), ["5-bashrc", "6-report.pdf", "7-report.pdf", "8-file"]);
	});

	it("caps a long name, so a path in a payload stays a path and not a paragraph", async () => {
		const { inbox, dir } = await rig({ filePath: "documents/x" }, bytes(2));

		const outcome = await inbox.save(attachment({ name: `${"a".repeat(400)}.pdf` }), { updateId: 11 });

		const [name] = await readdir(dir);
		assert.ok(name !== undefined && Buffer.byteLength(name, "utf8") <= "11-".length + 200);
		// The promise the whole branch makes: the path in the payload is a path on disk.
		assert.equal(outcome.kind, "saved");
		if (outcome.kind === "saved") assert.equal((await stat(outcome.file.path)).isFile(), true);
	});

	it("caps a Cyrillic name by bytes, not by characters, because the filesystem counts bytes", async () => {
		const { inbox, dir } = await rig({ filePath: "documents/x" }, bytes(2));

		// 120 Cyrillic characters are 240 bytes: over the cap, and ordinary enough to arrive from a Russian phone.
		const outcome = await inbox.save(attachment({ name: `${"ж".repeat(120)}.pdf` }), { updateId: 12 });

		assert.equal(outcome.kind, "saved", "an ordinary non-Latin name must not be ENAMETOOLONG");
		const [name] = await readdir(dir);
		assert.ok(name !== undefined && Buffer.byteLength(name, "utf8") <= "12-".length + 200);
	});

	it("never cuts a surrogate pair in half, so every path it answers is a file that exists", async () => {
		const { inbox, dir } = await rig({ filePath: "documents/x" }, bytes(2));

		// An emoji is two UTF-16 units. Cutting on units can end the name in half of one, which is a path no file has.
		const outcome = await inbox.save(attachment({ name: `${"😀".repeat(200)}.pdf` }), { updateId: 13 });

		assert.equal(outcome.kind, "saved");
		if (outcome.kind !== "saved") return;
		assert.equal((await stat(outcome.file.path)).isFile(), true);
		assert.deepEqual(await readdir(dir), [outcome.file.name]);
		// `toWellFormed` asks the question exactly: a well-formed string carries no half of a pair.
		assert.equal(outcome.file.name, outcome.file.name.toWellFormed());
	});
});

describe("the sweep", () => {
	/** A file on the volume, exactly `ageMs` old as the filesystem sees it — an mtime is what a sweep reads. */
	async function aged(dir: string, name: string, now: number, ageMs: number): Promise<void> {
		const path = join(dir, name);
		await writeFile(path, "old");
		const stamp = (now - ageMs) / 1_000;
		await utimes(path, stamp, stamp);
	}

	it("deletes a file older than a week and keeps one from yesterday", async () => {
		const { inbox, dir, at } = await rig({ filePath: "documents/x" }, bytes(2));
		await aged(dir, "8-report.pdf", at(), 8 * DAY_MS);
		await aged(dir, "1-report.pdf", at(), DAY_MS);

		await inbox.sweep();

		assert.deepEqual(await readdir(dir), ["1-report.pdf"]);
	});

	it("sweeps on write, so the volume is cleaned by the traffic it gets rather than by a timer", async () => {
		const { inbox, dir, at } = await rig({ filePath: "documents/x" }, bytes(2));
		await aged(dir, "old-report.pdf", at(), RETENTION_MS + 1);

		await inbox.save(attachment(), { updateId: 12 });

		assert.deepEqual(await readdir(dir), ["12-report.pdf"]);
	});

	it("deletes the oldest files once the volume is over its ceiling, even when nothing is a week old", async () => {
		const root = await tempRoot();
		const now = Date.now();
		// Four files of 1 KiB, the ceiling at 2 KiB: age says keep them all, size says keep two.
		for (const [name, ageMs, size] of [
			["1-oldest", 4_000, 1_024],
			["2-next", 3_000, 1_024],
			["3-newer", 2_000, 1_024],
			["4-newest", 1_000, 1_024],
		] as const) {
			const path = join(root, name);
			await writeFile(path, bytes(size));
			const stamp = (now - ageMs) / 1_000;
			await utimes(path, stamp, stamp);
		}
		const lines: string[] = [];
		const inbox = new Inbox({
			api: new ScriptedFiles({ filePath: "documents/x" }, bytes(2)),
			dir: root,
			now: () => now,
			maxBytes: 2 * 1_024,
			log: createLog([], (line) => lines.push(line)),
		});

		await inbox.sweep();

		assert.deepEqual((await readdir(root)).sort(), ["3-newer", "4-newest"], "oldest first, and the newest always survives");
		assert.match(lines.join("\n"), /deleted 2 file\(s\) and 1 MiB/);
	});

	it("leaves a directory and a symlink alone, because a sweep is not a delete somewhere else", async () => {
		const root = await tempRoot();
		await mkdir(join(root, "a-directory"));
		await writeFile(join(root, "target"), "x");
		await symlink(join(root, "target"), join(root, "a-link"));
		const inbox = new Inbox({
			api: new ScriptedFiles({ filePath: "documents/x" }, bytes(2)),
			dir: root,
			log: createLog([], () => {}),
		});

		await inbox.sweep();

		assert.deepEqual((await readdir(root)).sort(), ["a-directory", "a-link", "target"]);
	});

	it("is never a failed message: a volume it cannot read is one line, and the refusal says the rest", async () => {
		const root = await tempRoot();
		// A file where the inbox should be: `readdir` answers ENOTDIR and nothing can be made of it.
		const broken = join(root, "not-a-directory");
		await writeFile(broken, "");
		const lines: string[] = [];
		const inbox = new Inbox({
			api: new ScriptedFiles({ filePath: "documents/x" }, bytes(2)),
			dir: broken,
			log: createLog([], (line) => lines.push(line)),
		});

		const outcome = await inbox.save(attachment(), { updateId: 13 });

		assert.equal(outcome.kind, "refused");
		assert.match(lines.join("\n"), /could not read the inbox at .*not-a-directory/);
	});
});
