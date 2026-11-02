/**
 * A boot that dies while a call waits for its answer.
 *
 * The permission gateway's central promise is that a pending question survives a process that stops without closing
 * anything: recovery re-enters the tool's `call` phase, the hook reads the answer that was written down, and only then
 * does the call get an intent and execute. A test cannot prove that by closing the runtime — a close aborts what it finds
 * and marks it, which is a different, gentler story — so this program is the crash: it boots, starts one turn, waits for
 * the question to be committed, prints what the parent needs, and exits without a close, a flush or a goodbye.
 *
 * It also writes every `tools/call` it sends to `calls.log`, synchronously and before it answers, so the parent can add
 * up what the service saw across both processes: the effect that ran before the crash must not run again, and the guarded
 * call must run exactly once after the answer.
 *
 * Usage: `restart-child.ts <directory>`; the directory holds `house/`, `data/` and the two files it writes.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { boot, fakeServer, GITHUB, GUARDED_TOOL, SEARCH_TOOL, TWO_CALLS } from "./fake-mcp.ts";

const directory = process.argv[2];
if (directory === undefined) throw new Error("usage: restart-child.ts <directory>");
const callsLog = join(directory, "calls.log");

const server = await fakeServer([SEARCH_TOOL, GUARDED_TOOL], (name, args) => {
	appendFileSync(callsLog, `${name} ${JSON.stringify(args)}\n`);
	return { content: [{ type: "text", text: `${name} done` }] };
});
const runtime = await boot(directory, {
	integrations: { github: GITHUB },
	transport: () => server.transport,
	// The codemode call; what follows it belongs to the process that answers.
	steps: [
		fauxAssistantMessage([fauxToolCall("codemode", { code: TWO_CALLS }, { id: "script" })], {
			stopReason: "toolUse",
		}),
	],
	persist: true,
});
const submission = await (await runtime.conversation()).submit(
	{ type: "input", content: "Open the issue." },
	BACKGROUND_CONTEXT,
);
// The question is committed before the wait begins, so this is the moment a crash can leave it pending.
const deadline = Date.now() + 30_000;
let pending = 0;
while (Date.now() < deadline) {
	pending = (await runtime.permissions.pending()).length;
	if (pending > 0) break;
	await new Promise((resolve) => setTimeout(resolve, 20));
}
if (pending === 0) {
	console.error("no question was asked: the gateway did not reach the call");
	process.exit(2);
}
const [request] = await runtime.permissions.pending();
process.stdout.write(
	`${JSON.stringify({ submissionId: submission.id, permissionId: request?.permissionId, tool: request?.tool })}\n`,
);
// The crash: no close, no flush. The parent answers, and recovery finds the call where this process left it.
process.exit(9);
