/**
 * The volume: two files, written whole, readable only by the owner.
 *
 * The modes are asserted because the offset file is the only thing in this container that is worth anything to a second
 * process, and the failure this rules out is a volume that arrives world-readable and stays that way. The atomicity is
 * not observable in a test — that is the rename's job — but "a flood of writes leaves one valid file" is, and it is the
 * shape a crash produces.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { StateFiles } from "../src/state.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-telegram-state-"));
	directories.add(directory);
	return directory;
}

describe("the offset file", () => {
	it("is absent on a volume that has never been written, which is what starts a first boot from now", async () => {
		assert.equal(await new StateFiles(await workspace()).readOffset(), undefined);
	});

	it("is written 0600 in a 0700 directory, and read back as the number it was", async () => {
		const directory = await workspace();
		const state = new StateFiles(join(directory, "data"));

		await state.writeOffset(8_811);

		const path = join(directory, "data", "offset.json");
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(join(directory, "data"))).mode & 0o777, 0o700);
		assert.equal(await state.readOffset(), 8_811);
	});

	it("overwrites in place, leaving one file and no temporary beside it", async () => {
		const directory = await workspace();
		const state = new StateFiles(directory);

		for (let offset = 1; offset <= 5; offset += 1) await state.writeOffset(offset);

		assert.deepEqual(await readdir(directory), ["offset.json"]);
		assert.equal(await state.readOffset(), 5);
	});

	it("re-applies 0600 to a file that arrived permissive", async () => {
		const directory = await workspace();
		const state = new StateFiles(directory);
		await state.writeOffset(1);
		await chmod(join(directory, "offset.json"), 0o644);

		await state.writeOffset(2);

		assert.equal((await stat(join(directory, "offset.json"))).mode & 0o777, 0o600);
	});

	it("refuses a file that is not an offset rather than reading one it does not understand", async () => {
		const directory = await workspace();
		await writeFile(join(directory, "offset.json"), JSON.stringify({ offset: "yesterday" }));

		await assert.rejects(() => new StateFiles(directory).readOffset(), /no integer "offset"/);
	});
});

describe("the chat list", () => {
	it("is empty on a fresh volume and round-trips what it was given", async () => {
		const directory = await workspace();
		const state = new StateFiles(directory);
		const chats = [{ id: "-1001234", title: "Team chat", type: "supergroup" }];

		assert.deepEqual(await state.readChats(), []);
		await state.writeChats(chats);
		assert.deepEqual(await state.readChats(), chats);
		assert.match(await readFile(join(directory, "chats.json"), "utf8"), /Team chat/);
	});

	it("drops an entry that is not a chat rather than handing it to the model", async () => {
		const directory = await workspace();
		await writeFile(
			join(directory, "chats.json"),
			JSON.stringify({ chats: [{ id: "-1", title: "ok", type: "group" }, { id: 5 }, "nonsense"] }),
		);

		assert.deepEqual(await new StateFiles(directory).readChats(), [{ id: "-1", title: "ok", type: "group" }]);
	});
});
