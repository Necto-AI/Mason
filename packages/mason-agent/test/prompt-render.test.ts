/**
 * `npm run prompt` is the render a pull request reads to see the prompt it changed (#180), and it costs nothing
 * durable. The one directory it does write through is temporary: a boot writes `routines-state.json` into a data
 * directory, the render points that at `$TMPDIR/mason-prompt-XXXXXXXX`, and the directory went on existing after the
 * render returned (#182).
 *
 * The child process is the check, not a copy of the code: the script is driven the way a person drives it, over a
 * scratch `$TMPDIR` of the test's own, so what the render leaves behind is exactly what is in that directory.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

test("a render removes its temporary data directory", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "mason-render-scratch-"));
	try {
		// The home is inside the scratch space too, so nothing of the operator's is read, and the only paths under it
		// that could be called a render's are the ones the render made.
		const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: scratch };
		for (const name of ["MASON_HOME", "MASON_ROOT", "MASON_DATA"]) delete env[name];
		const { stdout } = await run(
			process.execPath,
			[
				"--experimental-strip-types",
				join(root, "scripts", "prompt.ts"),
				`--home=${join(scratch, "home")}`,
				"--json",
			],
			{ env },
		);
		const rendered = JSON.parse(stdout) as { readonly sections: readonly unknown[] };
		assert.ok(rendered.sections.length > 0, "the render happened, so a data directory was made");
		assert.deepEqual(
			(await readdir(scratch)).filter((name) => name.startsWith("mason-prompt-")),
			[],
			"the data directory is removed when the render ends, instead of left in $TMPDIR",
		);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});
