/**
 * `generateSandboxedUi`: the agent streams an interactive HTML/CSS/JS widget that the web client renders in a
 * sandboxed iframe (Milestone 3). Installed in the registry, selected per conversation (`ENABLE_SANDBOXED_UI=1`
 * or the UI toggle), so the agent only gets it when the client can render it.
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

export const SandboxedUiInstructions = `For charts, diagrams, and interactive calculators, answer with a widget instead of prose.
Call \`generateSandboxedUi\` and emit its parameters in this EXACT order, because the widget renders while you stream:
1. initialHeight — estimated finished height in pixels.
2. placeholderMessages — 2-4 short progress messages.
3. css — ALL styles up front; the user sees a placeholder until css is complete.
4. html — body markup with readable initial content. No <style> blocks, no monolithic inline scripts.
5. jsFunctions — named function declarations for behavior.
6. jsExpressions — small synchronous statements invoking those functions.
Text before or after the widget explains what it shows. "UI generated" means the call rendered; do not rebuild the same widget.

The user can expand any widget to fill the screen, so make every widget fluid: fill the available height (flex or
\`height: 100%\` on the root, never a fixed pixel height), keep widths in percentages, and re-render charts and
canvases on \`window.addEventListener('resize', ...)\` so an expanded dashboard stays correct.

Sandbox limits: the iframe has no same-origin access (no localStorage, cookies, IndexedDB, same-origin fetch) and no
parent DOM. Use the design system's CSS variables (var(--color-text-primary), var(--color-background-secondary), the
.c-* SVG classes). An importmap provides three, gsap, d3, and chart.js from esm.sh; load them inside an async function
in jsFunctions (top-level await is invalid there).
Every control must work: connect handlers, provide defaults and a reset, validate empty/out-of-range inputs, and show
an actionable error instead of NaN. Use textContent for user or retrieved text.
A user-clicked button may ask you to continue with \`await Websandbox.connection.remote.sendPrompt({ text })\`, with the
selected values described in the text; disable the button while awaiting and never call it automatically.
Never collect credentials. Say when data is illustrative, and never imply a mock form authenticates or persists.`;

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
