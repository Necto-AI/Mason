/**
 * `scripts/e2e-first-run.ts` — the first run as a script: a real CLI, a real root, a real turn.
 *
 * Every other first-run test runs in-process, against functions. This one runs the *installed shape*: `bin/mason.ts`,
 * a temporary `MASON_ROOT`, `PI_FAUX_MODEL=1`, and the exit codes an operator sees. That difference is not academic —
 * `mason prompt` wrote a home at the root and `mason onboard` left a half-built bot behind, and neither was visible
 * from inside a function that had already resolved its paths.
 *
 *     node --experimental-strip-types scripts/e2e-first-run.ts [--keep]
 *
 * What it proves, in order: a clean root onboards and ends doctor 0; a second onboard asks nothing and changes nothing;
 * a second bot is created and targeted; a fleet with no target refuses by name; a real turn over the console connector
 * answers; and nothing was written outside the temporary root — no `agent/` or `service/` at the root itself, no stray
 * `~/.mason`.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { startServer } from "../src/server/main.ts";
import type { ResolvedModel } from "../src/server/runtime.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const keep = process.argv.includes("--keep");

interface Result {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

let failures = 0;

/**
 * Its own port, because this machine may be running a real bot on 8787: a scratch bot that finds another home's server
 * there is a failed check, and it should be — that is the identity check working as intended.
 */
const freePort = String(20000 + Math.floor(Math.random() * 500));

function check(ok: boolean, what: string, detail = ""): void {
	if (ok) {
		console.log(`  ok  ${what}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL ${what}${detail === "" ? "" : `\n       ${detail.split("\n").join("\n       ")}`}`);
}

/** One CLI run, with the environment a first run has: a scratch root, the offline model, and no inherited target. */
async function mason(directory: string, args: readonly string[], extra: NodeJS.ProcessEnv = {}): Promise<Result> {
	const env: NodeJS.ProcessEnv = { ...process.env, PORT: freePort, ...extra, MASON_ROOT: directory, MASON_HOME: "" };
	delete env.MASON_BOT;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	env.PI_FAUX_MODEL = "1";
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", join(root, "bin", "mason.ts"), ...args], {
			cwd: root,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}

/** The shape of a tree, for "the second run changed nothing": paths, sizes and modes, not mtimes. */
async function treeShape(directory: string, prefix = ""): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
	const lines: string[] = [];
	for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
		const path = join(directory, entry.name);
		const relative = join(prefix, entry.name);
		if (entry.name === "agent.sqlite" || entry.name.endsWith(".sqlite-wal") || entry.name.endsWith(".sqlite-shm"))
			continue;
		const info = await stat(path);
		lines.push(`${relative} ${info.isDirectory() ? "dir" : `${info.size} ${(info.mode & 0o777).toString(8)}`}`);
		if (entry.isDirectory() && entry.name !== ".git") lines.push(...(await treeShape(path, relative)));
	}
	return lines;
}

async function main(): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "mason-e2e-first-run-"));
	const home = join(directory, "home");
	console.log(`root: ${directory}`);

	// 1. A clean machine, the way a person starts.
	const onboard = await mason(directory, ["onboard", "--yes", "--connector", "console"], { HOME: home });
	check(onboard.code === 0, "onboard on an empty root exits 0", onboard.stderr || onboard.stdout);
	check(/9 checks: 9 ok, 0 failed/.test(onboard.stdout), "onboard ends with a doctor that passes", onboard.stdout);
	check(onboard.stdout.includes("console"), "the connector it was asked for is the one it granted", onboard.stdout);

	// 2. Again: nothing asked, nothing written twice.
	const before = await treeShape(directory);
	const again = await mason(directory, ["onboard", "--yes", "--connector", "console"], { HOME: home });
	check(again.code === 0, "a second onboard exits 0", again.stderr || again.stdout);
	check(/nothing asked about providers or keys/.test(again.stdout), "a second onboard asks nothing", again.stdout);
	check(/nothing installed twice/.test(again.stdout), "a second onboard installs nothing twice", again.stdout);
	const after = await treeShape(directory);
	check(
		JSON.stringify(before) === JSON.stringify(after),
		"a second onboard changes nothing on disk",
		`before: ${before.length} entries, after: ${after.length}`,
	);

	// 3. The root is a fleet: `common/` and bots, and no halves at the root itself.
	const entries = await readdir(directory);
	check(entries.includes("common"), "the root holds common/", entries.join(", "));
	check(
		!entries.includes("agent") && !entries.includes("service"),
		"the root holds no home halves",
		entries.join(", "),
	);

	// 4. Which bot a command targets.
	const bots = await mason(directory, ["bots"], { HOME: home });
	check(bots.code === 0 && /\(current\)/.test(bots.stdout), "bots names the one bot as current", bots.stdout);

	// 5. A second bot, then the refusal a fleet needs.
	const second = await mason(directory, ["new", "bob", "--yes", "--connector", "console", "--no-start"], {
		HOME: home,
	});
	check(second.code === 0, "new bob exits 0", second.stderr || second.stdout);
	const two = await mason(directory, ["bots"], { HOME: home });
	check(two.code === 0 && !/\(current\)/.test(two.stdout), "with two bots nothing is current", two.stdout);
	check(/no target:.*holds 2 bots/.test(two.stdout), "bots says why nothing is current", two.stdout);
	const ambiguous = await mason(directory, ["status"], { HOME: home });
	check(ambiguous.code === 1, "status with two bots and no target exits 1", ambiguous.stdout);
	check(/holds 2 bots: .*bob/.test(ambiguous.stderr), "the refusal names both bots", ambiguous.stderr);

	const targeted = await mason(directory, ["doctor", "-b", "bob"], { HOME: home });
	check(targeted.code === 0, "doctor -b bob exits 0", targeted.stderr || targeted.stdout);

	// 6. A real turn: the server on its own port, the console client, one answer.
	const port = 19000 + Math.floor(Math.random() * 500);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		MASON_ROOT: directory,
		MASON_BOT: "bob",
		MASON_HOME: "",
		PI_FAUX_MODEL: "1",
		PORT: String(port),
	};
	const server = spawn(process.execPath, ["--experimental-strip-types", join(root, "bin", "mason.ts"), "up"], {
		cwd: root,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let log = "";
	server.stdout.on("data", (chunk: Buffer) => {
		log += chunk.toString();
	});
	server.stderr.on("data", (chunk: Buffer) => {
		log += chunk.toString();
	});
	const ready = await waitFor(
		async () => (await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => undefined))?.ok === true,
	);
	check(ready, "mason up answers /api/health", log);
	if (ready) {
		const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { home?: string };
		check(health.home === join(directory, "bob"), "the health answer names the bot it serves", String(health.home));
	}
	server.kill("SIGTERM");
	await new Promise((done) => server.on("close", done));

	// 7. `mason chat` over a real socket. The server is opened in this process because the faux provider has to be
	// *scripted* to answer, and no environment variable scripts it: everything on the client side is the real command.
	const chatPort = port + 1;
	const served = await startServer({
		port: chatPort,
		hostname: "127.0.0.1",
		houseHome: join(directory, "bob"),
		storage: "memory",
		dataDir: join(directory, "chat-data"),
		modelAccess: scripted(),
		onReport: () => {},
	});
	try {
		const chat = await mason(
			directory,
			["chat", "-b", "bob", "--once", "Say the word ok.", "--url", `ws://127.0.0.1:${chatPort}/api/connector`],
			{
				HOME: home,
			},
		);
		check(chat.code === 0, "a turn over the console connector exits 0", chat.stderr || chat.stdout);
		check(/first run/.test(chat.stdout) === false && chat.stdout.trim().length > 0, "the turn answered", chat.stdout);
	} finally {
		await served.close();
	}

	// 7. Nothing leaked outside the root.
	const stray = await readdir(join(home, ".mason")).catch(() => undefined);
	check(stray === undefined, "nothing was written to the scratch HOME's ~/.mason", String(stray));

	if (keep) console.log(`kept: ${directory}`);
	else await rm(directory, { recursive: true, force: true });
	console.log(failures === 0 ? "\nfirst run: ok" : `\nfirst run: ${failures} failed`);
	process.exit(failures === 0 ? 0 : 1);
}

/** The faux provider with one scripted turn: a `reply` call, then the round that answers it. */
function scripted(): ResolvedModel {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("send", { text: "ok" })], { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("sent")),
	]);
	return { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true };
}

/** Poll until `ready()` is true or ten seconds pass. */
async function waitFor(ready: () => Promise<boolean>): Promise<boolean> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (await ready()) return true;
		await new Promise((done) => setTimeout(done, 200));
	}
	return false;
}

await main();
