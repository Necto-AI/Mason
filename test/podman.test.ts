/**
 * `src/server/podman.ts` — the driver, and the two questions setup asks before it starts a container.
 *
 * What is pinned is the shape of what mason runs, because the failure this file exists to prevent is a first run that
 * ends in podman's own error text. No test here starts a container: every call takes the command runner as a parameter,
 * and this suite hands it a recorder. That is the same reason the runner is a parameter at all, so a test that skipped it
 * would be testing a different program.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	bootPolicyFix,
	type CommandOutput,
	type CommandRunner,
	checkPodman,
	down,
	listening,
	logs,
	loopbackRefusal,
	ps,
	up,
} from "../src/server/podman.ts";

/** A runner that records every argv and answers from a table keyed by the first two words. */
function recorder(answers: Readonly<Record<string, CommandOutput | Error>> = {}): {
	readonly run: CommandRunner;
	readonly calls: readonly string[];
} {
	const calls: string[] = [];
	const run: CommandRunner = async (command, argv) => {
		const key = [command, ...argv].join(" ");
		calls.push(key);
		const answer = answers[`${command} ${argv.slice(0, 2).join(" ")}`] ??
			answers[`${command} ${argv[0] ?? ""}`] ??
			answers[command] ?? { stdout: "", stderr: "" };
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { run, calls };
}

describe("the checks before anything is started", () => {
	test("podman and a compose provider, or a sentence naming what to install", async () => {
		assert.deepEqual(await checkPodman({ runner: recorder().run }), { ok: true });

		const noPodman = recorder({ podman: new Error("spawn podman ENOENT") });
		const missing = await checkPodman({ runner: noPodman.run });
		assert.equal(missing.ok, false);
		assert.match(missing.ok === false ? missing.fix : "", /podman is not installed/);

		// The shim exists and the provider behind it does not: the message has to name the package, not the shim.
		const noProvider = recorder({
			"podman --version": { stdout: "podman version 6.1.4\n", stderr: "" },
			"podman compose": new Error("podman compose version exited 125: no compose provider"),
		});
		const provider = await checkPodman({ runner: noProvider.run });
		assert.equal(provider.ok, false);
		assert.match(provider.ok === false ? provider.fix : "", /podman-compose/);
	});

	test("a mason on loopback is refused with the environment change, and anything else is not", () => {
		for (const host of ["127.0.0.1", "::1", "localhost", " 127.0.0.1 "]) {
			assert.match(loopbackRefusal(host) ?? "", /HOST=0\.0\.0\.0 mason up/, host);
		}
		for (const host of ["0.0.0.0", "::", "192.168.1.10", "mason.local"]) {
			assert.equal(loopbackRefusal(host), undefined, host);
		}
	});

	test("listening() is a real probe: it answers for a socket and not for a closed port", async () => {
		const { createServer } = await import("node:net");
		const server = createServer();
		await new Promise<void>((ready) => server.listen(0, "127.0.0.1", () => ready()));
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		try {
			assert.equal(await listening("127.0.0.1", port), true);
			// A wildcard bind answers on loopback too, and `0.0.0.0` is not an address to connect to everywhere.
			assert.equal(await listening("0.0.0.0", port), true);
		} finally {
			await new Promise<void>((closed) => server.close(() => closed()));
		}
		assert.equal(await listening("127.0.0.1", port), false);
	});
});

describe("the four verbs", () => {
	test("are `podman compose -f <file> -p <project> <verb>`, so the project on disk is the project acted on", async () => {
		const { run, calls } = recorder();
		await up("/home/x/service/connectors/telegram/compose.yaml", "a1b2c3d4-telegram", { runner: run });
		await down("/home/x/service/connectors/telegram/compose.yaml", "a1b2c3d4-telegram", { runner: run });
		await ps("/home/x/service/connectors/telegram/compose.yaml", "a1b2c3d4-telegram", { runner: run });
		await logs("/home/x/service/connectors/telegram/compose.yaml", "a1b2c3d4-telegram", 5, { runner: run });
		assert.deepEqual(calls, [
			"podman compose -f /home/x/service/connectors/telegram/compose.yaml -p a1b2c3d4-telegram up -d",
			"podman compose -f /home/x/service/connectors/telegram/compose.yaml -p a1b2c3d4-telegram down",
			"podman compose -f /home/x/service/connectors/telegram/compose.yaml -p a1b2c3d4-telegram ps",
			"podman compose -f /home/x/service/connectors/telegram/compose.yaml -p a1b2c3d4-telegram logs --tail=5",
		]);
	});

	test("a failure keeps podman's own words, which is the whole of what the operator gets", async () => {
		const { run } = recorder({ "podman compose": new Error("podman compose -f x up -d exited 125: no such image") });
		await assert.rejects(up("/x/compose.yaml", "p", { runner: run }), /exited 125: no such image/);
	});
});

describe("the half of the restart policy no compose file carries", () => {
	test("says nothing when the unit is enabled or linked", async () => {
		for (const state of ["enabled", "linked", "static"]) {
			const { run } = recorder({ systemctl: { stdout: `${state}\n`, stderr: "" } });
			assert.equal(await bootPolicyFix({ runner: run }), undefined, state);
		}
	});

	test("names the two commands when it is not", async () => {
		const disabled = recorder({ systemctl: { stdout: "disabled\n", stderr: "" } });
		assert.match(
			(await bootPolicyFix({ runner: disabled.run })) ?? "",
			/systemctl --user enable podman-restart\.service.*loginctl enable-linger/s,
		);
	});

	test("says nothing on a machine that cannot answer, because an unanswered question is not a complaint", async () => {
		const noSystemd = recorder({ systemctl: new Error("Failed to connect to bus") });
		assert.equal(await bootPolicyFix({ runner: noSystemd.run }), undefined);
	});
});
