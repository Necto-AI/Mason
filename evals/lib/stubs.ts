/**
 * Stub tools: the four coding tools, answering from the scenario instead of from a machine.
 *
 * Deterministic by construction — no shell, no filesystem, no network, no cleanup — and that is what makes an
 * assertion like "it read the file before it claimed the number" mean something. The tools keep the real names,
 * descriptions and parameters, so the model sees the same declarations it sees in production; only `execute` differs.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { Scenario } from "./scenario.ts";

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }], details: {} });
const failed = (value: string) => ({ output: [{ type: "text" as const, text: value }], details: {}, isError: true });

/** Files under these roots are read for real: the agent's own home and workspace, both temp directories. */
export function StubTools(scenario: Scenario, roots: readonly string[] = []) {
	const workspace = roots[roots.length - 1] ?? process.cwd();
	const files = [...Object.keys(scenario.home ?? {}), ...(scenario.stubs?.read ?? []).map((entry) => entry.path)];
	const bash = defineTool({
		name: "bash",
		description: "Run a shell command and return its output.",
		parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
		replay: "unsafe",
		execute: async (args: { command: string }) => {
			const match = scenario.stubs?.bash?.find((entry) => args.command.includes(entry.match));
			if (match !== undefined) return text(match.result);
			// A shell that answers nothing reads as broken, and a model that believes its shell is broken spends the
			// turn probing it instead of doing the task. Answer the probes a shell answers, and fail the rest the way a
			// shell fails, so the model switches tools instead of retrying the same one.
			const command = args.command.trim();
			const echo = /^echo\s+(?:"([^"]*)"|'([^']*)'|(.*))$/.exec(command);
			if (echo !== null) return text(echo[1] ?? echo[2] ?? echo[3] ?? "");
			if (/^pwd\b/.test(command) || /^cd\b/.test(command)) return text(workspace);
			if (/^ls\b/.test(command)) return text([...files, "log", "workspace"].join("\n"));
			// `cat` reads the same files `read` does, stubbed or real, so a shell-minded model finds the answer on the
			// first try instead of concluding the machine is empty.
			const cat = /^cat\s+(.+)$/.exec(command);
			if (cat !== null) {
				const target = (cat[1] ?? "").split(/\s+/)[0] ?? "";
				const stub = scenario.stubs?.read?.find((entry) => target.endsWith(entry.path));
				const content = stub?.result ?? (await readInside(roots, target));
				return content === undefined ? failed(`cat: ${target}: No such file or directory`) : text(content);
			}
			if (/^(command\s+-v|which|type)\b/.test(command)) return failed("exit status 1");
			return failed("exit status 127: command not found");
		},
	});

	const read = defineTool({
		name: "read",
		description: "Read a text file and return its contents.",
		parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()) }),
		replay: "safe",
		execute: async (args: { path: string }) => {
			// A stub file answers to its name and to any path that ends in that name: a model that prefixes the
			// workspace directory is doing what a real machine would reward.
			const match = scenario.stubs?.read?.find(
				(entry) => args.path === entry.path || args.path.endsWith(`/${entry.path}`),
			);
			if (match !== undefined) return text(match.result);
			// The agent's own files are real: a log it just wrote must be readable, or "remember, then recall" could
			// only be tested by lying. Only the temp home and workspace are reachable.
			const real = await readInside(roots, args.path);
			return text(real ?? `ENOENT: no such file: ${args.path}`);
		},
	});

	const write = defineTool({
		name: "write",
		description: "Write a text file.",
		parameters: Type.Object({ path: Type.String(), content: Type.String() }),
		replay: "unsafe",
		execute: async (args: { path: string; content: string }) => {
			return text(`Wrote ${args.path}`);
		},
	});

	/**
	 * Read a real file from the temp home or workspace. A relative path is tried in every root, workspace first: the
	 * shell starts in the workspace, but `read` is given names like `profile.md` that live in the home, and a stub that
	 * silently resolves those to the wrong directory looks to the model like a missing file.
	 */
	async function readInside(allowed: readonly string[], path: string): Promise<string | undefined> {
		const candidates = isAbsolute(path) ? [resolve(path)] : [...allowed].reverse().map((root) => resolve(root, path));
		for (const target of candidates) {
			if (!allowed.some((root) => !relative(root, target).startsWith(".."))) continue;
			try {
				return await readFile(target, "utf8");
			} catch {}
		}
		return undefined;
	}

	const edit = defineTool({
		name: "edit",
		description: "Apply a text replacement to a file.",
		parameters: Type.Object({
			path: Type.String(),
			edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
		}),
		replay: "unsafe",
		execute: async (_args: unknown) => {
			return text("Edited.");
		},
	});

	return defineExtension({ name: "stub-tools", tools: [bash, read, write, edit] });
}
