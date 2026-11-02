/**
 * MCP helpers: the two things a tools-face connector has to get right, and no MCP implementation.
 *
 * The SDK does not ship an MCP server. It ships the part the *contract* fixes: the approval marker a tool declares, and
 * the input schema shape mason reads. A connector keeps using `@modelcontextprotocol/sdk` (or any other) for the
 * transport, because inventing one would be exactly the mistake this protocol avoids on the other side.
 *
 * The approval marker is the connector author's statement about what an operation does. Mason never infers risk from a
 * tool's name, and never treats MCP's own `readOnlyHint`/`destructiveHint` annotations as authority: an annotation is a
 * claim, and the operator's trust in this connector's claims is a separate, explicit setting.
 */
import { APPROVAL, APPROVAL_META_KEY, type ApprovalMarker } from "@mason/protocol";

/** A JSON Schema fragment, which is all an MCP tool's `inputSchema` has to be. */
export type InputSchema = Readonly<Record<string, unknown>>;

export interface ToolDeclaration {
	/** The name mason will see. It is namespaced to the connector, so it does not have to be globally unique. */
	readonly name: string;
	/** One line. This is what the model reads before it decides to search for the tool at all. */
	readonly description: string;
	readonly inputSchema: InputSchema;
	/** `required` asks a person unless the call is denied outright. `notRequired` is only honoured when trusted. */
	readonly approval: ApprovalMarker | boolean;
	/** Anything else the connector's MCP server wants, passed through untouched. */
	readonly extra?: Readonly<Record<string, unknown>>;
}

/** The `_meta` object for one tool. `true` is `required`, because a boolean is what a hurried author writes. */
export function approvalMeta(approval: ApprovalMarker | boolean): Readonly<Record<string, unknown>> {
	const marker = approval === true ? APPROVAL.required : approval === false ? APPROVAL.notRequired : approval;
	return { [APPROVAL_META_KEY]: marker };
}

/**
 * The object to register with an MCP server. Every field except `extra` is MCP's own; `_meta` carries the marker mason
 * reads, in the namespace mason owns.
 */
export function declareTool(tool: ToolDeclaration): Record<string, unknown> {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
		...(tool.extra ?? {}),
		_meta: { ...(tool.extra?._meta as Record<string, unknown> | undefined), ...approvalMeta(tool.approval) },
	};
}

/**
 * Read a marker back off a tool description.
 *
 * The default is `required`: a tool that says nothing about its effects is a tool nobody can vouch for, and the safe
 * answer to "may this run without asking?" is always no. This function is the rule mason applies; it is here because a
 * connector's own tests want to assert on it, not because mason reads it from this package.
 */
export function readApprovalMarker(meta: unknown): ApprovalMarker {
	if (typeof meta !== "object" || meta === null) return APPROVAL.required;
	const marker = (meta as Record<string, unknown>)[APPROVAL_META_KEY];
	return marker === APPROVAL.notRequired ? APPROVAL.notRequired : APPROVAL.required;
}

/**
 * The one-line description rule, as a check a connector can run on itself.
 *
 * The description is what the model reads before it decides whether to look at the tool at all, so a blank one is a tool
 * nobody will ever call, and a paragraph one is a paragraph in a menu.
 */
export function describeProblem(description: string): string | undefined {
	const line = description.trim();
	if (line.length === 0) return "a tool needs one line: it is what the model reads";
	if (line.includes("\n")) return "a tool's description is one line, not a paragraph";
	if (line.length > 200) return "a tool's description is a line; anything longer belongs in the tool's own result";
	return undefined;
}
