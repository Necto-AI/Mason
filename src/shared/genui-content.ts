// The widget content a `generateSandboxedUi` call carries, adapted from the CopilotKit
// `OpenGenerativeUIContentSchema` (`vendor/open-intelligent-ui/.../open-generative-ui/schema.ts`).
//
// Server-side this maps a call's arguments to the artifact the reader sees; the client only receives the result, so a
// widget payload crosses the wire as content, never as tool-call arguments. Shared, because both sides spell it.

/** The `generateSandboxedUi` arguments this module reads. */
type Args = { readonly [key: string]: unknown };

export interface OpenGenUIContent {
	initialHeight?: number;
	placeholderMessages?: string[];
	generating?: boolean;
	css?: string;
	cssComplete?: boolean;
	html?: string[];
	htmlComplete?: boolean;
	jsFunctions?: string;
	jsFunctionsComplete?: boolean;
	jsExpressions?: string[];
	jsExpressionsComplete?: boolean;
}

function stringOf(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function stringsOf(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

/**
 * Maps the arguments of a `generateSandboxedUi` call to renderer content.
 *
 * `settled` says the arguments are complete (they come from a committed assistant entry rather than from
 * `docs["pi.live"].generation.message`), which the strict parameter order makes observable: the model emits
 * `initialHeight`, `placeholderMessages`, `css`, `html`, `jsFunctions`, `jsExpressions`, in that order.
 *
 * Behavior (`jsFunctions`, `jsExpressions`) only reaches the sandbox once the call is settled: a half-streamed
 * function declaration would throw inside the iframe, and running the widget's scripts is not worth a broken
 * preview. The markup streams either way.
 */
export function contentFromToolCall(args: Args | undefined, settled: boolean): OpenGenUIContent {
	if (args === undefined) return { generating: !settled };
	const css = stringOf(args.css);
	const html = stringsOf(args.html);
	const jsFunctions = stringOf(args.jsFunctions);
	const jsExpressions = stringsOf(args.jsExpressions);
	const initialHeight = typeof args.initialHeight === "number" ? args.initialHeight : undefined;
	const placeholderMessages = stringsOf(args.placeholderMessages);
	return {
		generating: !settled,
		...(initialHeight === undefined ? {} : { initialHeight }),
		...(placeholderMessages === undefined ? {} : { placeholderMessages }),
		...(css === undefined ? {} : { css }),
		// `html` arrives after `css`, so its first element means the whole css parameter was emitted.
		cssComplete: html !== undefined,
		...(html === undefined ? {} : { html }),
		htmlComplete: settled || jsFunctions !== undefined || jsExpressions !== undefined,
		...(settled && jsFunctions !== undefined ? { jsFunctions } : {}),
		jsFunctionsComplete: settled && jsFunctions !== undefined,
		...(settled && jsExpressions !== undefined ? { jsExpressions } : {}),
		jsExpressionsComplete: settled && jsExpressions !== undefined,
	};
}
