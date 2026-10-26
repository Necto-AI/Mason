/**
 * The commands a chat can give mason, from this container's side.
 *
 * The vocabulary is mason's (`src/server/events.ts`): one closed set, declared per integration, and a name mason has not
 * been told to act on for this integration comes back as an ordinary message. What this file owns is the relay's own two
 * duties: the line each command carries in `/help`, and the sentence that says everything else is still a message.
 *
 * **`/help` is answered here and never posted to mason.** It is the relay describing the vocabulary it forwards, and a
 * question about the interface does not need the agent woken up for it: a model turn for a fixed paragraph is a bill for
 * nothing a person cannot be told directly. The list is the closed set rather than this integration's declaration,
 * because the relay cannot read `integrations.json` — so the sentence is careful to say that a command the integration
 * has not declared arrives as a message.
 */
export interface ChatCommand {
	/** The word after the slash, as mason knows it. */
	readonly name: string;
	/** What `/help` says it does, in a sentence fragment a person reads. */
	readonly description: string;
}

/**
 * What the relay forwards, in the order `/help` lists it: stop first, because it is the one a person needs while
 * something is already running.
 */
export const COMMANDS: readonly ChatCommand[] = [
	{ name: "stop", description: "stop the turn that is running" },
	{ name: "compact", description: "summarise the conversation so far, with optional instructions" },
	{ name: "clear", description: "forget the conversation and start again" },
	{ name: "status", description: "what the agent is doing, and what is connected" },
];

/** The one message `/help` answers with: the commands, what each does, and what becomes of anything else. */
export const HELP_TEXT = [
	"mason understands these commands in this chat, when the integration declares them:",
	...COMMANDS.map((command) => `/${command.name}: ${command.description}`),
	"Anything else you type, including any other /word, arrives as a message.",
].join("\n");

/**
 * The text after the slash, for a message that is a command candidate, and nothing for one that is not.
 *
 * The test is the leading slash alone, because only mason can say whether a word means anything: `/start`, `/foo` and a
 * mistaken `/stopp` all become candidates, come back `handled: false`, and are sent as the messages they are. A bare
 * slash is not a candidate at all — there is no word to ask about, and the message says exactly that.
 */
export function commandIn(text: string): string | undefined {
	if (!text.startsWith("/")) return undefined;
	const command = text.slice(1).trim();
	return command === "" ? undefined : command;
}

/** Whether a candidate is this container's own: `/help`, and `/help` with words after it that change nothing. */
export function isHelp(command: string): boolean {
	return command === "help" || command.startsWith("help ");
}
