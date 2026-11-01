/**
 * A run the provider killed is re-armed with nobody looking at the UI.
 *
 * The supervisor is a policy over the conversation, not over a connection. The person who needs a failed run retried is
 * the one who is *not* in the web client — a bot's chat, overnight — so the server's own watch has to feed it. The bug
 * this pins: fed from a browser's `viewSync` instead, the supervisor observed nothing whenever no client was connected,
 * and a run that a provider killed stayed dead until somebody wrote again (a bot's two messages sat unanswered for 3
 * and 12 hours on 2026-10-30, with no `[run-retry]` line in the log at all).
 *
 * The whole path is exercised: a signed event opens a run, the faux provider fails it, and the supervisor's own fire is
 * what the transcript has to show — no client is ever created here.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { type HousePaths, housePaths } from "../src/server/house.ts";
import { type RunningServer, startServer } from "../src/server/main.ts";
import { RETRY_HOOK_ID } from "../src/server/run-retry.ts";
import type { AgentRuntime, ResolvedModel } from "../src/server/runtime.ts";
import { HOOK_ENTRY_KIND } from "../src/shared/contract.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

const secret = "4c".repeat(32);
const integrations = {
	integrations: { telegram: { enabled: true, trigger: { hook: "team-chat", secret } } },
};

async function temporaryHome(): Promise<HousePaths> {
	const directory = await mkdtemp(join(tmpdir(), "mason-retry-wiring-"));
	directories.add(directory);
	const paths = housePaths(join(directory, "house"));
	await mkdir(paths.home, { recursive: true, mode: 0o700 });
	await mkdir(dirname(paths.integrations), { recursive: true, mode: 0o700 });
	await writeFile(paths.integrations, JSON.stringify(integrations), { encoding: "utf8", mode: 0o600 });
	return paths;
}

/** A provider with nothing scripted: every run it serves ends in the faux error, which is the failure under test. */
function failingModel(): ResolvedModel {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true };
}

function signature(body: string): string {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

interface Entries {
	readonly kind: string;
	readonly stopReason?: string;
	readonly hookId?: string;
}

/** The committed transcript, flattened to what these tests ask of it: the kind, and the two reasons inside. */
async function entries(runtime: AgentRuntime): Promise<Entries[]> {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	return page.items.map((entry) => {
		// `Message` is a union and only some members carry a reason: a system entry in the same transcript does not, so
		// the narrowing says "the first message is one that has a reason" rather than asserting it.
		const assistant = entry.model?.[0];
		const stopReason = assistant !== undefined && "stopReason" in assistant ? assistant.stopReason : undefined;
		const data =
			typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data)
				? (entry.data as Record<string, unknown>)
				: {};
		return {
			kind: entry.kind,
			...(stopReason === undefined ? {} : { stopReason }),
			...(typeof data.hookId === "string" ? { hookId: data.hookId } : {}),
		};
	});
}

/** How many times `hookId` fired, from the committed transcript. */
async function fires(runtime: AgentRuntime, hookId: string): Promise<number> {
	return (await entries(runtime)).filter((entry) => entry.kind === HOOK_ENTRY_KIND && entry.hookId === hookId).length;
}

/**
 * Waits for a transcript to say something. Every step here is a run that has to start, call the provider, fail and
 * commit, and a test that reads once is a test that reads too early.
 */
async function waitFor(runtime: AgentRuntime, done: (all: Entries[]) => boolean, deadlineMs = 5_000): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (!done(await entries(runtime)) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("a failed run with no browser connected", () => {
	it("is re-armed by the server's own watch", async () => {
		const paths = await temporaryHome();
		const directory = dirname(paths.home);
		const previousDelays = process.env.PDA_RUN_RETRY_DELAYS_MS;
		const previousAttempts = process.env.PDA_RUN_RETRY_ATTEMPTS;
		// One attempt, arriving while the test is still looking: the delay is the thing under test, not the patience.
		process.env.PDA_RUN_RETRY_DELAYS_MS = "40";
		process.env.PDA_RUN_RETRY_ATTEMPTS = "1";
		let server: RunningServer | undefined;
		try {
			server = await startServer({
				port: 0,
				hostname: "127.0.0.1",
				dataDir: join(directory, "data"),
				workspaceDir: join(directory, "workspace"),
				houseHome: paths.home,
				modelAccess: failingModel(),
				onReport: () => {},
			});
			const body = JSON.stringify({ v: 1, id: "chat-1", kind: "chat.message", payload: "Таня: ?" });
			const delivered = await fetch(`http://127.0.0.1:${server.port}/api/events/telegram`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-mason-signature": signature(body) },
				body,
			});
			assert.equal(delivered.status, 202, "the event opens a run, and the run is the failure under test");

			// The run failed, and no client was ever created: a supervisor fed from a connection would observe nothing.
			await waitFor(server.runtime, (all) => all.some((entry) => entry.stopReason === "error"));
			assert.ok(
				(await entries(server.runtime)).some((entry) => entry.stopReason === "error"),
				"the provider's failure is in the transcript before the retry is asked for",
			);

			await waitFor(server.runtime, (all) => all.some((entry) => entry.hookId === RETRY_HOOK_ID));
			assert.equal(await fires(server.runtime, RETRY_HOOK_ID), 1, "the supervisor fired its own retry hook");
			// The budget is one: a second failure is not a second retry.
			await new Promise((resolve) => setTimeout(resolve, 400));
			assert.equal(await fires(server.runtime, RETRY_HOOK_ID), 1, "one attempt, then the Retry control");
		} finally {
			await server?.close();
			if (previousDelays === undefined) delete process.env.PDA_RUN_RETRY_DELAYS_MS;
			else process.env.PDA_RUN_RETRY_DELAYS_MS = previousDelays;
			if (previousAttempts === undefined) delete process.env.PDA_RUN_RETRY_ATTEMPTS;
			else process.env.PDA_RUN_RETRY_ATTEMPTS = previousAttempts;
		}
	});
});
