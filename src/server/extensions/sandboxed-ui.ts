/**
 * `generateSandboxedUi`: the agent streams an interactive HTML/CSS/JS widget that the web client renders in a
 * sandboxed iframe.
 *
 * Always installed — the client renders a widget whenever one arrives, so there is no toggle to hide it behind, and a
 * tool list that changes between turns is exactly the cache break this slice exists to remove.
 *
 * The prompt says one paragraph about this tool (see `GENERATIVE_UI_POINTER` in `../prompt.ts`); the design system, the
 * parameter ordering and the sandbox limits live in `skills/generative-ui/SKILL.md`, which the agent reads when it
 * decides to build something.
 *
 * A widget is something the reader sees, and `projection.ts` renders one only out of a call the model made itself: a
 * widget built from inside another tool is a nested call whose result goes back to the script instead. So `execute()`
 * refuses one, with the instruction that gets the widget in front of the reader.
 */
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { nestedRefusal } from "./nested.ts";

export const GenerateSandboxedUiParams = Type.Object({
	initialHeight: Type.Optional(Type.Number({ description: "Estimated height in pixels of the finished widget" })),
	placeholderMessages: Type.Optional(
		Type.Array(Type.String(), { description: "2-4 short progress messages shown while the widget streams" }),
	),
	css: Type.String({ description: "Complete CSS for the widget, emitted before any markup" }),
	html: Type.Array(Type.String({ description: "HTML chunk for the widget's body" })),
	jsFunctions: Type.Optional(Type.String({ description: "Named JS function declarations for behavior" })),
	jsExpressions: Type.Optional(
		Type.Array(Type.String({ description: "Synchronous JS statements invoking those functions" })),
	),
});

/**
 * What a script is told instead of a widget nobody would see: what happened, and what to do about it. Code mode turns
 * an error result into a rejection (`vendor/pi/packages/durable/src/codemode/codemode.ts:280-291`), so the text has to
 * say the call rejects — a script that read it as advice would carry on believing the reader had the widget.
 */
const WIDGET_NESTED_REFUSAL =
	"generateSandboxedUi cannot render from inside a script: the call rejects, and a widget built by a nested call never reaches the reader. Catch it and carry on with the script. Call generateSandboxedUi directly from the turn.";

export const generateSandboxedUiTool = defineTool({
	name: "generateSandboxedUi",
	description:
		"Render an interactive HTML/CSS/JS widget inline in the user's chat. Use for charts, diagrams, and calculators. Call this directly, never from inside a script: a widget built by a nested call never reaches the reader.",
	parameters: GenerateSandboxedUiParams,
	// The tool is a renderer: it produces no side effects and its result is the arguments themselves. A nested call
	// renders nothing, which is why it is answered with the instruction rather than with "UI generated".
	replay: "safe",
	execute: async (args, api) => {
		const refusal = nestedRefusal(api, WIDGET_NESTED_REFUSAL);
		if (refusal !== undefined) return refusal;
		return { output: [{ type: "text", text: "UI generated" }], details: args };
	},
});

export const GenerateSandboxedUiExtension = defineExtension({
	name: "sandboxed-ui",
	tools: [generateSandboxedUiTool],
});
