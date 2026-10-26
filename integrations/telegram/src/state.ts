/**
 * The volume: two small files, written whole.
 *
 * `offset.json` is the trigger face's memory of how far it has read, and it is the one file whose loss replays a day of
 * chat into the agent. `chats.json` is what `list_chats` answers from, so the agent can name a chat without a human
 * pasting an id.
 *
 * Both are written the same way — as JSON to a temporary in the same directory, renamed over the target — for the reason
 * `src/server/atomic.ts` writes mason's own state that way: a crash between two writes leaves the previous file rather
 * than half of this one. The mode is set after the rename rather than trusted from it (`writeFile`'s `mode` applies only
 * to a file it creates), because a volume that arrives with a permissive umask must not decide this.
 *
 * Copied from mason's implementation rather than imported: this container is a package of its own, built and published
 * on its own, and an import across the repository boundary would tie its release to mason's source tree.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const OFFSET_FILE = "offset.json";
export const CHATS_FILE = "chats.json";

/** A write that failed is a caller's problem, and the one thing it must never be is silent. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
	await chmod(dirname(path), 0o700).catch(() => {});
	await chmod(path, 0o600).catch(() => {});
}

/** A missing file is an answer here, and a file that will not parse is not: the second is corruption, not a first boot. */
async function readJson(path: string): Promise<unknown> {
	const text = await readFile(path, "utf8").catch((error: unknown) => {
		if ((error as { code?: unknown }).code === "ENOENT") return undefined;
		throw error;
	});
	if (text === undefined) return undefined;
	return JSON.parse(text) as unknown;
}

/** One chat the poller has seen and the allowlist admits, as `list_chats` shows it. */
export interface SeenChat {
	/** Telegram's chat id, as a string: it is a 64-bit signed number and a payload is a string. */
	readonly id: string;
	readonly title: string;
	readonly type: string;
}

/**
 * The offset and the chat list, both optional on a first boot and both required to survive a restart by being written
 * before the next batch is read.
 */
export class StateFiles {
	readonly #directory: string;

	constructor(directory: string) {
		this.#directory = directory;
	}

	/**
	 * The next update to ask for, or undefined when this instance has never read one. Undefined is what tells the poller
	 * to discard the backlog: a container that restarted an hour later must start from now, not from its last message.
	 */
	async readOffset(): Promise<number | undefined> {
		const parsed = await readJson(join(this.#directory, OFFSET_FILE));
		if (parsed === undefined) return undefined;
		if (typeof parsed !== "object" || parsed === null) {
			throw new Error(`${join(this.#directory, OFFSET_FILE)} is not a JSON object`);
		}
		const offset = (parsed as { offset?: unknown }).offset;
		if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
			throw new Error(`${join(this.#directory, OFFSET_FILE)} has no integer "offset"`);
		}
		return offset;
	}

	async writeOffset(offset: number): Promise<void> {
		await writeJsonAtomic(join(this.#directory, OFFSET_FILE), { offset });
	}

	async readChats(): Promise<SeenChat[]> {
		const parsed = await readJson(join(this.#directory, CHATS_FILE));
		if (parsed === undefined) return [];
		if (typeof parsed !== "object" || parsed === null) {
			throw new Error(`${join(this.#directory, CHATS_FILE)} is not a JSON object`);
		}
		const chats = (parsed as { chats?: unknown }).chats;
		if (!Array.isArray(chats)) throw new Error(`${join(this.#directory, CHATS_FILE)} has no "chats" array`);
		return chats.filter((chat): chat is SeenChat => {
			const candidate = chat as Partial<SeenChat> | null;
			return (
				typeof candidate === "object" &&
				candidate !== null &&
				typeof candidate.id === "string" &&
				typeof candidate.title === "string" &&
				typeof candidate.type === "string"
			);
		});
	}

	async writeChats(chats: readonly SeenChat[]): Promise<void> {
		await writeJsonAtomic(join(this.#directory, CHATS_FILE), { chats });
	}
}
