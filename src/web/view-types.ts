/**
 * The JSON shapes the client reads out of `ConversationView`. They mirror pi-durable's own types, but the
 * client receives them as Chord state (`Type.Unknown()`), so they are described here rather than imported:
 * the browser bundle stays free of the server packages.
 */

export interface TextPart {
	type: "text";
	text: string;
}
export interface ThinkingPart {
	type: "thinking";
	thinking: string;
}
export interface ToolCallPart {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: JsonObject;
}
export type ContentPart = TextPart | ThinkingPart | ToolCallPart | { type: string };

/** One bucket of `pi.usage`: counters plus their cost. */
export interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	reasoning?: number;
	cacheWrite1h?: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface UserMessageLike {
	role: "user";
	content: string | ContentPart[];
	timestamp?: number;
}
export interface AssistantMessageLike {
	role: "assistant";
	content: ContentPart[];
	stopReason?: string;
	isError?: boolean;
	errorMessage?: string;
	timestamp?: number;
	durationMs?: number;
	usage?: UsageLike;
}
export interface ToolResultMessageLike {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextPart | { type: string })[];
	isError?: boolean;
	durationMs?: number;
}
export interface SystemMessageLike {
	role: "system";
	content: string;
	sections?: Record<string, string | null>;
	toolsAdded?: { name: string }[];
	toolsRemoved?: { name: string }[];
}
export type MessageLike =
	| UserMessageLike
	| AssistantMessageLike
	| ToolResultMessageLike
	| SystemMessageLike
	| { role: string };

export interface ToolDiagnosticLike {
	severity: "info" | "warn" | "error";
	message: string;
	code?: string;
}

/** `pi.live.tools`: one model-issued call of the current round. */
export interface ToolSlotLike {
	callId: string;
	name: string;
	status: "pending" | "running" | "done";
	output?: string;
	droppedBytes?: number;
	droppedLines?: number;
	details?: JsonValue;
	diagnostics?: ToolDiagnosticLike[];
	taskId?: number;
	entry?: number;
}

/** `pi.live.nestedTools`: a call a running tool made through `executeTool()`. */
export interface NestedToolSlotLike {
	callId: string;
	name: string;
	status: "pending" | "running" | "done";
	output?: string;
	droppedBytes?: number;
	droppedLines?: number;
	details?: JsonValue;
	diagnostics?: ToolDiagnosticLike[];
	arguments?: JsonObject;
	parentCallId: string;
	parentTaskId?: number;
	taskId?: number;
	summary?: { isError: boolean; durationMs?: number; usage?: UsageLike; error?: string };
}

export interface CompactionStatusLike {
	taskId: number;
	reason: string;
	blocking: boolean;
	attempt: number;
	retry?: { at: number; error: string };
}

export interface LiveStateLike {
	run?: { taskId: number; inputs: number[] };
	generation?: {
		attempt: number;
		message?: AssistantMessageLike;
		retry?: { at: number; error: string };
		deferred?: { pollAt: number };
	};
	tools?: ToolSlotLike[];
	nestedTools?: NestedToolSlotLike[];
	compactions?: CompactionStatusLike[];
	compactionFailure?: { taskId: number; reason: string; error: string };
}

export interface InboxItemLike {
	id: number;
	mode: "steer" | "followUp" | "write";
	content?: unknown;
	entry?: { kind: string; data?: JsonObject };
}

export interface InboxStateLike {
	items: InboxItemLike[];
}

/** `pi.agent`: the conversation's model selection, extensions, tools and working directory. */
export interface AgentDocLike {
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	extensions?: string[] | { add?: string[]; remove?: string[] };
	tools?: string[] | { remove: string[] };
	cwd?: string;
	instructions?: string;
}

/** `pi.usage`: the conversation's spend, per model and per tool. */
export interface UsageStateLike {
	models: Record<string, UsageLike>;
	tools: Record<string, UsageLike>;
}

/** `pi.provider`: the conversation's provider-facing session identity. */
export interface ProviderStateLike {
	sessionId: string;
}

export interface EntryLike {
	id: number;
	kind: string;
	data?: JsonObject;
	model?: MessageLike[];
	head?: number;
	byTaskId?: number;
}

export interface ConversationViewLike {
	conversation: { id: number };
	entries: EntryLike[];
	docs: Record<string, unknown>;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export function live(view: ConversationViewLike | undefined): LiveStateLike | undefined {
	return view?.docs["pi.live"] as LiveStateLike | undefined;
}

export function inbox(view: ConversationViewLike | undefined): InboxStateLike | undefined {
	return view?.docs["pi.inbox"] as InboxStateLike | undefined;
}

export function agentDoc(view: ConversationViewLike | undefined): AgentDocLike | undefined {
	return view?.docs["pi.agent"] as AgentDocLike | undefined;
}

export function usage(view: ConversationViewLike | undefined): UsageStateLike | undefined {
	return view?.docs["pi.usage"] as UsageStateLike | undefined;
}

export function provider(view: ConversationViewLike | undefined): ProviderStateLike | undefined {
	return view?.docs["pi.provider"] as ProviderStateLike | undefined;
}

/** The one message an entry carries; `pi.user`, `pi.assistant` and `pi.tool-result` carry exactly one. */
export function entryMessage(entry: EntryLike | undefined): MessageLike | undefined {
	return entry?.model?.[0];
}

export function isThinkingBlock(block: ContentPart): block is ThinkingPart {
	return block.type === "thinking" && typeof (block as { thinking?: unknown }).thinking === "string";
}
export function isTextBlock(block: ContentPart): block is TextPart {
	return block.type === "text" && typeof (block as { text?: unknown }).text === "string";
}
export function isToolCall(block: ContentPart): block is ToolCallPart {
	return block.type === "toolCall" && typeof (block as { id?: unknown }).id === "string";
}

/** The content blocks of a message; a plain string user message has none. */
export function blocksOf(message: MessageLike | undefined): ContentPart[] {
	const content = (message as { content?: unknown } | undefined)?.content;
	return Array.isArray(content) ? (content as ContentPart[]) : [];
}

export function textOf(message: MessageLike | undefined): string {
	if (message === undefined) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				const item = part as { type?: string; text?: string };
				return item.type === "text" ? (item.text ?? "") : "";
			})
			.join("");
	}
	return "";
}

export function thinkingOf(message: MessageLike | undefined): string {
	if (message === undefined) return "";
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const item = part as { type?: string; thinking?: string };
			return item.type === "thinking" ? (item.thinking ?? "") : "";
		})
		.join("");
}

export function toolCallsOf(message: MessageLike | undefined): ToolCallPart[] {
	if (message === undefined) return [];
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	return content.filter((part): part is ToolCallPart => (part as { type?: string }).type === "toolCall");
}

/** The hook data an `app.hook` entry carries. */
export function hookData(entry: EntryLike): {
	hookId: string;
	hookName: string;
	firedAt: string;
	payload: string | null;
} {
	const data = (entry.data ?? {}) as { hookId?: string; hookName?: string; firedAt?: string; payload?: unknown };
	return {
		hookId: data.hookId ?? "",
		hookName: data.hookName ?? "event",
		firedAt: data.firedAt ?? "",
		payload: typeof data.payload === "string" ? data.payload : null,
	};
}
