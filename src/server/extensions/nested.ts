/**
 * Whether a tool call was made from inside another tool — `tools.reply()` in a code-mode script — instead of by
 * the model itself.
 *
 * The ID is the whole test, and two facts make it honest. A nested call's ID is `<parentCallId>/<key>`
 * (`NestedToolSlot` in `vendor/pi/packages/durable/src/harness/live.ts:37`), and a key may not contain `/` (the `key`
 * option of `ToolExecutionApi.executeTool` in `vendor/pi/packages/durable/src/harness/types.ts`), so no nested ID can
 * be mistaken for a top-level one. A model-issued call carries the provider's own ID, which has no separator in it.
 *
 * The accepted residual risk is the one on the other side: a provider that issues a top-level ID containing `/` has
 * that call refused as though it were nested. It costs a rejected call that is answered with the instruction to call
 * the tool directly — which both descriptions already give, and the model follows — never a delivery nobody sees.
 */
import type { ToolExecutionApi } from "@earendil-works/pi-durable";

export function isNestedCall(api: Pick<ToolExecutionApi, "callId">): boolean {
	return api.callId.includes("/");
}

/**
 * What a tool answers a call it must not serve: the text, as an error result the caller has to deal with.
 *
 * The shape is one place because its meaning is: an error result reaches a script as a rejection, so every refusal says
 * what does not happen and what to do instead, and none of them is advice.
 */
export function refusal(text: string): { output: [{ type: "text"; text: string }]; isError: true } {
	return { output: [{ type: "text", text }], isError: true };
}

/**
 * What a tool answers a nested call with: the refusal, in `text`, as an error result the caller has to deal with.
 *
 * `undefined` for a top-level call, which is the tool's own business to answer: this only decides the nested case, so
 * both tools read the same way and neither can drift from the other.
 */
export function nestedRefusal(
	api: Pick<ToolExecutionApi, "callId">,
	text: string,
): { output: [{ type: "text"; text: string }]; isError: true } | undefined {
	if (!isNestedCall(api)) return undefined;
	return refusal(text);
}
