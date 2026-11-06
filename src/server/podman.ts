/**
 * The podman driver: four verbs, one command runner, and the two checks setup makes before it starts anything.
 *
 * The CLI starts the connector container (#145), so mason has a dependency it did not have before, and the whole point
 * of this file is that the dependency is one thin seam. `podman compose` is the interface: the compose project
 * `connector-compose.ts` renders *is* the unit of work, so `up`, `down`, `ps` and `logs` map onto it and nothing here
 * knows what a service is. The runner is a parameter with the real one as its default, the same shape
 * `RunRetrySupervisor` uses for its timer (`run-retry.ts`): a test never starts a container, and a test that wanted to
 * would pass a runner that records argv.
 *
 * The checks are separate from the verbs because they answer a different question — "can this run at all" rather than
 * "do this" — and because each has an exact fix a person can type. A stack trace from `podman compose up` is a first run
 * that ends in a bug report; a sentence naming `HOST=0.0.0.0 mason up` is a first run that ends in a second attempt.
 */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";

/** What a command printed. A non-zero exit is an error with this as its detail; nothing here interprets the output. */
export interface CommandOutput {
	readonly stdout: string;
	readonly stderr: string;
}

/** Runs one command and resolves with what it printed, or rejects with its exit code and stderr. */
export type CommandRunner = (command: string, argv: readonly string[]) => Promise<CommandOutput>;

/** The real runner: argv, no shell, so nothing a name or a path holds can become a second command. */
export const spawnRunner: CommandRunner = (command, argv) =>
	new Promise((done, fail) => {
		const child = spawn(command, [...argv], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error: Error) => {
			fail(error);
		});
		child.on("exit", (code) => {
			if (code === 0) done({ stdout, stderr });
			else fail(new Error(`${command} ${argv.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`));
		});
	});

export interface PodmanOptions {
	/** Injected for tests; the real driver shells out to `podman`. */
	readonly runner?: CommandRunner;
}

/** The compose invocation, without a verb: `podman compose -f <file> -p <project>`. */
function compose(argv: readonly string[], composeFile: string, project: string): readonly string[] {
	return ["compose", "-f", composeFile, "-p", project, ...argv];
}

/**
 * Whether a connector can be started at all: podman, and a compose provider behind it.
 *
 * The second check is the one worth having. `podman compose` is a shim over `docker-compose` or `podman-compose`, and a
 * release that ships podman without one fails at `up` with a message about a missing provider that says nothing about
 * what to install. Asking first turns that into the package name.
 */
export async function checkPodman(
	options: PodmanOptions = {},
): Promise<{ readonly ok: true } | { readonly ok: false; readonly fix: string }> {
	const runner = options.runner ?? spawnRunner;
	try {
		await runner("podman", ["--version"]);
	} catch {
		return {
			ok: false,
			fix:
				"podman is not installed (or not on PATH). Install it, and then run `mason setup` again: " +
				"https://podman.io/docs/installation",
		};
	}
	try {
		await runner("podman", ["compose", "version"]);
	} catch {
		return {
			ok: false,
			fix:
				"podman is installed but `podman compose` has no provider. Install `podman-compose` (or `docker-compose`) " +
				"and run `mason setup` again.",
		};
	}
	return { ok: true };
}

/**
 * The refusal for a mason bound to loopback.
 *
 * A container is another network namespace: `127.0.0.1` inside it is the container, so a connector dialing
 * `host.containers.internal` reaches the host and finds nothing there. Setup cannot move the bind of a process that is
 * already running, so it names the change and stops — started anyway, the container would restart-loop with `ECONNREFUSED`
 * and the person would have a stack to read instead of a sentence.
 */
export function loopbackRefusal(hostname: string): string | undefined {
	const host = hostname.trim().toLowerCase();
	// `0.0.0.0`, `::` and any concrete address are reachable from the host's namespace; a name resolves to something
	// this check cannot see, so it is given the benefit of the doubt rather than a refusal it may not deserve.
	const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
	if (!loopback) return undefined;
	return (
		`mason is bound to ${hostname}, and a container cannot reach the host's loopback. Start it with ` +
		"`HOST=0.0.0.0 mason up` and run this again"
	);
}

/**
 * Whether something is accepting connections on `host:port`, so a setup that is about to start a container can say
 * "mason is not running" instead of leaving the connector to crash-loop against a closed port.
 */
export async function listening(hostname: string, port: number, timeoutMs = 1_000): Promise<boolean> {
	// A wildcard bind answers on loopback too, and `0.0.0.0` is not an address to connect to on every platform.
	const host = hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;
	return new Promise((answer) => {
		const socket = createConnection({ host, port });
		const settle = (open: boolean): void => {
			socket.removeAllListeners();
			socket.destroy();
			answer(open);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => settle(true));
		socket.once("timeout", () => settle(false));
		socket.once("error", () => settle(false));
	});
}

/** `podman compose up -d`: starts the project, detached, and comes back once it is up. The output is podman's own. */
export async function up(composeFile: string, project: string, options: PodmanOptions = {}): Promise<string> {
	const { stdout, stderr } = await (options.runner ?? spawnRunner)(
		"podman",
		compose(["up", "-d"], composeFile, project),
	);
	return `${stdout}${stderr}`.trim();
}

/** `podman compose down`: stops the project and removes its container. The rendered file stays; `up` reuses it. */
export async function down(composeFile: string, project: string, options: PodmanOptions = {}): Promise<string> {
	const { stdout, stderr } = await (options.runner ?? spawnRunner)("podman", compose(["down"], composeFile, project));
	return `${stdout}${stderr}`.trim();
}

/** `podman compose ps`: the containers of one project, in podman's table format. */
export async function ps(composeFile: string, project: string, options: PodmanOptions = {}): Promise<string> {
	const { stdout } = await (options.runner ?? spawnRunner)("podman", compose(["ps"], composeFile, project));
	return stdout.trim();
}

/**
 * What the operator still has to do for the container to come back after a reboot, or `undefined` when nothing is owed.
 *
 * `restart: always` is only the compose half. The half that starts a marked container when the machine boots is
 * `podman-restart.service`, and on a rootless session it needs `loginctl enable-linger` beside it, because until the
 * user's systemd is running there is nothing to start it (`deploy/README.md` says the same for a deployment). No file
 * mason writes can enable either, so this is a question rather than a change: setup prints the two commands and gets on
 * with it.
 *
 * A machine without a user session — a container, a CI job — cannot answer, and an unanswered question is not a
 * complaint, which is why a failing `systemctl` says nothing rather than guessing.
 */
export async function bootPolicyFix(options: PodmanOptions = {}): Promise<string | undefined> {
	let state: string;
	try {
		const { stdout } = await (options.runner ?? spawnRunner)("systemctl", [
			"--user",
			"is-enabled",
			"podman-restart.service",
		]);
		state = stdout.trim();
	} catch {
		return undefined;
	}
	// `enabled` is the obvious answer and `linked` is the one NixOS gives: both mean the unit is wired into a target, and
	// so does `static`. `disabled`, `masked` and an empty answer do not.
	if (/^(enabled|linked|static)$/m.test(state)) return undefined;
	return (
		"`restart: always` brings the container back when it dies, but nothing starts it at boot yet: enable " +
		"`systemctl --user enable podman-restart.service` and `loginctl enable-linger $USER`"
	);
}

/** `podman compose logs`: the last `tail` lines, for the one question a first run asks — why it did not connect. */
export async function logs(
	composeFile: string,
	project: string,
	tail = 50,
	options: PodmanOptions = {},
): Promise<string> {
	const { stdout, stderr } = await (options.runner ?? spawnRunner)(
		"podman",
		compose(["logs", `--tail=${tail}`], composeFile, project),
	);
	return `${stdout}${stderr}`.trim();
}
