/**
 * Split execution environment: the harness never touches the host directly.
 * Every tool call goes through `@earendil-works/pi-env` (`RemoteExecutionEnv` over a `Connection`).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, localDaemon, RemoteExecutionEnv, sshConnection, type SshTarget } from "@earendil-works/pi-env";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export interface RuntimeEnvManager {
	envFor(input: { conversationId: string; cwd?: string }): Promise<ExecutionEnv>;
	close(): Promise<void>;
}

export interface RuntimeEnvManagerOptions {
	/** Default working directory when a conversation has no `cwd` of its own. */
	workspaceDir: string;
	/** When set, every tool call runs on this SSH target instead of locally. */
	ssh?: SshTarget;
	onLog?(text: string): void;
}

/**
 * The only variables a tool sees, and therefore the only ones the model can read back.
 *
 * A tool call is arbitrary code in the agent's own shell, so whatever the server process carries in its environment is
 * one `echo $NAME` away from the transcript and the provider. That set is not obvious from outside: an API key exported
 * for one experiment, a `Database_URL`, a `MASON_*` switch. So the daemon gets the variables a shell needs to be a
 * shell, and nothing else — the allowlist is the whole rule, not a filter over an inherited set.
 *
 * `PI_ENV_*` is deliberately absent: the parent consumes it to decide *where* to run, and a tool has no business
 * knowing the host or the identity file.
 */
export const DAEMON_ENV_ALLOWED = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"TZ",
	"TMPDIR",
] as const;

/** `env -i <assignments> <program>`: the one portable way to start a child with an environment of our choosing. */
const ENV_BINARY = existsSync("/usr/bin/env") ? "/usr/bin/env" : "env";

/** The daemon's environment: the allowlist above, with a working shell's defaults for what is missing. */
export function daemonEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of DAEMON_ENV_ALLOWED) {
		const value = source[name];
		if (value !== undefined && value !== "") env[name] = value;
	}
	env.PATH ??= "/usr/local/bin:/usr/bin:/bin";
	env.HOME ??= homedir();
	// Without a UTF-8 locale, `bash` mangles every non-ASCII path it touches.
	env.LANG ??= "C.UTF-8";
	return env;
}

/**
 * The command that starts the daemon with `daemonEnv()` and nothing else.
 *
 * `Connection` spawns its child with the parent's environment and offers no option to change that, and `vendor/pi` is
 * read-only here. `env -i` is the standard tool for exactly this: it clears the environment and sets what follows.
 */
export function daemonCommand(program: string, source: NodeJS.ProcessEnv = process.env): string[] {
	const assignments = Object.entries(daemonEnv(source)).map(([name, value]) => `${name}=${value}`);
	return [ENV_BINARY, "-i", ...assignments, program];
}

/** Reads the `PI_ENV_SSH_*` environment into an SSH target, or `undefined` when no host is configured. */
export function sshTargetFromEnv(env: NodeJS.ProcessEnv = process.env): SshTarget | undefined {
	const host = env.PI_ENV_SSH_HOST;
	if (host === undefined || host === "") return undefined;
	const knownHostsFile = env.PI_ENV_SSH_KNOWN_HOSTS;
	if (knownHostsFile === undefined || knownHostsFile === "") {
		throw new Error("PI_ENV_SSH_HOST is set but PI_ENV_SSH_KNOWN_HOSTS is not; refusing an unverified host key");
	}
	return {
		host,
		knownHostsFile,
		hostKeyAlias: env.PI_ENV_SSH_ALIAS ?? `pi-env-${host}`,
		...(env.PI_ENV_SSH_USER === undefined ? {} : { user: env.PI_ENV_SSH_USER }),
		...(env.PI_ENV_SSH_PORT === undefined ? {} : { port: Number(env.PI_ENV_SSH_PORT) }),
		...(env.PI_ENV_SSH_IDENTITY === undefined ? {} : { identityFile: env.PI_ENV_SSH_IDENTITY }),
	};
}

/**
 * One `Connection` (the framed daemon protocol on a pipe) shared by every conversation, with one
 * `RemoteExecutionEnv` per conversation and working directory: the boundary a container or SSH target
 * would replace, exercised over the local daemon by default.
 */
export function createRuntimeEnvManager(options: RuntimeEnvManagerOptions): RuntimeEnvManager {
	const environments = new Map<string, RemoteExecutionEnv>();
	let connection: Connection | undefined;

	const connectionFor = (): Connection => {
		if (connection !== undefined) return connection;
		const onLog = options.onLog;
		connection =
			options.ssh === undefined
				? new Connection({ command: daemonCommand(localDaemon()), ...(onLog === undefined ? {} : { onLog }) })
				: sshConnection({ ...options.ssh, ...(onLog === undefined ? {} : { onLog }) }).connection;
		return connection;
	};

	return {
		async envFor(input) {
			const cwd = input.cwd ?? options.workspaceDir;
			const key = `${input.conversationId}\u0000${cwd}`;
			const existing = environments.get(key);
			if (existing !== undefined) return existing;
			const shared = connectionFor();
			const id = options.ssh === undefined ? "pi-env:local" : `pi-env:${options.ssh.host}`;
			const env = new RemoteExecutionEnv({ connection: shared, id, cwd });
			environments.set(key, env);
			return env;
		},
		async close() {
			environments.clear();
			const current = connection;
			connection = undefined;
			current?.close();
		},
	};
}
