/**
 * Proving a provider before anything is stored: the list a wizard offers, and the one real completion `mason init` makes.
 *
 * openclaw's rule is the one this file exists for — "verifies that connection, persists only the working route"
 * (`docs/research/openclaw-cli.md` §1.6). A key that is stored before it is tried is a bot that boots into a provider
 * error on its first turn, with no command that says which of the three values was wrong. So `mason init` asks for the
 * three, sends one completion through the same `Models` the harness uses, and writes only what answered.
 *
 * The offline provider is a first-class answer here, not a test hook bolted on: `PI_FAUX_MODEL=1` plays a scripted
 * "ok", which is how a first run is driven in CI and in `test/onboard.test.ts` without a network or a key.
 *
 * The provider list and the model list are pi's own catalogs (`ModelRuntime` with the network off), because a provider
 * mason does not ship a list of is a provider nobody can choose. Mason's code reads no store of pi's here: the key it
 * sets is a runtime key, held for this process only, and the store mason writes is `common/auth.json`.
 */
import { randomUUID } from "node:crypto";
import type { AssistantMessage, Models, TextContent } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentModelRef } from "./runtime.ts";

/** What a wizard talks to: the model catalog, and the runtime a key is set on when there is one. */
export interface ProviderAccess {
	readonly models: Models;
	/** The runtime `setRuntimeApiKey` is called on; absent for the offline provider, which has no credential. */
	readonly runtime?: ModelRuntime;
	readonly faux: boolean;
}

/** Open the catalogs: pi's builtin providers with the network off, or the scripted offline provider. */
export async function openProviders(options: { readonly faux?: boolean } = {}): Promise<ProviderAccess> {
	if (options.faux === true) {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		// One answer, consumed by the one verification call: the offline provider has no other script in this process.
		faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);
		return { models, faux: true };
	}
	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	return { models: runtime, runtime, faux: false };
}

/** The provider ids a person may choose, sorted so the list reads the same twice. */
export function providerIds(access: ProviderAccess): string[] {
	return access.models
		.getProviders()
		.map((provider) => provider.id)
		.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** The models one provider knows, in catalog order. Empty for a provider that publishes none. */
export function modelIds(access: ProviderAccess, provider: string): string[] {
	return access.models.getModels(provider).map((model) => model.id);
}

/** A row a wizard can draw: the id a person picks, and one line of what it holds. */
export interface ModelChoice {
	readonly value: string;
	readonly label: string;
	readonly description: string;
}

/** Thousands, rounded, because 200000 and 200k are the same answer and one of them fits beside a label. */
function contextSize(tokens: number): string {
	return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;
}

/**
 * One provider's models as a list to choose from rather than an id to remember: the catalog this build already read to
 * offer the provider, drawn per row.
 *
 * The label is the id, because the id is what gets written and what a person will type to filter. What it holds is the
 * description, in the order that decides a choice: room for a conversation, then whether it thinks, then whether it can
 * be shown a picture.
 */
export function modelChoices(access: ProviderAccess, provider: string): ModelChoice[] {
	return access.models.getModels(provider).map((model) => {
		const facts = [`${contextSize(model.contextWindow)} context`];
		if (model.reasoning) facts.push("reasoning");
		if (model.input.includes("image")) facts.push("images");
		return { value: model.id, label: model.id, description: facts.join(" · ") };
	});
}

/**
 * Send one real completion and return its text, or throw with the sentence a person can act on.
 *
 * The prompt asks for one word, so a successful answer is short and a failure is the provider's own message rather than
 * a wall of generated prose. Nothing is retried: this is a check, and a check that retries is a check that hides the
 * outage it was asked about.
 */
export async function verifyCompletion(access: ProviderAccess, ref: AgentModelRef, key?: string): Promise<string> {
	if (access.runtime !== undefined && key !== undefined) await access.runtime.setRuntimeApiKey(ref.provider, key);
	const model = access.models.getModel(ref.provider, ref.modelId);
	if (model === undefined) {
		const known = modelIds(access, ref.provider);
		throw new Error(
			`"${ref.provider}" has no model "${ref.modelId}"` +
				(known.length === 0
					? ": that provider publishes no models this build knows"
					: `: it knows ${known.slice(0, 12).join(", ")}${known.length > 12 ? ", …" : ""}`),
		);
	}
	let answer: AssistantMessage;
	try {
		answer = await access.models.complete(
			model,
			{
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "Reply with the single word: ok" }],
						timestamp: Date.now(),
					},
				],
			},
			// OpenCode (and a custom provider pointing at opencode.ai) routes on `x-opencode-session`, which pi-ai's
			// provider fills from this option: a check without one is a 400 before the key is even looked at. Any id
			// does, because the verify is its own conversation and nothing follows it.
			{ sessionId: randomUUID() },
		);
	} catch (error) {
		throw new Error(`the provider did not answer: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (answer.stopReason === "error")
		throw new Error(`the provider answered with an error: ${answer.errorMessage ?? "no message"}`);
	const text = answer.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
	if (text === "") throw new Error("the provider answered with no text: the key works and the model said nothing");
	return text;
}
