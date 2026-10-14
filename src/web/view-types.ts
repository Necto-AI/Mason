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

export interface UserMessageLike {
	role: "user";
	content: string | ContentPart[];
}
export interface AssistantMessageLike {
	role: "assistant";
	content: ContentPart[];
	stopReason?: string;
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

export interface EntryLike {
	id: number;
	kind: string;
	data?: JsonObject;
	model?: MessageLike[];
	head?: number;
}

export interface ToolSlotLike {
	callId: string;
	name: string;
	status: "pending" | "running" | "done";
	output?: string;
	details?: JsonObject;
	taskId?: number;
}

export interface LiveStateLike {
	run?: { taskId: number; inputs: number[] };
	generation?: { attempt: number; message?: AssistantMessageLike; retry?: { at: number; error: string } };
	tools?: ToolSlotLike[];
	compactions?: { taskId: number; reason: string; attempt: number }[];
	compactionFailure?: { reason: string; error: string };
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

export interface AgentDocLike {
	model?: { provider: string; modelId: string };
	extensions?: string[];
	tools?: string[];
	cwd?: string;
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

/** The hook data a `app.hook` entry carries. */
export function hookData(entry: EntryLike): { hookName: string; firedAt: string; hookId: string } {
	const data = (entry.data ?? {}) as { hookName?: string; firedAt?: string; hookId?: string };
	return { hookName: data.hookName ?? "event", firedAt: data.firedAt ?? "", hookId: data.hookId ?? "" };
}
