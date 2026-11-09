/**
 * Where a value comes from, for the two questions whose answer lives on another website.
 *
 * The wizard cannot open a browser for a person and read the key back, so the least it owes them is the page and the one
 * thing to do on it. A question carrying a `Journey` draws the address under its hint and opens it on `ctrl+o`; a question
 * whose answer has no row here draws nothing, because a guessed URL is worse than no URL: it sends a person to a page
 * that does not exist and makes them doubt the rest of the screen.
 *
 * Every entry is here because the address is one this repo would bet on. That is the whole rule, and it is why the
 * provider table covers sixteen of the forty-four providers pi-ai knows: the rest are environment credentials, OAuth, or
 * a console nobody here has opened. A provider with no row still works; it just explains itself with the sentence the
 * flow already wrote.
 *
 * `test/journeys.test.ts` holds the two halves: every catalog connector's secret variable has a row, and no row points
 * at an address that is not `https`.
 */
import type { Journey } from "./screen.ts";

/** Console pages that mint an API key, by the id pi-ai knows the provider by. */
const PROVIDERS: Readonly<Record<string, Journey>> = {
	anthropic: { url: "https://console.anthropic.com/settings/keys", what: "create a key and copy it" },
	cerebras: { url: "https://cloud.cerebras.ai", what: "copy the key from the API keys page" },
	deepseek: { url: "https://platform.deepseek.com/api_keys", what: "create a key and copy it" },
	fireworks: { url: "https://fireworks.ai/account/api-keys", what: "create a key and copy it" },
	google: { url: "https://aistudio.google.com/apikey", what: "create an API key and copy it" },
	groq: { url: "https://console.groq.com/keys", what: "create a key and copy it" },
	huggingface: { url: "https://huggingface.co/settings/tokens", what: "create a read token and copy it" },
	mistral: { url: "https://console.mistral.ai/api-keys", what: "create a key and copy it" },
	moonshotai: { url: "https://platform.moonshot.ai/console/api-keys", what: "create a key and copy it" },
	nvidia: { url: "https://build.nvidia.com", what: "pick a model, then copy the key it shows" },
	openai: { url: "https://platform.openai.com/api-keys", what: "create a key and copy it" },
	openrouter: { url: "https://openrouter.ai/keys", what: "create a key and copy it" },
	together: { url: "https://api.together.ai/settings/api-keys", what: "create a key and copy it" },
	xai: { url: "https://console.x.ai", what: "create a key and copy it" },
};

/**
 * The variables a connector's container needs, by name.
 *
 * `catalog/connectors.json` already says what each one is for (`prompt`); this table is only the page that issues it, so
 * the catalog stays the one place a connector is described and this one is the one place an address is.
 */
const VARIABLES: Readonly<Record<string, Journey>> = {
	TELEGRAM_BOT_TOKEN: {
		url: "https://t.me/BotFather",
		what: "send /newbot, answer two questions, then copy the token it replies with",
	},
};

/** The page a provider's key is minted on, or nothing when this build has not been there. */
export function providerJourney(providerId: string): Journey | undefined {
	return PROVIDERS[providerId];
}

/** The page a connector variable comes from, or nothing when this build has not been there. */
export function variableJourney(variableName: string): Journey | undefined {
	return VARIABLES[variableName];
}

/** Every variable name this build can send a person to. A catalogue secret outside this set fails `test/journeys.test.ts`. */
export function knownVariables(): readonly string[] {
	return Object.keys(VARIABLES);
}
