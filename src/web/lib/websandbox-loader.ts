// Adapted from `vendor/open-intelligent-ui/apps/app/src/components/generative-ui/open-generative-ui/websandbox-loader.ts`.
/** One sandboxed iframe and how to run code inside it. */
export interface SandboxInstance {
	iframe: HTMLIFrameElement;
	promise: Promise<unknown>;
	run: (code: string) => Promise<unknown>;
	destroy: () => void;
}

export interface WebsandboxModule {
	create(
		localApi: Record<string, (args: unknown) => unknown>,
		options: { frameContainer: HTMLElement; frameContent: string; allowAdditionalAttributes: string },
	): SandboxInstance;
}

type WebsandboxNamespace = { default?: unknown };

/**
 * `@jetbrains/websandbox` ships a UMD bundle with its own webpack `default`, so a CJS-aware bundler
 * wraps it once more: the class is `mod.default.default`.
 */
export async function loadWebsandbox(): Promise<WebsandboxModule> {
	const mod = (await import("@jetbrains/websandbox")) as unknown as WebsandboxNamespace;
	const candidate = (mod.default ?? mod) as { default?: unknown };
	return (candidate.default ?? candidate) as WebsandboxModule;
}

/** The host API a widget reaches through `Websandbox.connection.remote`. */
export interface WidgetBridge {
	sendPrompt(args: { text: string }): Promise<unknown>;
	openLink(args: { url: string }): Promise<unknown>;
}
