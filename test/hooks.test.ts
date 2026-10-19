/**
 * A disabled hook stays switched off, whatever happens at startup.
 *
 * `start()` walks every hook it knows, including the ones nobody enabled. `#arm` is the single gate that keeps them
 * quiet, so these tests pin it from both directions: a disabled hook with an interval never fires, and enabling one
 * afterwards does arm it.
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

describe("a disabled hook", () => {
	it("is not armed by startup walking every hook", async () => {
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

	it("starts firing once it is enabled", async () => {
		await withRuntime(async (runtime) => {
			runtime.hooks.define({
				id: "tick",
				name: "Tick",
				description: "A one-second hook that is enabled later.",
				enabled: false,
				intervalMs: 1_000,
				promptTemplate: "tick",
			});
			runtime.hooks.setEnabled("tick", true);
			await new Promise((resolve) => setTimeout(resolve, 1_200));
			assert.ok((runtime.hooks.get("tick")?.fireCount ?? 0) >= 1);
		});
	});
});
