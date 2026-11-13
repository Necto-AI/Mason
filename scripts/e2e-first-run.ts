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
 * What it proves, in order: flags are the whole first run (`mason init` with its three answers, then `mason new`, and a
 * second init asks nothing and changes nothing); the root holds `common/` and one bot and no halves of its own; `mason
 * doctor` ends green; `mason up` answers `/api/health` for the bot it serves; and one turn is answered — a scripted Chord
 * client holding the single user grant on that bot's console entry, whose credential is minted through the surviving
 * path, appends one submission and reads exactly one reply row out of the conversation state. Nothing is written outside
 * the temporary root: no `agent/` or `service/` at the root itself, no stray `~/.mason`.
 *
 * The client is Chord's, not the SDK's, because this is the proof of the wire: the state member is what a person's client
 * applies, and the assertion that outlives the delivery removal is the row it holds — one reply, under one id.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHost, type StateEvent } from "@earendil-works/chord";
import { apply } from "@earendil-works/chord/delta";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationState, connectorHost, MasonPeer, type PeerRef } from "mason-protocol";
import { nodeWebSocketLink } from "mason-connector";
import WebSocket from "ws";
import { mintConnectorCredential } from "../src/server/connectors.ts";
import { startServer } from "../src/server/main.ts";
import type { ResolvedModel } from "../src/server/runtime.ts";
import { SEND_TOOL } from "../src/shared/contract.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const keep = process.argv.includes("--keep");

/** The bot this run makes, and the name every command finds it by. */
const BOT = "bot";

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

	// 1. A clean machine, the way a person starts: flags, then a bot. Nothing is asked, because nothing can be.
	const init = await mason(directory, ["init", "--provider", "faux", "--model", "faux-1"], { HOME: home });
	check(init.code === 0, "init on an empty root exits 0", init.stderr || init.stdout);
	check(/the provider answered/.test(init.stdout), "init verifies the provider before it writes", init.stdout);
	const made = await mason(directory, ["new", BOT], { HOME: home });
	check(made.code === 0, "new creates the first bot and ends doctor 0", made.stderr || made.stdout);
	check(/7 checks: 7 ok, 0 failed/.test(made.stdout), "the doctor it ends with passes", made.stdout);

	// 2. Again: nothing asked, nothing written twice.
	const before = await treeShape(directory);
	const again = await mason(directory, ["init"], { HOME: home });
	check(again.code === 0, "a second init exits 0", again.stderr || again.stdout);
	check(/already initialised; nothing asked, nothing written/.test(again.stdout), "a second init asks nothing", again.stdout);
	const after = await treeShape(directory);
	check(
		JSON.stringify(before) === JSON.stringify(after),
		"a second init changes nothing on disk",
		`before: ${before.length} entries, after: ${after.length}`,
	);

	// 3. The root is a common store and one bot, and no halves at the root itself.
	const entries = await readdir(directory);
	check(entries.includes("common"), "the root holds common/", entries.join(", "));
	check(entries.includes(BOT), `the root holds the bot it made (${BOT})`, entries.join(", "));
	check(
		!entries.includes("agent") && !entries.includes("service"),
		"the root holds no home halves",
		entries.join(", "),
	);

	// 4. The bot is reachable: one granted connector, with a credential this home holds.
	const doctor = await mason(directory, ["doctor"], { HOME: home });
	check(doctor.code === 0, "doctor exits 0 for the bot it made", doctor.stderr || doctor.stdout);
	check(/granted: console/.test(doctor.stdout), "the console is the connector it granted", doctor.stdout);

	// 5. The server, on its own port, and the health answer that names the home it serves.
	const port = 19000 + Math.floor(Math.random() * 500);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		MASON_ROOT: directory,
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
		check(health.home === join(directory, BOT), "the health answer names the bot it serves", String(health.home));
	}
	server.kill("SIGTERM");
	await new Promise((done) => server.on("close", done));

	// 6. One turn, answered. The server is opened in this process because the faux provider has to be *scripted*, and the
	// client is a Chord client on the console entry with a credential minted by the surviving path.
	const chatPort = port + 1;
	const served = await startServer({
		port: chatPort,
		hostname: "127.0.0.1",
		houseHome: join(directory, BOT),
		storage: "memory",
		dataDir: join(directory, "turn-data"),
		modelAccess: scripted(),
		onReport: () => {},
	});
	const issued = await mintConnectorCredential(join(directory, BOT), "console", { replace: true });
	const client = createHost({ name: connectorHost("console"), self: { connector: "console" }, onError: () => {} });
	const link = nodeWebSocketLink(WebSocket as never)(`ws://127.0.0.1:${chatPort}/api/connector`, {
		credential: issued.credential,
	});
	try {
		client.connect(link, { principal: { connector: "console" } });
		const peer = (await client.get(MasonPeer, {})) as unknown as PeerRef;
		let state: ConversationState | undefined;
		peer.conversation.events((frame: StateEvent<ConversationState>) => {
			state = frame.type === "ops" ? (apply(structuredClone(state), frame.ops) as ConversationState) : frame.value;
		});
		const outcome = await peer.append({
			type: "submission",
			appendId: "first-run-1",
			content: [{ type: "text", text: "Say the word ok." }],
			origin: { ref: "first-run", actor: { id: "local", name: "you" } },
		});
		check(outcome.outcome === "accepted", "the client's submission was accepted", JSON.stringify(outcome));
		const answered = await waitFor(async () => replyRows(state).length >= 1);
		check(answered, "the turn produced a reply row in the conversation", JSON.stringify(state?.transcript));
		const rows = replyRows(state);
		check(rows.length === 1, "exactly one reply row for the turn", JSON.stringify(rows));
		check(rows[0]?.text === "ok", "and it carries the words the turn sent", JSON.stringify(rows));
	} finally {
		await client.close().catch(() => {});
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

/** The committed reply rows of a state: what a person's window reads, and the whole of a delivery. */
function replyRows(state: ConversationState | undefined): Array<{ id: string; text: string }> {
	return (state?.transcript ?? []).flatMap((row) =>
		row.kind === "delivered" && row.streaming !== true ? [{ id: row.id, text: row.text }] : [],
	);
}

/** The faux provider with one scripted turn: a `send` call, then the round that answers it. */
function scripted(): ResolvedModel {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall(SEND_TOOL, { text: "ok" })], { stopReason: "toolUse" }),
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
