/**
 * `/api/connector`: mason's Chord host, and the one socket a connector opens.
 *
 * The protocol is `packages/protocol` and its prose is `packages/protocol/PROTOCOL.md`; this file is mason's end of it.
 * Four things live here and they are deliberately one module, because they are one host's lifetime:
 *
 * 1. **The identity.** A connector is accepted as the Chord child host `connector:<name>`, stamped with the principal
 *    the credential names. Chord carries the link, the addressing and the validation; what is left here is the answer to
 *    "who is this" and the one method each side calls.
 * 2. **Inbound is one append.** `submission`, `event` and `notice` arrive through one method and are claimed durably
 *    before they are answered. The claim is deduplicated on the sender's id forever — the durable log never forgets a
 *    request id, so a resend after a restart is the same act.
 * 3. **The session is state.** The connector reads its grants as a state member of `mason.peer`, so there is no hello to
 *    answer and no face to negotiate: what the operator granted is what it sees, and it cannot change under a live
 *    socket.
 * 4. **Delivery.** A reply committed as an `app.reply` entry is owed to the connector it addresses. The outbox sends it,
 *    records the acknowledgement as an `app.delivery` entry, resends what was never acknowledged, and never retries an
 *    `uncertain` answer — a person who received the same message twice is the failure this arrangement exists to avoid.
 *    What is owed is read from the transcript once at boot and kept from the live window after that, so a reply that
 *    scrolls out of the window while a connector is away is still sent.
 *
 * What is *not* here: the owner's token. A connector credential opens this socket and the attachment endpoints and
 * nothing else; the config is read per request, so a revoke lands on the next connection rather than the next restart.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { basename, join } from "node:path";
import { createHost, type Host, type Link, webSocketLink } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	Conversation,
	ConversationView,
	Cursor,
	EntryId,
	EntryRecord,
	SubmissionDraft,
} from "@earendil-works/pi-durable";
import { ConversationBusy } from "@earendil-works/pi-durable";
import {
	type AppendArgs,
	type AppendResult,
	CONTROL_OPS,
	type ConnectorRef,
	type ContentBlock,
	type ControlArgs,
	type ControlOp,
	type ControlResult,
	connectorHost,
	type DeliverArgs,
	type DeliveryAck,
	ERROR_CODE,
	MASON_HOST,
	MasonConnector,
	MasonPeer,
	masonError,
	type Origin,
	PROTOCOL_MAJOR,
	type Session,
	SessionSchema,
} from "mason-protocol";
import type { WebSocket } from "ws";
import { CONNECTOR_ENTRY_KIND, DELIVERY_ENTRY_KIND, NOTICE_ENTRY_KIND } from "../shared/contract.ts";
import { ATTACHMENT_LIMIT, type AttachmentStore } from "./attachments.ts";
import { commandTarget, runCommand } from "./commands.ts";
import { authenticateConnector, type ConnectorGrant, connectorGrantFor, ownerRefusal } from "./connectors.ts";
import { currentHouse } from "./house.ts";
import { currentIntegrations } from "./integrations.ts";
import {
	CONNECTOR_CONTROL_LIMIT,
	CONNECTOR_FIRE_LIMIT,
	CONNECTOR_SUBMISSION_LIMIT,
	type FireLimiter,
} from "./limits.ts";
import { type ReplyRecord, replyRecordOf } from "./replies.ts";
import type { AgentRuntime } from "./runtime.ts";
import { deriveRunStatus, isBusy, queuedSubmissions } from "./status.ts";

/** The path a connector opens. Beside the Chord socket rather than inside it: one door, one contract. */
export const CONNECTOR_PATH = "/api/connector";

/** What `compact` may be told, in characters: a line of instruction, not a document. */
export const COMMAND_INSTRUCTION_MAX = 200;

/** How long a delivery may take before the reply stays owed and is resent on the next opportunity. */
const DELIVERY_TIMEOUT_MS = 15_000;

/** How long a fresh reference may take to bind before the delivery is left owed: a connector mid-handshake is not lost. */
const REFERENCE_TIMEOUT_MS = 10_000;

/** One page of the boot scan of the transcript. */
const OWED_SEED_PAGE = 128;

/** How many of those pages it will read before it says it stopped at the cap rather than silently truncating. */
const OWED_SEED_MAX_PAGES = 512;

/** Who is on the other end of a link. The credential wrote it and nothing on the wire may change it. */
export interface ConnectorPrincipal {
	readonly connector: string;
}

export interface ConnectorDoorOptions {
	readonly runtime: AgentRuntime;
	/** Where an uploaded file is written for the model to read, when a submission carries one. */
	readonly workspaceDir: string;
	readonly attachments: AttachmentStore;
	/** One limiter for the process, shared with the attachment routes: a class budget is the connector's, not a socket's. */
	readonly limiter: FireLimiter;
	readonly log?: (line: string) => void;
	readonly now?: () => number;
	/** How the door picks the config a socket is authenticated against. A test reads the home it booted. */
	readonly home?: string;
}

export interface ConnectorDoor {
	/**
	 * Authenticate an upgrade and hand the socket its link. The caller has already routed the request to this path; a
	 * refusal closes the socket with a reason and says why in the log.
	 */
	attach(socket: WebSocket, request: IncomingMessage): Promise<void>;
	/** Send what a connector is owed now — after a connect, and after every view change. */
	flush(): Promise<void>;
	close(): Promise<void>;
}

export async function createConnectorDoor(options: ConnectorDoorOptions): Promise<ConnectorDoor> {
	const log = options.log ?? ((line: string) => console.log(line));
	const home = options.home ?? currentHouse().home;
	const conversation = await options.runtime.conversation();
	const links = new Map<string, Link>();

	const host: Host<ConnectorPrincipal> = createHost({
		name: MASON_HOST,
		self: { connector: MASON_HOST },
		onError: (error) => log(`[connector] ${error instanceof Error ? error.message : String(error)}`),
	});

	// The peer object is per connector: its principal is the credential's, so the state it exposes is that connector's
	// grant and nobody else's.
	host.serve(MasonPeer, (input, principal, self) => {
		void input;
		const name = principal.connector;
		return {
			variant: "default",
			session: self.state("session", SessionSchema, sessionOf(name)),
			append: async (args: unknown) => append(name, args as AppendArgs),
			control: async (args: unknown) => control(name, args as ControlArgs),
		};
	});

	const door: ConnectorDoor = {
		attach,
		flush,
		close: async () => {
			// The watch first, and stopped rather than merely unsubscribed: a flush that lands mid-close would read a view
			// this door is no longer the outbox for, and a watch left running is a listener on a log nobody reads back.
			unsubscribe();
			await watch.dispose();
			for (const link of links.values()) link.close("mason is shutting down");
			links.clear();
			await host.close();
		},
	};

	let latest: ConversationView | undefined;
	let flushing: Promise<void> | undefined;
	let dirty = false;
	/**
	 * What the outbox still owes, keyed by delivery id. Seeded once from the transcript at boot, then kept by the door's
	 * window: a reply the window shows is owed, and its acknowledgement — or a delivery this process made — removes it.
	 */
	const owed = new Map<string, OwedReply>();
	let seeded = false;

	// One watch for the whole door: the outbox reads the same revision. A per-socket watch would be one listener per
	// connector on a log that already fans out to every reader.
	const watch = await options.runtime.viewState(BACKGROUND_CONTEXT);
	const unsubscribe = watch.subscribe((view) => {
		latest = view;
		void flush();
	});

	return door;

	async function attach(socket: WebSocket, request: IncomingMessage): Promise<void> {
		// The link is made before the first await. Chord queues what arrives until `accept`, and the credential is read
		// from disk: a hello that arrived meanwhile must not be dropped by a socket with no listener on it.
		const link = webSocketLink(socket as never);
		let auth: Awaited<ReturnType<typeof authenticateConnector>>;
		try {
			auth = await authenticateConnector(request, home, currentIntegrations());
		} catch (error) {
			log(`[connector] refused a socket: ${error instanceof Error ? error.message : String(error)}`);
			link.close("the store this server reads is unreadable");
			return;
		}
		if (!auth.ok) {
			log(`[connector] refused a socket (${auth.reason}) from ${request.headers.origin ?? "a program"}`);
			link.close("unauthorized");
			return;
		}
		const name = auth.identity.name;
		const previous = links.get(name);
		if (previous !== undefined) {
			// Two sockets under one host name shadow each other silently in Chord, so the old one goes first.
			log(`[connector] ${name}: a second socket supersedes the first`);
			links.delete(name);
			previous.close("superseded by a second socket for this connector");
		}
		links.set(name, link);
		link.onClose(() => {
			if (links.get(name) === link) links.delete(name);
		});
		host.accept(link, { principal: { connector: name }, kind: "host", name: connectorHost(name) });
		log(`[connector] ${name} connected`);
		queueMicrotask(() => void flush());
	}

	/**
	 * Send every reply an open connector is owed, in the order they were committed.
	 *
	 * One flush at a time, coalesced: a flush asked for while one is running is a rerun of the whole door, never a second
	 * pass for one connector — the replies a connector is owed are one set, so the pass that runs last is the one that is
	 * right. The set is read from the transcript once, on the first pass after boot, and the door's window keeps it after
	 * that: the newest entries say a reply is owed, and nothing else here reads the record.
	 */
	async function flush(): Promise<void> {
		if (flushing !== undefined) {
			dirty = true;
			return flushing;
		}
		flushing = (async () => {
			do {
				dirty = false;
				if (!seeded) {
					try {
						await seedOwed();
						seeded = true;
					} catch (error) {
						// Without the transcript there is no answer to "what is owed", and a guess is a second copy of something
						// already sent. Nothing goes out this pass; the next one reads again.
						log(`[connector] the outbox could not read the transcript: ${textOf(error)}`);
						return;
					}
				}
				const view = latest ?? watch.value;
				if (view === undefined) return;
				maintainOwed(view);
				for (const [name, records] of owedByConnector()) {
					for (const record of records) {
						if (!links.has(name)) break;
						try {
							await sendFinal(name, record);
						} catch (error) {
							// The connector has the message but the acknowledgement could not be written down. Leaving it owed
							// is the honest answer: the next pass resends it under the same id and the ledger answers
							// `duplicate`. Throwing would abandon every other connector's reply mid-pass.
							log(
								`[connector] ${name}: ${record.deliveryId} could not be recorded: ` +
									(error instanceof Error ? error.message : String(error)),
							);
						}
					}
				}
			} while (dirty);
		})().finally(() => {
			flushing = undefined;
		});
		return flushing;
	}

	/**
	 * Everything the transcript says is still owed, read once at boot in one paged pass.
	 *
	 * The window is not a record: a reply that fell out of it while a connector was away — its turn still running, its
	 * socket reconnecting, a pass paused — is still owed, and the transcript is the only place that says so. Descending,
	 * because an acknowledgement is always committed after the reply it settles: a read that stops early must keep the
	 * newest entries, where a reply and its ack still sit together. Cutting the other end would keep a reply and lose its
	 * ack, which is a message the transcript already settled being sent a second time. Order of delivery does not depend
	 * on this read: `owedByConnector` sorts by entry id.
	 */
	async function seedOwed(): Promise<void> {
		const seededOwed = await conversation.commit(async (tx) => {
			const replies: OwedReply[] = [];
			const acknowledged = new Set<string>();
			let cursor: Cursor | undefined;
			let complete = false;
			for (let page = 0; page < OWED_SEED_MAX_PAGES; page += 1) {
				const scanned = await tx.scanEntries(
					{ conversationId: conversation.id, order: "descending" },
					OWED_SEED_PAGE,
					cursor,
				);
				for (const entry of scanned.items) {
					const owedEntry = owedEntryOf(entry);
					if (owedEntry !== undefined) {
						replies.push(owedEntry);
						continue;
					}
					const delivered = deliveredIdOf(entry);
					if (delivered !== undefined) acknowledged.add(delivered);
				}
				if (scanned.next === undefined) {
					complete = true;
					break;
				}
				cursor = scanned.next;
			}
			return { replies: replies.filter((item) => !acknowledged.has(item.record.deliveryId)), complete };
		}, BACKGROUND_CONTEXT);
		if (!seededOwed.complete) {
			log(
				`[connector] the outbox stopped at ${OWED_SEED_MAX_PAGES} pages of the transcript: ` +
					"a reply owed from further back than that is not tracked, and the window cannot bring it back",
			);
		}
		for (const item of seededOwed.replies) owed.set(item.record.deliveryId, item);
	}

	/** Keep the set on the window: a reply that appears is owed, and the acknowledgement of one takes it out. */
	function maintainOwed(view: ConversationView): void {
		for (const entry of (view.entries ?? []) as readonly EntryRecord[]) {
			const owedEntry = owedEntryOf(entry);
			if (owedEntry !== undefined) {
				owed.set(owedEntry.record.deliveryId, owedEntry);
				continue;
			}
			const delivered = deliveredIdOf(entry);
			if (delivered !== undefined) owed.delete(delivered);
		}
	}

	/** The replies each open connector still owes: one destination, in the order the transcript holds them. */
	function owedByConnector(): Array<[string, ReplyRecord[]]> {
		const byConnector = new Map<string, OwedReply[]>();
		for (const item of owed.values()) {
			const name = item.record.address?.connector;
			if (name === undefined || !links.has(name)) continue;
			const list = byConnector.get(name) ?? [];
			list.push(item);
			byConnector.set(name, list);
		}
		return [...byConnector].map(([name, items]): [string, ReplyRecord[]] => [
			name,
			items.sort((left, right) => left.entryId - right.entryId).map((item) => item.record),
		]);
	}

	/** One `deliver`, and its acknowledgement written down — whatever it says, including `uncertain`. */
	async function sendFinal(name: string, record: ReplyRecord): Promise<void> {
		const address = record.address;
		if (address === undefined) return;
		const args: DeliverArgs = {
			deliveryId: record.deliveryId,
			blocks: record.blocks as DeliverArgs["blocks"],
			...(address.ref === undefined ? {} : { ref: address.ref }),
		};
		const ack = await callConnector(name, args);
		if (ack === undefined) {
			log(`[connector] ${name}: ${record.deliveryId} was not acknowledged; it stays owed`);
			return;
		}
		await recordDelivery(conversation, record.deliveryId, ack);
		log(
			`[connector] ${name}: ${record.deliveryId} ${ack.status}${ack.detail === undefined ? "" : ` (${ack.detail})`}`,
		);
	}

	/**
	 * One call into a connector, bounded.
	 *
	 * The reference is taken per delivery and thrown away: a held one goes `gone` when the link drops, so caching it would
	 * be caching the moment the connector last connected. A call that does not answer in time is `undefined`, which the
	 * outbox reads as "still owed" — the one outcome that never loses a message.
	 */
	async function callConnector(name: string, args: DeliverArgs): Promise<DeliveryAck | undefined> {
		try {
			const ref = (await withDeadline(
				host.get(MasonConnector, { connector: name }),
				REFERENCE_TIMEOUT_MS,
			)) as unknown as ConnectorRef;
			return await withDeadline(Promise.resolve(ref.deliver(args)), DELIVERY_TIMEOUT_MS);
		} catch (error) {
			log(`[connector] ${name}: delivery ${args.deliveryId} unanswered (${textOf(error)})`);
			return undefined;
		}
	}

	/* ---------------------------------------------------------------------------------------------------------------- */
	/* The peer object                                                                                                  */
	/* ---------------------------------------------------------------------------------------------------------------- */

	function sessionOf(name: string): Session {
		const grant = grantOf(name);
		return {
			protocol: PROTOCOL_MAJOR,
			commands: [...(grant.commands ?? [])],
			kinds: Object.keys(grant.events?.hooks ?? {}).sort(),
			limits: {
				submissionsPerMinute: CONNECTOR_SUBMISSION_LIMIT,
				firesPerMinute: CONNECTOR_FIRE_LIMIT,
				controlsPerMinute: CONNECTOR_CONTROL_LIMIT,
				attachmentsPerMinute: ATTACHMENT_LIMIT,
				// The store's own bounds, not the constants: a deployment that narrowed them is what a connector obeys.
				attachmentBytes: options.attachments.maxBytes,
				attachmentTtlMs: options.attachments.ttlMs,
			},
		};
	}

	function grantOf(name: string): ConnectorGrant {
		const found = connectorGrantFor(currentIntegrations(), name);
		if (found === undefined) {
			throw masonError(ERROR_CODE.faceNotGranted, `"${name}" is not an enabled connector`);
		}
		return found.grant;
	}

	async function append(name: string, args: AppendArgs): Promise<AppendResult> {
		if (typeof args.appendId !== "string" || args.appendId === "") {
			throw masonError(ERROR_CODE.invalidRequest, "an append needs a non-empty appendId", { field: "appendId" });
		}
		const grant = grantOf(name);
		switch (args.type) {
			case "submission":
				return submission(name, grant, args);
			case "event":
				return event(name, grant, args);
			case "notice":
				return notice(name, args);
			default:
				throw masonError(ERROR_CODE.invalidRequest, "an append is one of submission, event or notice");
		}
	}

	async function submission(
		name: string,
		grant: ConnectorGrant,
		args: Extract<AppendArgs, { type: "submission" }>,
	): Promise<AppendResult> {
		// Everything in the grant is a ceiling, and the user face is the first of them: an entry granted only events is a
		// connector that may raise alerts, and its words are not a person's.
		if (grant.user === undefined) {
			throw masonError(
				ERROR_CODE.faceNotGranted,
				`"${name}" holds no user grant: this entry may not carry a person's words`,
			);
		}
		const refusal = ownerRefusal(grant, args.origin?.actor);
		if (refusal !== undefined) throw masonError(ERROR_CODE.actorUnknown, refusal);
		const requestId = connectorRequestId(name, "submission", args.appendId);
		const claimed = await claim(requestId);
		if (claimed !== undefined) return { outcome: "duplicate", ...entryOf(claimed.entry) };
		spend(name, "submission", CONNECTOR_SUBMISSION_LIMIT);
		const origin = originOf(name, args.origin);
		const content = await userInput(name, args.content);
		const placed = await submitInput({
			type: "input",
			requestId,
			content,
			...(origin === undefined
				? {}
				: { entry: { kind: CONNECTOR_ENTRY_KIND, data: { origin: originData(origin) } } }),
			...(args.mode === "steer" || args.mode === "followUp" || args.mode === "reject"
				? { whenBusy: args.mode }
				: {}),
		});
		const record = await placed.status(BACKGROUND_CONTEXT);
		log(`[connector] ${name}: submission ${args.appendId}${origin === undefined ? "" : ` from ${origin.ref}`}`);
		return { outcome: "accepted", ...entryOf(record.entry) };
	}

	/**
	 * `submit`, with the refusal a connector's own `mode: "reject"` asks for mapped to the code it is.
	 *
	 * `whenBusy: "reject"` is the connector saying it would rather be told than queued, so the answer is a refusal it can
	 * act on — not a Chord `unavailable`, which a connector reads as "try again later".
	 */
	async function submitInput(draft: SubmissionDraft) {
		try {
			return await conversation.submit(draft, BACKGROUND_CONTEXT);
		} catch (error) {
			if (error instanceof ConversationBusy) {
				throw masonError(
					ERROR_CODE.queueOverflow,
					"the conversation is in the middle of a turn and this submission asked to be refused rather than queued",
					{ retryable: true },
				);
			}
			throw error;
		}
	}

	/**
	 * The words as the model reads them, plus the files they sent.
	 *
	 * Text and markdown blocks become the message, unprefixed: the connector's credential already says who is speaking,
	 * and one person's bot has nobody to tell apart. A file block is fetched from the attachment store and written into
	 * the agent's workspace, because a content id is not something a `read` can open; an image also travels as an image
	 * block, so the model sees it without a tool call.
	 */
	async function userInput(name: string, blocks: readonly ContentBlock[]): Promise<UserInput> {
		const text: string[] = [];
		const images: UserInputImage[] = [];
		for (const block of blocks) {
			if (block.type === "text" || block.type === "markdown" || block.type === "notice") {
				text.push(block.text);
				continue;
			}
			const read = await options.attachments.read(name, block.contentId);
			if (read.status !== "ok") {
				text.push(`[a file could not be attached: ${read.status === "expired" ? "it expired" : "no such upload"}]`);
				continue;
			}
			const path = await attachmentPath(block.contentId, block.name ?? read.attachment.meta.name);
			await writeFile(path, read.attachment.bytes, { mode: 0o600 });
			const type = block.mimeType ?? read.attachment.meta.mimeType;
			if (type.startsWith("image/")) {
				images.push({ type: "image", data: read.attachment.bytes.toString("base64"), mimeType: type });
			}
			text.push(`[file: ${path} — ${type}, ${read.attachment.meta.size} bytes]`);
		}
		const body = text.join("\n");
		if (images.length === 0) return body;
		return [{ type: "text", text: body }, ...images];
	}

	/** Where one attachment is written for `read`: inside the workspace, its name kept but never its path. */
	async function attachmentPath(contentId: string, name: string | undefined): Promise<string> {
		const directory = join(options.workspaceDir, "inbox");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const safe = basename(name ?? "file")
			.replace(/[^\w.-]+/g, "_")
			.slice(0, 80);
		return join(directory, `${contentId}-${safe}`);
	}

	/**
	 * One event: written to the log always, and it wakes the bot only when the routine its kind names is live.
	 *
	 * Three lines decide everything. A kind the grant does not name is refused. A kind the grant names whose routine is
	 * absent, or switched off in `agent/routines.json`, is written to the log and wakes nothing — the log is the default
	 * sink, so no wildcard grant and no separate append type is needed. A kind with a live routine starts a turn.
	 */
	async function event(
		name: string,
		grant: ConnectorGrant,
		args: Extract<AppendArgs, { type: "event" }>,
	): Promise<AppendResult> {
		const hook = grant.events?.hooks[args.kind];
		if (hook === undefined) {
			throw masonError(ERROR_CODE.kindNotPermitted, `"${args.kind}" is not a kind this entry's grant names`);
		}
		// The log is the record, so it is the dedupe: an event whose routine is absent never becomes an entry, and a resend
		// after a lost acknowledgement would otherwise be written twice.
		if (options.runtime.events.seen(name, args.appendId)) return { outcome: "duplicate" };
		const requestId = connectorRequestId(name, "fire", args.appendId);
		spend(name, "fire", CONNECTOR_FIRE_LIMIT);
		const origin = originOf(name, args.origin);
		options.runtime.events.append({
			at: new Date(options.now?.() ?? Date.now()).toISOString(),
			connector: name,
			kind: args.kind,
			hook,
			appendId: args.appendId,
			...(args.summary === undefined ? {} : { summary: args.summary }),
			payload: args.payload ?? null,
			...(origin === undefined ? {} : { ref: origin.ref }),
		});
		const live = options.runtime.hooks.get(hook);
		if (live === undefined || !live.enabled) {
			log(`[connector] ${name}: event ${args.kind} written down; no live routine is called ${hook}`);
			return { outcome: "accepted" };
		}
		const placed = await options.runtime.hooks.fire(hook, {
			payload: payloadText(args.payload, args.summary),
			kind: args.kind,
			requestId,
			...(origin === undefined ? {} : { origin }),
		});
		const record = await placed.status(BACKGROUND_CONTEXT);
		log(`[connector] ${name}: event ${args.appendId} (${args.kind}) -> ${hook}`);
		return { outcome: "accepted", ...entryOf(record.entry) };
	}

	/**
	 * The medium talking about itself: written down for the reader, and it starts nothing.
	 *
	 * A notice is an append with words in it, so it spends the submission budget: a connector that could write rows into
	 * the transcript for free would be a budget that does not bound what it is for. Its duplicates are free, because the
	 * transcript already holds the first one.
	 */
	async function notice(name: string, args: Extract<AppendArgs, { type: "notice" }>): Promise<AppendResult> {
		// A write submission is the transcript's own index: its request id is durable, so a resend is the same act whether
		// the first notice is the newest entry or a hundred entries back. A write starts no run, which is what a notice is.
		const requestId = connectorRequestId(name, "notice", args.appendId);
		const claimed = await claim(requestId);
		if (claimed !== undefined) return { outcome: "duplicate", ...entryOf(claimed.entry) };
		spend(name, "submission", CONNECTOR_SUBMISSION_LIMIT);
		const placed = await conversation.submit(
			{
				type: "write",
				requestId,
				entry: { kind: NOTICE_ENTRY_KIND, data: { appendId: args.appendId, connector: name, text: args.text } },
			},
			BACKGROUND_CONTEXT,
		);
		const record = await placed.status(BACKGROUND_CONTEXT);
		log(`[connector] ${name}: notice ${args.appendId}`);
		return { outcome: "accepted", ...entryOf(record.entry) };
	}

	async function control(name: string, args: ControlArgs): Promise<ControlResult> {
		const grant = grantOf(name);
		const op = args.op;
		if (!(CONTROL_OPS as readonly string[]).includes(op)) {
			// An undeclared op spends nothing: a typo must not cost the minute a real `/stop` needs.
			throw masonError(
				ERROR_CODE.invalidRequest,
				`${op} is not a control mason knows: the whole set is ${CONTROL_OPS.join(", ")}`,
			);
		}
		if (!(grant.commands ?? []).includes(op as ControlOp)) {
			throw masonError(ERROR_CODE.invalidRequest, `this entry declares no "${op}" command`);
		}
		// `stop` has a budget of its own beside the controls, so a connector that spent its minute on compactions can still
		// stop the turn those compactions were about.
		spend(name, op === "stop" ? "stop" : "control", CONNECTOR_CONTROL_LIMIT);
		const instructions = typeof args.instructions === "string" ? args.instructions : undefined;
		if (op !== "compact" && instructions !== undefined && instructions.trim() !== "") {
			throw masonError(
				ERROR_CODE.invalidRequest,
				`"${op}" takes no argument: a command is one word, and only "compact" reads what follows it`,
			);
		}
		if (instructions !== undefined && instructions.length > COMMAND_INSTRUCTION_MAX) {
			throw masonError(
				ERROR_CODE.invalidRequest,
				`"compact" takes at most ${COMMAND_INSTRUCTION_MAX} characters of instructions; this one is ${instructions.length}`,
			);
		}
		const requestId =
			typeof args.requestId === "string" && args.requestId !== ""
				? connectorRequestId(name, "control", args.requestId)
				: `command:${name}:gesture:${randomUUID()}`;
		const reply = await runCommand(await commandTarget(options.runtime), requestId, op as ControlOp, instructions);
		log(`[connector] ${name}: ${op}${reply === undefined ? " (already ran)" : ""}`);
		return {
			handled: true,
			op,
			...(reply === undefined ? { reply: "" } : { reply }),
			...(op === "status"
				? {
						status: {
							runStatus: deriveRunStatus(latest),
							busy: isBusy(latest),
							queued: queuedSubmissions(latest),
							commands: [...CONTROL_OPS],
						},
					}
				: {}),
		};
	}

	/** Whether this request id is already a durable claim, and what the claim says. */
	async function claim(requestId: string): Promise<{ readonly entry?: number } | undefined> {
		return conversation.commit(async (tx) => {
			const existing = await tx.submissionByRequest(conversation.id, requestId);
			if (existing === undefined) return undefined;
			return "entry" in existing && existing.entry !== undefined ? { entry: existing.entry } : {};
		}, BACKGROUND_CONTEXT);
	}

	/**
	 * Charge one act against its minute, or refuse with the wait in the words.
	 *
	 * Chord carries a code, a message and a reason across a link and nothing else, so a structured `retryAfterMs` would be
	 * dropped on the way (`packages/connector/WIRE.md`). The sentence is the field that arrives: it names the budget, and
	 * how long the connector should wait before it tries again.
	 */
	function spend(name: string, kind: "submission" | "fire" | "control" | "stop", perMinute: number): void {
		const wait = options.limiter.take(`connector:${kind}:${name}`, perMinute);
		if (wait === undefined) return;
		throw masonError(
			ERROR_CODE.rateLimited,
			`this connector has spent its ${kind} budget for the minute; retry in ${Math.max(1, Math.ceil(wait / 1_000))} s`,
			{ retryable: true },
		);
	}
}

/** One reply the outbox still owes, and where it sits in the transcript: entry order is the order it goes out in. */
interface OwedReply {
	readonly record: ReplyRecord;
	readonly entryId: EntryId;
}

/** The reply one entry carries, when it is a committed send with an address: that is a reply the outbox owes. */
function owedEntryOf(entry: EntryRecord): OwedReply | undefined {
	const record = replyRecordOf(entry);
	if (record?.address === undefined) return undefined;
	return { record, entryId: entry.id };
}

/** The delivery id one entry acknowledges, when it is an `app.delivery`: that is a reply the outbox no longer owes. */
function deliveredIdOf(entry: EntryRecord): string | undefined {
	if (entry.kind !== DELIVERY_ENTRY_KIND) return undefined;
	const data = entry.data as { deliveryId?: unknown } | undefined;
	return typeof data?.deliveryId === "string" ? data.deliveryId : undefined;
}

/** Write one acknowledgement down as its own entry: the outbox's record that this delivery is no longer owed. */
async function recordDelivery(conversation: Conversation, deliveryId: string, ack: DeliveryAck): Promise<void> {
	await conversation.commit(
		(tx) =>
			tx.appendEntry(conversation.id, {
				kind: DELIVERY_ENTRY_KIND,
				data: {
					deliveryId,
					status: ack.status,
					...(ack.detail === undefined ? {} : { detail: ack.detail }),
				},
			}),
		BACKGROUND_CONTEXT,
	);
}

interface UserInputImage {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

interface UserInputText {
	readonly type: "text";
	readonly text: string;
}

type UserInput = string | Array<UserInputText | UserInputImage>;

/** The origin the transcript keeps: the connector, the address it minted, and the medium's own message id. */
function originOf(
	connector: string,
	origin: { ref: string; messageId?: string; actor?: { id: string; name?: string } } | undefined,
): Origin | undefined {
	if (origin === undefined) return undefined;
	return {
		connector,
		ref: origin.ref,
		...(origin.messageId === undefined ? {} : { messageId: origin.messageId }),
		...(origin.actor === undefined ? {} : { actor: origin.actor }),
	};
}

/**
 * The origin as an entry's `data` holds it: plain JSON, field by field.
 *
 * A protocol interface has optional members, and an entry's `data` is JSON — `undefined` is not a value it can carry. The
 * explicit checks are what make the two shapes the same shape.
 */
function originData(origin: Origin) {
	return {
		connector: origin.connector,
		ref: origin.ref,
		...(origin.messageId === undefined ? {} : { messageId: origin.messageId }),
		...(origin.actor === undefined
			? {}
			: {
					actor: {
						id: origin.actor.id,
						...(origin.actor.name === undefined ? {} : { name: origin.actor.name }),
					},
				}),
	};
}

/** The `entryId` half of an append's answer, when the claim or the placement has one. */
function entryOf(entry: number | undefined): { entryId?: string } {
	return entry === undefined ? {} : { entryId: String(entry) };
}

/** The text an event's `payload` becomes: its own string, or the JSON, with the summary above it when there is one. */
function payloadText(payload: unknown, summary: string | undefined): string {
	const body = typeof payload === "string" ? payload : payload === undefined ? "" : JSON.stringify(payload, null, 2);
	const head = typeof summary === "string" && summary.trim() !== "" ? `${summary.trim()}\n` : "";
	return head + body;
}

/** A request id namespaced by connector and act: the durable log holds it forever, so two senders cannot collide. */
export function connectorRequestId(
	connector: string,
	act: "submission" | "fire" | "notice" | "control",
	id: string,
): string {
	return `connector:${connector}:${act}:${id}`;
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function textOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
