/**
 * This browser's session with the server.
 *
 * The credential is a cookie the server sets, `HttpOnly`, so this page can neither read nor store it: a script that
 * lands on this origin through a renderer bug can ride the session, but it cannot take it away. The pairing link is
 * spent by the server too — it sets the cookie and redirects to the bare page — so no token ever reaches the client
 * bundle, the address bar, or the history.
 *
 * What is left for the client is three small things: ask who it is, claim a name off the roster if it has none, and
 * open a socket the browser itself authenticates.
 */

export interface SessionDevice {
	readonly id: string;
	readonly label: string;
}

/** A name on the roster, as the server sends it: the spelling the transcript will carry for whoever claims it. */
export interface SessionPerson {
	readonly name: string;
}

/**
 * What `/api/session` answers, read defensively: the route is the server's, and this client is a bundle a browser may
 * have cached from last week.
 *
 * `roster` is the mark of a server that knows about names at all. It rides along only for a browser that has not
 * claimed one, so its presence is also the signal that there is a question to ask — a server from before team
 * identity sends no such key, and an unnamed device on it is a valid install that opens straight into the
 * conversation.
 */
export interface BrowserSession {
	readonly device: SessionDevice;
	/** Who this browser speaks for. Absent until it picks a name, and for good on a single-owner install. */
	readonly person?: SessionPerson;
	readonly roster?: readonly SessionPerson[];
}

/** Where the socket lives for this origin. No credential in the URL: the browser attaches the cookie to the handshake. */
export function socketUrl(location: { readonly protocol: string; readonly host: string }): string {
	const scheme = location.protocol === "https:" ? "wss:" : "ws:";
	return `${scheme}//${location.host}/`;
}

function personFrom(value: unknown): SessionPerson | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const person = value as { name?: unknown };
	if (typeof person.name !== "string" || person.name === "") return undefined;
	return { name: person.name };
}

function rosterFrom(value: unknown): readonly SessionPerson[] | undefined {
	if (!Array.isArray(value)) return undefined;
	// A hand-edited roster can hold an entry that is not a name; it is dropped here so the picker never offers a blank.
	return value.flatMap((entry) => personFrom(entry) ?? []);
}

/**
 * Who this browser is, or `undefined` when the server does not know it. A `401` is an answer — it means "not paired",
 * which is a screen with instructions on it, not a failure to report. Anything else is the caller's to handle.
 */
export async function probeSession(send: typeof fetch = fetch, base = ""): Promise<BrowserSession | undefined> {
	const response = await send(`${base}/api/session`, { headers: { accept: "application/json" } });
	if (response.status === 401) return undefined;
	if (!response.ok) throw new Error(`session probe: ${response.status}`);
	const body = (await response.json()) as {
		device?: { id?: unknown; label?: unknown };
		person?: unknown;
		roster?: unknown;
	};
	const id = typeof body.device?.id === "string" ? body.device.id : undefined;
	const label = typeof body.device?.label === "string" ? body.device.label : undefined;
	if (id === undefined || label === undefined) return undefined;
	const person = personFrom(body.person);
	const roster = rosterFrom(body.roster);
	return {
		device: { id, label },
		...(person === undefined ? {} : { person }),
		...(roster === undefined ? {} : { roster }),
	};
}

/**
 * The screens a boot probe can land on.
 *
 * `join` is the third answer between the door and the conversation: paired, but nobody has said who they are yet, so
 * the server has a roster to offer and the reader has one question to answer. A claimed person goes straight through;
 * a server that sends no roster at all is an install from before names and opens the conversation as it always did,
 * because asking a question it cannot answer would be a dead end rather than a step.
 */
export type Screen =
	| { readonly kind: "unpaired" }
	| { readonly kind: "join"; readonly roster: readonly SessionPerson[] }
	| { readonly kind: "conversation"; readonly person: string | undefined };

export function screenFor(session: BrowserSession | undefined): Screen {
	if (session === undefined) return { kind: "unpaired" };
	if (session.person !== undefined) return { kind: "conversation", person: session.person.name };
	if (session.roster === undefined) return { kind: "conversation", person: undefined };
	return { kind: "join", roster: session.roster };
}

/**
 * What became of a claim. A refusal is an answer the picker shows beside the list — the name is gone, or the server is
 * down — never a silent reload into a conversation that would still call the reader nobody.
 */
export type ClaimResult =
	| { readonly ok: true; readonly person: SessionPerson }
	| { readonly ok: false; readonly reason: "refused" | "unreachable" };

/** `POST /api/join { name }`: pick a name off the roster. The server writes the cookie; this page cannot. */
export async function claimPerson(name: string, send: typeof fetch = fetch, base = ""): Promise<ClaimResult> {
	let response: Response;
	try {
		response = await send(`${base}/api/join`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ name }),
		});
	} catch {
		return { ok: false, reason: "unreachable" };
	}
	if (!response.ok) return { ok: false, reason: "refused" };
	const body = (await response.json().catch(() => undefined)) as { person?: unknown } | undefined;
	const person = personFrom(body?.person);
	return person === undefined ? { ok: false, reason: "refused" } : { ok: true, person };
}
