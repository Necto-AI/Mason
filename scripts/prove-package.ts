/**
 * Prove the package as a stranger installs it.
 *
 * `npm run e2e:first-run` walks the source path: `bin/mason.ts`, a scratch root, the checkout's own `docs/agent`. Every
 * other check reads the tree. The gap between those and a release is the *installed shape* — a tarball built by `prepack`,
 * unpacked into a directory that has no checkout above it — and it is where the release blockers lived: the deployment
 * reference travelled only because a script remembered to copy it, and when that copy went the prompt lost its `docs`
 * section silently.
 *
 * So this packs the root, installs the tarball into an empty project outside the repository, and drives the installed
 * `mason` there with a temporary `HOME` and `MASON_ROOT`: `onboard --yes --connector console`, then `doctor`, then the
 * prompt rendered by the installed `dist/scripts/prompt.js`. It also fails on a `.ts` file under the installed `dist`,
 * because a consumer's Node refuses to strip types inside `node_modules`.
 *
 * `npm pack` runs the package's own `prepack`, so this builds `dist/` in the checkout — the one thing it writes, and the
 * thing the release ships. Everything else lands in a directory under `$TMPDIR` and is removed.
 *
 * Run with `npm run prove:package`.
 */
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

/** The package a stranger installs, and the one this script packs. */
const PACKAGE = "mason-agent";

/**
 * The reference's front page, as the tarball carries it. The mount is `/mason/docs`; `dist/docs/agent` is its source.
 * The prompt's grounding line names it too, so the index beside it is the half a missing copy empties.
 */
const DOCS_FRONT_PAGE = join("dist", "docs", "agent", "README.md");

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

async function main(): Promise<void> {
	const workspace = await mkdtemp(join(tmpdir(), "mason-package-proof-"));
	try {
		const packs = join(workspace, "packs");
		await mkdir(packs, { recursive: true });
		await step("pack it", async () => {
			await exec("npm", ["pack", "--pack-destination", packs], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
		});
		const tarballs = (await readdir(packs)).filter((file) => file.endsWith(".tgz"));
		if (tarballs.length !== 1) throw new Error(`expected one tarball, found ${tarballs.join(", ") || "none"}`);

		const project = join(workspace, "external");
		await mkdir(project, { recursive: true });
		await writeFile(
			join(project, "package.json"),
			`${JSON.stringify({ name: "external", private: true, type: "module" }, null, 2)}\n`,
		);
		await step("install it into an empty project", async () => {
			await exec("npm", ["install", "--no-audit", "--no-fund", join(packs, tarballs[0] as string)], {
				cwd: project,
				maxBuffer: 8 * 1024 * 1024,
			});
		});

		const installed = join(project, "node_modules", PACKAGE);
		await step("no TypeScript file ships in dist", async () => {
			// A declaration is not source, and `dist` is where it belongs: the rule is the one `prove:connector` applies.
			const stray = await typescriptIn(join(installed, "dist"));
			if (stray.length > 0) throw new Error(`the installed package ships source: ${stray.join(", ")}`);
		});

		// A first run has nothing of the operator's: its own HOME, its own root, and no provider. `PI_FAUX_MODEL=1` is the
		// switch the runtime plays a model under, which is what makes this cost nothing and reach no network.
		const env = environment(join(workspace, "home"), join(workspace, "root"));

		await step("a first run, onboard and doctor, with the installed command", async () => {
			const onboard = await run(
				join(project, "node_modules", ".bin", "mason"),
				["onboard", "--yes", "--connector", "console"],
				project,
				env,
			);
			if (onboard.code !== 0) throw new Error(`onboard ended ${onboard.code}:\n${onboard.stdout}${onboard.stderr}`);
			const doctor = await run(join(project, "node_modules", ".bin", "mason"), ["doctor"], project, env);
			if (doctor.code !== 0) throw new Error(`doctor ended ${doctor.code}:\n${doctor.stdout}${doctor.stderr}`);
		});

		await step("the installed prompt carries the docs index", async () => {
			const prompt = await run(
				process.execPath,
				[join(installed, "dist", "scripts", "prompt.js"), "--json"],
				project,
				env,
			);
			if (prompt.code !== 0) throw new Error(`the prompt ended ${prompt.code}:\n${prompt.stdout}${prompt.stderr}`);
			const rendered = JSON.parse(prompt.stdout) as {
				readonly prompt: string;
				readonly sections: ReadonlyArray<{ readonly key: string; readonly text: string }>;
			};
			// A listed page, not the grounding line: the line is a constant in the section, while a `- /mason/docs/` line
			// can only exist if the installed `dist/docs/agent` was read. README is the one page the index leaves out, so
			// the tarball's copy is checked directly.
			const listed =
				rendered.sections
					.find((section) => section.key === "docs")
					?.text.split("\n")
					.filter((line) => line.startsWith("- /mason/docs/")) ?? [];
			const [first] = listed;
			if (first === undefined) {
				throw new Error("the prompt's docs section lists no page: the tarball carries no deployment reference");
			}
			if (!rendered.prompt.includes(first)) throw new Error(`the docs index never reached the prompt: ${first}`);
			await access(join(installed, DOCS_FRONT_PAGE));
			process.stdout.write(`     ${listed.length + 1} pages of docs index, ${rendered.sections.length} sections\n`);
		});
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
	console.log(
		`PROOF OK: ${PACKAGE} packs, installs, onboards, passes doctor, and renders its prompt from its own dist`,
	);
}

/**
 * The environment a stranger's first run has: a home of its own, a root beside it, and no target inherited from whatever
 * session started this script. The port is this run's, so a bot already serving on 8787 is not mistaken for this one.
 */
function environment(home: string, masonRoot: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		MASON_ROOT: masonRoot,
		MASON_HOME: "",
		PI_FAUX_MODEL: "1",
		PORT: String(20000 + Math.floor(Math.random() * 500)),
	};
	for (const name of ["MASON_BOT", "PI_PROVIDER", "PI_MODEL"]) delete env[name];
	return env;
}

function run(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Run> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error !== null && typeof error.code !== "number") {
				reject(error);
				return;
			}
			resolve({ code: error === null ? 0 : (error.code as number), stdout, stderr });
		});
	});
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

/** A file a consumer's Node could not load. A declaration is not source, exactly as `prove:connector` counts it. */
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
