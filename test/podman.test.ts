/**
 * `src/server/podman.ts` — the driver, and the two questions setup asks before it starts a container.
 *
 * What is pinned is the shape of what mason runs, because the failure this file exists to prevent is a first run that
 * ends in podman's own error text. No test here starts a container: every call takes the command runner as a parameter,
 * and this suite hands it a recorder. That is the same reason the runner is a parameter at all, so a test that skipped it
 * would be testing a different program.
 */
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { describe, test } from "node:test";
import {
	bootPolicyFix,
	type CommandOutput,
	type CommandRunner,
	checkPodman,
	down,
	imageRegistry,
	listening,
	logs,
	loopbackRefusal,
	type ProbeOutput,
	type Prober,
	PullFailure,
	ps,
	pullFailure,
	spawnProbe,
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

describe("the one start failure that is not an install", () => {
	test("the registry host is the first segment when it names one, and Docker Hub when it does not", () => {
		assert.equal(imageRegistry("ghcr.io/denissud/mason-telegram:0.2.0"), "ghcr.io");
		assert.equal(imageRegistry("mason-telegram:0.2.0"), "docker.io");
		assert.equal(imageRegistry("localhost:5000/team/connector:1"), "localhost:5000");
	});

	test("a pull refusal names the image, the host and the repair, and keeps podman's words as the cause", () => {
		const error = new Error("podman compose up -d exited 125: unauthorized: authentication required");
		const failure = pullFailure("ghcr.io/denissud/mason-telegram:0.2.0", error);
		assert.ok(failure instanceof PullFailure);
		assert.match(failure.message, /could not pull ghcr\.io\/denissud\/mason-telegram:0\.2\.0 from ghcr\.io/);
		assert.match(failure.message, /podman login ghcr\.io/);
		assert.equal(failure.cause, error);
	});

	test("another failure is not a pull, so the caller keeps the driver's own error", () => {
		assert.equal(pullFailure("ghcr.io/x/y:1", new Error("podman compose up -d exited 125: no provider")), undefined);
	});
});

describe("the half of the restart policy no compose file carries", () => {
	/**
	 * A prober shaped like the real thing: `systemctl is-enabled` answers through its exit code, and `disabled`, `masked`
	 * or `linked` exit 1 with the word on stdout. A recorder that resolved with `disabled` and code 0 would pin a shape
	 * the binary never produces, which is exactly how the first version of this check passed a test and printed nothing
	 * in the field.
	 */
	function prober(answers: Readonly<Record<string, ProbeOutput | Error>>, calls: string[] = []): Prober {
		return async (command, argv) => {
			calls.push([command, ...argv].join(" "));
			const answer = answers[[command, ...argv].join(" ")] ??
				answers[command] ?? { code: 0, stdout: "", stderr: "" };
			if (answer instanceof Error) throw answer;
			return answer;
		};
	}

	test("says nothing when the unit is enabled and this user lingers", async () => {
		for (const state of ["enabled", "enabled-runtime"]) {
			assert.equal(
				await bootPolicyFix({
					probe: prober({
						"systemctl --user is-enabled podman-restart.service": { code: 0, stdout: `${state}\n`, stderr: "" },
						loginctl: { code: 0, stdout: "Linger=yes\n", stderr: "" },
					}),
				}),
				undefined,
				state,
			);
		}
	});

	test("names both commands when the unit is not enabled, exit code and all", async () => {
		for (const state of ["disabled", "masked", "linked", "linked-runtime", "static"]) {
			const advice = await bootPolicyFix({
				probe: prober({
					"systemctl --user is-enabled podman-restart.service": { code: 1, stdout: `${state}\n`, stderr: "" },
				}),
			});
			assert.match(
				advice ?? "",
				/systemctl --user enable podman-restart\.service && loginctl enable-linger/s,
				`${state} is not a boot policy`,
			);
		}
	});

	test("a unit that is enabled but a user who does not linger is still a container that stays down", async () => {
		const advice = await bootPolicyFix({
			probe: prober({
				"systemctl --user is-enabled podman-restart.service": { code: 0, stdout: "enabled\n", stderr: "" },
				loginctl: { code: 0, stdout: "Linger=no\n", stderr: "" },
			}),
		});
		assert.match(advice ?? "", /loginctl enable-linger/);
	});

	test("asks loginctl about a user by name, because the manager has no Linger to report", async () => {
		const calls: string[] = [];
		await bootPolicyFix({
			probe: prober(
				{
					"systemctl --user is-enabled podman-restart.service": { code: 0, stdout: "enabled\n", stderr: "" },
					loginctl: { code: 0, stdout: "Linger=no\n", stderr: "" },
				},
				calls,
			),
		});
		assert.deepEqual(calls[1], `loginctl show-user ${userInfo().username} --property=Linger`);
	});

	test("says nothing when systemctl exits 1 with nothing on stdout: a machine with no user manager", async () => {
		assert.equal(
			await bootPolicyFix({
				probe: prober({
					"systemctl --user is-enabled podman-restart.service": {
						code: 1,
						stdout: "",
						stderr: "Failed to connect to user scope bus via local transport",
					},
				}),
			}),
			undefined,
		);
	});

	test("says nothing when systemctl cannot run at all, because an unanswered question is not a complaint", async () => {
		assert.equal(
			await bootPolicyFix({ probe: prober({ systemctl: new Error("spawn systemctl ENOENT") }) }),
			undefined,
		);
	});

	test("the argv it asks with is one the real loginctl answers", async (context) => {
		// The question this file got wrong twice was answered by a mock, so this one asks the binary. A machine without a
		// user manager cannot answer and is not the case under test.
		const answer = await spawnProbe("loginctl", ["show-user", userInfo().username, "--property=Linger"]).catch(
			() => undefined,
		);
		if (answer === undefined || answer.stdout.trim() === "") {
			context.skip("no user manager on this machine to ask");
			return;
		}
		assert.match(answer.stdout.trim(), /^Linger=(yes|no)$/);
	});
});
