/**
 * `scripts/chat.ts` — the console connector, against a real server on a real socket.
 *
 * The point of `mason chat` is what it proves: a person with no Telegram talks to their bot through the same
 * `/api/connector` socket every connector uses, with the same handshake, the same credential and the same deliveries. So
 * the test runs the real command against a real `startServer` on a temporary home, with the faux model scripted to
 * answer, and reads the command's own stdout. A mocked connector would prove nothing about the part that can break.
 *
 * The long turn is scripted as a model step that takes its time to return, because that is the only reliable way to have
 * a turn in flight when the person types `/stop`: a fast reply would prove the control mapping and not the stop.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { SEND_TOOL } from "../src/shared/contract.ts";
import { household } from "./support/chat.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "chat.ts");

/** A turn that answers with `reply`, and nothing else: the delivery comes from the tool call, not from the text. */
function replyTurn(message: string): FauxResponseStep[] {
	return [
		fauxAssistantMessage([fauxToolCall(SEND_TOOL, { text: message })], { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("sent")),
	];
}

/** A turn whose model takes `delayMs` to produce anything, so a `/stop` has somewhere to land. */
function slowReplyTurn(message: string, delayMs: number): FauxResponseStep[] {
	return [
		async () => {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			return fauxAssistantMessage([fauxToolCall(SEND_TOOL, { text: message })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage(fauxText("sent")),
	];
}

describe("mason chat", () => {
	test("--once prints the answer the model sent back through the socket", async () => {
		const { home, serve } = await household("mason-chat-once-");
		const served = await serve(replyTurn("hi yourself"));
		try {
			const { stdout } = await run(
				process.execPath,
				["--experimental-strip-types", script, "--once", "hi", "--url", served.url],
				{ cwd: root, env: { ...process.env, MASON_HOME: home }, maxBuffer: 8 * 1024 * 1024 },
			);
			assert.match(stdout, /hi yourself/);
		} finally {
			await served.close();
		}
	});

	test("a second run is not handed the first run's reply, and the ledger that decides is a file", async () => {
		const { home, serve } = await household("mason-chat-ledger-");
		// Two turns, one per run. Mason resends a delivery it was never acknowledged for, and the run that would be told so
		// is the next process: the ledger is a file under the service half for exactly that reason, and the last assertion
		// here is the one a process-local store could not satisfy.
		const served = await serve([...replyTurn("first answer"), ...replyTurn("second answer")]);
		try {
			const runOnce = async (): Promise<string> => {
				const { stdout } = await run(
					process.execPath,
					["--experimental-strip-types", script, "--once", "hi", "--url", served.url],
					{ cwd: root, env: { ...process.env, MASON_HOME: home }, maxBuffer: 8 * 1024 * 1024 },
				);
				return stdout;
			};
			assert.match(await runOnce(), /first answer/);
			const second = await runOnce();
			assert.match(second, /second answer/);
			assert.doesNotMatch(second, /first answer/, "the previous run's answer is not owed to this one");
			// And the ledger is in the service half, where the rest of the connector's state lives.
			assert.equal(existsSync(join(home, "service", "console-ledger.json")), true);
		} finally {
			await served.close();
		}
	});

	test("says where to look when mason is not running, rather than a stack trace", async () => {
		const { home } = await household("mason-chat-down-");
		// A port nothing is listening on: the socket is refused, and the command has to say what to do.
		const result = await run(
			process.execPath,
			["--experimental-strip-types", script, "--once", "hi", "--url", "ws://127.0.0.1:1/api/connector"],
			{ cwd: root, env: { ...process.env, MASON_HOME: home } },
		).then(
			(ok) => ({ code: 0, stderr: ok.stderr }),
			(error: { code?: number; stderr?: string }) => ({ code: error.code ?? 1, stderr: error.stderr ?? "" }),
		);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /start it with `mason up`/);
	});

	test("/stop during a turn settles as stopped, and the answer never arrives", async () => {
		const { home, serve } = await household("mason-chat-stop-");
		const served = await serve(slowReplyTurn("too late", 1_500));
		try {
			const child = spawn(process.execPath, ["--experimental-strip-types", script, "--url", served.url], {
				cwd: root,
				env: { ...process.env, MASON_HOME: home },
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			const exited = new Promise<number>((resolve) => {
				child.on("exit", (code) => {
					resolve(code ?? 1);
				});
			});

			// Wait for the socket rather than a fixed sleep: the handshake is what the controls are sent over.
			const deadline = Date.now() + 10_000;
			while (!stdout.includes("connected") && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 20));
			assert.match(stdout, /connected/, stderr);

			child.stdin.write("a long question\n");
			// In flight, and said so by mason: the model is still thinking, so the status line is the proof that the stop
			// below lands on a running turn rather than on an idle server.
			await new Promise((resolve) => setTimeout(resolve, 300));
			child.stdin.write("/status\n");
			await new Promise((resolve) => setTimeout(resolve, 300));
			child.stdin.write("/stop\n");
			// Past the model's own delay, so a stop that missed has somewhere to show: a turn nobody stopped would answer
			// here, and a turn that was stopped has nothing left to send.
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			child.stdin.write("/status\n");
			await new Promise((resolve) => setTimeout(resolve, 300));
			child.stdin.write("/exit\n");
			const code = await exited;
			assert.equal(code, 0, stderr);
			assert.match(stdout, /\[status\] handled: (answering|running tools|retrying)/, "a turn was in flight");
			assert.match(stdout, /\[stop\] handled: stopped/, "the control reached mason");
			assert.match(stdout, /\[status\] handled: idle/, "and the turn settled rather than finishing late");
			assert.doesNotMatch(stdout, /too late/, "the turn was stopped before it answered");
		} finally {
			await served.close();
		}
	});
});
