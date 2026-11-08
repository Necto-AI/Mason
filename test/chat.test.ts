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
import { replyOutput } from "../scripts/chat.ts";
import { REPLY_TOOL } from "../src/shared/contract.ts";
import { household } from "./support/chat.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "chat.ts");

/** A turn that answers with `reply`, and nothing else: the delivery comes from the tool call, not from the text. */
function replyTurn(message: string): FauxResponseStep[] {
	return [
		fauxAssistantMessage([fauxToolCall(REPLY_TOOL, { message })], { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("sent")),
	];
}

/** A turn whose model takes `delayMs` to produce anything, so a `/stop` has somewhere to land. */
function slowReplyTurn(message: string, delayMs: number): FauxResponseStep[] {
	return [
		async () => {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			return fauxAssistantMessage([fauxToolCall(REPLY_TOOL, { message })], { stopReason: "toolUse" });
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

	test("a stream stopped halfway says the words on the screen were withdrawn", async () => {
		// The other end of the guard: a stream whose turn ends before it is final is a withdrawal, and the notice is the
		// only thing that tells a person the half-written answer above it did not survive.
		const { home, serve } = await household("mason-chat-stop-stream-");
		const answer = Array.from({ length: 30 }, (_, index) => `word number ${index} of a long answer.`).join(" ");
		// Slow enough that the stop lands while the reply is still being written, not before the stream begins.
		const served = await serve(slowReplyTurn(answer, 200), { tokensPerSecond: 60 });
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
			const deadline = Date.now() + 10_000;
			while (!stdout.includes("connected") && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 20));
			assert.match(stdout, /connected/, stderr);
			child.stdin.write("say something long\n");
			// Wait for words on the screen rather than a fixed sleep: the stream is what has to be interrupted.
			const streaming = Date.now() + 10_000;
			while (!/word number \d/.test(stdout) && Date.now() < streaming)
				await new Promise((resolve) => setTimeout(resolve, 20));
			assert.match(stdout, /word number \d/, "the reply was streaming");
			child.stdin.write("/stop\n");
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			child.stdin.write("/exit\n");
			assert.equal(await exited, 0, stderr);
			assert.match(stdout, /the reply was withdrawn/, `the stopped stream was withdrawn: ${stdout}`);
			assert.doesNotMatch(stdout, /word number 29/, "the answer never finished");
		} finally {
			await served.close();
		}
	});

	test("a streamed answer is written whole: the start's words, the deltas, the tail the stream never reached", () => {
		// The three shapes a streamed delivery takes on a terminal, and the one thing each must not do: begin mid-sentence
		// (the words in `start` are the opening of the message), stop where the stream stopped (the stream is a prefix of
		// the message, not all of it), or print the same answer twice (a delivery that lands after its stream was
		// withdrawn is the message that stream was showing).
		const printed: string[] = [];
		// The same contract `console.log` has: a line is written with its newline, and a blank string is a blank line.
		const output = replyOutput(
			(text) => printed.push(text),
			(text) => printed.push(`${text}\n`),
		);
		const plain = (): string => printed.join("").replace(/\x1b\[[0-9;]*m/g, "");
		output.start("reply:1", "Hello — I'm mason, and I");
		output.delta("reply:1", " have just come up");
		output.final("reply:1", "Hello — I'm mason, and I have just come up, and this is the rest of it.");
		assert.equal(
			plain(),
			"mason: Hello — I'm mason, and I have just come up, and this is the rest of it.\n",
			"the screen has the whole answer, in order, once",
		);

		printed.length = 0;
		output.start("reply:2", "a streamed answer");
		output.final("reply:2", "a streamed answer");
		assert.equal(plain(), "mason: a streamed answer\n", "a stream that reached the end closes the line");

		printed.length = 0;
		output.start("reply:3", "half an answer");
		output.cancel("reply:3", "the reply was withdrawn before it was final");
		output.final("reply:3", "half an answer");
		assert.equal(
			plain(),
			"mason: half an answer\n[chat] the reply was withdrawn: the reply was withdrawn before it was final\n\n",
			"the notice is on its own line, and the words are not printed again",
		);

		printed.length = 0;
		output.start("reply:4", "half an answer");
		output.cancel("reply:4", "stopped");
		output.final("reply:4", "the whole answer");
		assert.equal(
			plain().split("the whole answer").length - 1,
			1,
			`a final the screen does not have is printed once: ${plain()}`,
		);

		printed.length = 0;
		output.final("reply:5", "no stream at all");
		assert.equal(plain(), "mason: no stream at all\n", "a delivery that never streamed arrives whole");
	});

	test("a streamed answer is on screen once, whole, and never announced as withdrawn", async () => {
		// The shape that made a person see the same paragraph twice: the reply is written in pieces (`start` carries the
		// text so far, the deltas the rest), the assistant message leaves the live state as it commits — which is the
		// handover to the tool, not the end of the delivery — and the final lands a moment later. A console that prints
		// only deltas begins mid-sentence; one that forgets a cancelled delivery prints the answer a second time.
		const { home, serve } = await household("mason-chat-stream-");
		const answer = Array.from({ length: 12 }, (_, index) => `sentence number ${index} of the answer.`).join(" ");
		// Paced, so the stream exists: with no pace the whole tool call is pushed in one tick and nothing streams.
		const served = await serve(replyTurn(answer), { tokensPerSecond: 300 });
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
			const deadline = Date.now() + 10_000;
			while (!stdout.includes("connected") && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 20));
			child.stdin.write("tell me something long\n");
			const answered = Date.now() + 15_000;
			while (!stdout.includes("sentence number 11 of the answer.") && Date.now() < answered)
				await new Promise((resolve) => setTimeout(resolve, 20));
			child.stdin.write("/exit\n");
			const code = await exited;
			assert.equal(code, 0, stderr);

			assert.ok(
				stdout.includes("sentence number 0 of the answer."),
				`the answer begins at its beginning: ${stdout}`,
			);
			assert.equal(
				stdout.split("sentence number 11 of the answer.").length - 1,
				1,
				`the answer is on screen once: ${stdout}`,
			);
			assert.doesNotMatch(stdout, /withdrawn/, "a reply that lands was never withdrawn");
		} finally {
			await served.close();
		}
	});
});
