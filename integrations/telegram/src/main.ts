/**
 * The container: one long poll reading Telegram, one MCP endpoint lending mason three tools, one process.
 *
 * The two faces meet in two places and nowhere else. Nothing the poller reads is reachable through the tools face, and
 * nothing the tools face sends is fed back into the poller: an inbound message becomes a signed envelope and leaves; an
 * outbound message or file is a tool call and an API request. What they do share is the chat list, because `list_chats` is
 * how the agent answers the message it was just woken by, and the inbox, the one directory a file crosses in either
 * direction.
 *
 * Boot order is deliberate:
 *
 * 1. **Config, or a refusal naming the variable.** Nothing else can be decided without it.
 * 2. **`getMe`, because the mention stripper needs the bot's own username.** Without it a group message arrives with
 *    `@this_bot` still in the text, and the agent reads its own name as part of what somebody said. It is retried a few
 *    times and then refused: a bot that cannot identify itself cannot relay a group properly, and a restart loop is the
 *    supervisor's business, not a degraded mode. The command menu Telegram shows on `/` is set from there too, and a
 *    refusal there is one warning: a menu nobody sees is not a reason to stay down.
 * 3. **The tools face bound**, before the first poll: mason connects at its own boot and a container that answers
 *    `tools/list` late is one whose tools are missing for that whole run.
 * 4. **The poll**, which starts from now if this volume has never held an offset.
 *
 * `SIGTERM` aborts the poll, closes the MCP listener and the proxy's pool. A container that is asked to stop should stop
 * between batches rather than mid-write, and the offset that is not written is a batch that will be read again — as the
 * same fire, because its id never changes.
 */
import { ChatDirectory } from "./chats.ts";
import { COMMANDS } from "./commands.ts";
import { EventDoor } from "./door.ts";
import { readConfig, ConfigError, type Config } from "./env.ts";
import { directFetch, proxiedFetch } from "./fetch.ts";
import { startMcpHttp } from "./http.ts";
import { Inbox } from "./inbox.ts";
import { createLog, describeError, formatDuration, type Log } from "./log.ts";
import { Poller } from "./poller.ts";
import { SendQueue } from "./queue.ts";
import { StateFiles } from "./state.ts";
import { TelegramApi } from "./telegram.ts";
import { TypingIndicator } from "./typing.ts";

/** How hard boot tries to learn the bot's own username before refusing. */
const GET_ME_ATTEMPTS = 5;
const GET_ME_BACKOFF_MS = 1_000;

async function main(): Promise<void> {
	let config: Config;
	try {
		config = readConfig(process.env);
	} catch (error) {
		// No logger yet: the refusal names a variable, and the token it could redact was never read.
		console.error(error instanceof ConfigError ? error.message : describeError(error));
		process.exitCode = 1;
		return;
	}
	const log = createLog([config.botToken, config.triggerSecret]);

	const proxy = config.httpsProxy === undefined ? undefined : proxiedFetch(config.httpsProxy, log);
	const api = new TelegramApi({ token: config.botToken, fetch: proxy?.fetch ?? directFetch() });

	const bot = await whoAmI(api, log);
	if (bot === undefined) {
		await proxy?.close();
		process.exitCode = 1;
		return;
	}

	const state = new StateFiles(config.dataDir);
	const chats = new ChatDirectory(await state.readChats());
	// The inbox is a directory of the agent's home rather than of this container's state, and the volume has no other
	// watcher: what a message left behind is swept at startup and again on every write (`src/inbox.ts`).
	const inbox = new Inbox({ api, dir: config.inboxDir, log });
	await inbox.sweep();
	// Built before the poller and the tools face, because both edges of the indicator live in this process: the poller
	// starts it when a message becomes a fire, and `send_message` stops it when the answer lands.
	const typing = new TypingIndicator({
		ping: (chatId) => api.sendChatAction({ chatId }),
		log,
	});
	const door = new EventDoor({
		url: config.eventUrl,
		secret: config.triggerSecret,
		fetch: directFetch(),
		log,
		integration: "telegram",
	});
	const queue = new SendQueue({
		// A failed send is a tool result the model reads, so the queue redacts with the same two secrets the log does.
		secrets: [config.botToken, config.triggerSecret],
		onWait: (chatId, waitMs, reason) => log("info", `waiting ${formatDuration(waitMs)} on chat ${chatId} (${reason})`),
	});
	const poller = new Poller({
		api,
		state,
		door,
		log,
		chats,
		filter: { allowedChats: new Set(config.allowedChats), botUsername: bot.username },
		typing,
		inbox,
		// A command's answer goes through the same per-chat queue as a tool's message, so the rate limit and the 429 belong
		// to one file. A send that failed is one line: the command was answered, and a chat that did not read it is not a
		// reason to hold the batch.
		reply: async (chatId, text) => {
			const outcome = await queue.enqueue(chatId, () => api.sendMessage({ chatId, text }));
			if (outcome.kind === "failed") log("warn", `could not answer a command in chat ${chatId}: ${outcome.error}`);
		},
	});

	// The menu a person sees when they type `/`: the same words `/help` answers with, so the two cannot drift. Set before
	// the first poll and never fatal — Telegram refusing a menu is not a reason to stop relaying messages.
	try {
		await api.setMyCommands(COMMANDS.map((command) => ({ command: command.name, description: command.description })));
	} catch (error) {
		log("warn", `could not set the bot's command menu: ${describeError(error)}; /help still answers in the chat`);
	}

	const tools = await startMcpHttp({
		port: config.port,
		log,
		tools: {
			send: (options) => queue.enqueue(options.chatId, () => api.sendMessage(options)),
			// A file is a message a person receives, so it takes the same queue: Telegram's twenty a minute do not care
			// whether the bytes or the words were more, and a 429 on an upload is the queue's to honour like any other.
			sendFile: (options) => queue.enqueue(options.chatId, () => api.sendFile(options)),
			chats: () => chats.list(),
			// Where a file must be to leave: the one volume the relay and the tool machine share, and the only part of the
			// agent's home this container can read.
			inboxDir: config.inboxDir,
			typing,
		},
	});

	const controller = new AbortController();
	let stopping = false;
	const stop = (signal: string): void => {
		if (stopping) return;
		stopping = true;
		log("info", `${signal}: stopping between batches`);
		controller.abort();
		typing.stopAll();
		void tools
			.close()
			.then(() => proxy?.close())
			.catch(() => {})
			.finally(() => process.exit(0));
	};
	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGINT", () => stop("SIGINT"));

	log(
		"info",
		`relaying ${config.allowedChats.length} allowed chat(s) as @${bot.username ?? "<no username>"}; ` +
			`events go to ${config.eventUrl}`,
	);
	await poller.run(controller.signal);
}

/**
 * The bot behind the token, retried a few times, or undefined after naming why. Retried because the container usually
 * starts beside the VPN sidecar and the first attempt can land before the proxy is listening.
 */
async function whoAmI(api: TelegramApi, log: Log): Promise<{ readonly username: string | undefined } | undefined> {
	for (let attempt = 1; attempt <= GET_ME_ATTEMPTS; attempt += 1) {
		try {
			const me = await api.getMe();
			if (me.username === undefined) {
				log(
					"warn",
					"getMe answered without a username, so a group mention of this bot will not be stripped from the text",
				);
			}
			return { username: me.username };
		} catch (error) {
			log("warn", `getMe failed (attempt ${attempt}/${GET_ME_ATTEMPTS}): ${describeError(error)}`);
			if (attempt < GET_ME_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, GET_ME_BACKOFF_MS * attempt));
		}
	}
	log("error", "refusing to start: Telegram never said which bot this token belongs to");
	return undefined;
}

await main();
