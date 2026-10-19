/**
 * Hook fire identity: a delivery has one identity, a gesture has none.
 *
 * The durable layer already deduplicates by `requestId`, so the only thing mason has to get right is which key it
 * hands over — that is what these tests pin down.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openAgentRuntime } from "../src/server/runtime.ts";

async function withRuntime(run: (runtime: Awaited<ReturnType<typeof openAgentRuntime>>) => Promise<void>): Promise<void> {
	const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
		storage: "memory",
		faux: true,
		onReport: () => {},
	});
	try {
		await run(runtime);
	} finally {
		await runtime.close();
	}
}

describe("hook fire identity", () => {
	it("turns one delivery delivered twice into one submission", async () => {
		await withRuntime(async (runtime) => {
			const first = await runtime.hooks.fire("workspace-check", { payload: "git status", requestId: "delivery-1" });
			const again = await runtime.hooks.fire("workspace-check", { payload: "git status", requestId: "delivery-1" });
			// One delivery, one submission: the durable layer returns the existing one instead of placing a second.
			assert.equal(again.id, first.id);
		});
	});

	it("keeps two deliveries apart", async () => {
		await withRuntime(async (runtime) => {
			const first = await runtime.hooks.fire("workspace-check", { requestId: "delivery-1" });
			const second = await runtime.hooks.fire("workspace-check", { requestId: "delivery-2" });
			assert.notEqual(second.id, first.id);
		});
	});

	it("gives a gesture a fresh turn every time", async () => {
		await withRuntime(async (runtime) => {
			const first = await runtime.hooks.fire("retry-failed-run", { payload: "connection error" });
			const second = await runtime.hooks.fire("retry-failed-run", { payload: "connection error" });
			assert.notEqual(second.id, first.id);
			assert.equal(runtime.hooks.get("retry-failed-run")?.fireCount, 2);
		});
	});

	it("never arms a disabled hook, even when startup walks every hook", async () => {
		await withRuntime(async (runtime) => {
			runtime.hooks.define({
				id: "tick",
				name: "Tick",
				description: "A one-second hook that nobody enabled.",
				enabled: false,
				intervalMs: 1_000,
				promptTemplate: "tick",
			});
			runtime.hooks.start();
			await new Promise((resolve) => setTimeout(resolve, 1_200));
			assert.equal(runtime.hooks.get("tick")?.fireCount, 0);
		});
	});
});
