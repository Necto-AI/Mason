/**
 * The temporary directory the MCP and permission tests share, and the rest of the scaffolding beside it.
 *
 * A test file imports this one: `fake-mcp.ts` is the same code without the test runner's cleanup, so a child process can
 * boot the runtime with it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

export * from "./fake-mcp.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

/** A directory that exists for this file's tests and is removed when the file is done. */
export async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-mcp-"));
	directories.add(directory);
	return directory;
}
