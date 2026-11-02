/**
 * Prove the SDK as a stranger gets it.
 *
 * Build the two packages, pack them, install the tarballs into an empty temporary project, and run the published
 * conformance suite there with plain `node` — no `--conditions=source`, no `--experimental-strip-types`, no path into
 * mason's tree. The project lives outside the repository on purpose: a relative import that worked from inside would be
 * exactly the bug this check exists to catch.
 *
 * It also fails if an installed package ships a `.ts` file, because a consumer's Node refuses to strip types inside
 * `node_modules`, and an SDK that only runs from source is not a published SDK.
 *
 * Run with `npm run prove:connector`. It writes nothing into the repository.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

const FIXTURE = `import { runConformance } from "@mason/connector/testkit";

const chat = {
	name: "external-chat",
	version: "0.1.0",
	faces: {
		user: {
			actors: [{ externalActorId: "u-1", displayName: "Denis" }],
			conversations: [{ externalConversationId: "-100", kind: "room" }],
			capabilities: ["text", "files", "approvals", "streaming"],
		},
		tools: { url: "https://external.internal/mcp" },
		events: { "chat.message": "chat-message" },
	},
	state: ["status"],
};

const toolsOnly = { name: "external-calculator", version: "0.1.0", faces: { tools: { url: "https://calc.internal/mcp" } } };
const eventsOnly = { name: "external-alarm", version: "0.1.0", faces: { events: { "alarm.ringing": "alarm-ringing" } } };

const results = [];
for (const fixture of [chat, toolsOnly, eventsOnly]) {
	const run = await runConformance(fixture);
	results.push({ name: fixture.name, passed: run.passed.length, skipped: run.skipped.length, failed: run.failed.length,
		errors: run.failed.map((failure) => failure.name + ": " + failure.error.message) });
}

const failed = results.filter((result) => result.failed > 0);
console.log(JSON.stringify(results, null, 2));
if (failed.length > 0) {
	console.error("conformance failed outside mason");
	process.exit(1);
}
if (results.some((result) => result.passed === 0)) {
	console.error("a fixture passed no case at all");
	process.exit(1);
}
console.log("PROOF OK: " + results.map((result) => result.name + " " + result.passed + " passed").join(", "));
`;

async function main(): Promise<void> {
	const workspace = await mkdtemp(join(tmpdir(), "mason-sdk-proof-"));
	try {
		await step("build the packages", async () => {
			await exec("npm", ["run", "build:packages"], { cwd: root });
		});

		const packs = join(workspace, "packs");
		await mkdir(packs, { recursive: true });
		await step("pack them", async () => {
			for (const name of ["protocol", "connector"]) {
				await exec("npm", ["pack", "--pack-destination", packs], { cwd: join(root, "packages", name) });
			}
		});

		const tarballs = (await readdir(packs)).filter((file) => file.endsWith(".tgz")).map((file) => join(packs, file));
		if (tarballs.length !== 2) throw new Error(`expected two tarballs, found ${tarballs.join(", ")}`);

		const project = join(workspace, "external");
		await mkdir(project, { recursive: true });
		await writeFile(
			join(project, "package.json"),
			`${JSON.stringify({ name: "external", private: true, type: "module" }, null, 2)}\n`,
		);
		await step("install them into an empty project", async () => {
			await exec("npm", ["install", "--no-audit", "--no-fund", ...tarballs], { cwd: project });
		});

		await step("no package ships a TypeScript file", async () => {
			const stray = await typescriptIn(join(project, "node_modules", "@mason"));
			if (stray.length > 0) throw new Error(`a published package ships source: ${stray.join(", ")}`);
		});

		await step("the schemas travel with the protocol package", async () => {
			const schema = join(project, "node_modules", "@mason", "protocol", "schemas", "protocol.v1.json");
			const document = JSON.parse(await readFile(schema, "utf8")) as { $id?: string };
			if (document.$id !== "https://mason.dev/connector/protocol.v1.json") {
				throw new Error("the published schema is not the normative document");
			}
		});

		await writeFile(join(project, "conformance.mjs"), FIXTURE);
		await step("run the published suite from outside the repository", async () => {
			const { stdout } = await exec("node", ["conformance.mjs"], { cwd: project, maxBuffer: 8 * 1024 * 1024 });
			process.stdout.write(stdout);
		});
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

async function typescriptIn(dir: string): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await typescriptIn(path)));
		else if (isSource(entry.name)) found.push(relative(dir, path));
	}
	return found;
}

/** A file a consumer's Node could not load: a declaration is not source, and `dist` is where it belongs. */
function isSource(name: string): boolean {
	if (name.endsWith(".d.ts")) return false;
	return name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".mts");
}

async function step(name: string, act: () => Promise<void>): Promise<void> {
	const started = Date.now();
	try {
		await act();
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`${name} failed: ${detail}`);
	}
	process.stdout.write(`ok   ${name} (${Date.now() - started} ms)\n`);
}

await main();
