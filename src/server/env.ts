/**
 * Split execution environment: the harness never touches the host directly.
 * Every tool call goes through `@earendil-works/pi-env` (`RemoteExecutionEnv` over a `Connection`).
 */
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
				? new Connection({ command: [localDaemon()], ...(onLog === undefined ? {} : { onLog }) })
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
