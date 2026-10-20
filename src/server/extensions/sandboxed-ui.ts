/**
 * `generateSandboxedUi`: the agent streams an interactive HTML/CSS/JS widget that the web client renders in a
 * sandboxed iframe.
 *
 * Always installed — the client renders a widget whenever one arrives, so there is no toggle to hide it behind, and a
 * tool list that changes between turns is exactly the cache break this slice exists to remove.
 *
 * The resident section is a pointer, not the manual: the design system, the parameter ordering and the sandbox limits
 * live in `skills/generative-ui/SKILL.md`, which the agent reads when it decides to build something. That is ~450
 * tokens off every request in exchange for one `read` when a widget is actually wanted.
 */
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "typebox";

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

export const SandboxedUiInstructions = `You can answer with a live widget instead of prose: a chart, a dashboard, a calculator, a diagram.
Read the \`generative-ui\` skill before your first widget — it carries the parameter order the renderer depends on, the
design system, and the sandbox limits. Keep it out of context until you actually need it.`;

export const generateSandboxedUiTool = defineTool({
	name: "generateSandboxedUi",
	description:
		"Render an interactive HTML/CSS/JS widget inline in the user's chat. Use for charts, diagrams, and calculators.",
	parameters: GenerateSandboxedUiParams,
	// The tool is a renderer: it produces no side effects and its result is the arguments themselves.
	replay: "safe",
	execute: async (args) => ({ output: [{ type: "text", text: "UI generated" }], details: args }),
});

export const GenerateSandboxedUiExtension = defineExtension({
	name: "sandboxed-ui",
	tools: [generateSandboxedUiTool],
	sections: [section("generative_ui", () => SandboxedUiInstructions)],
});
