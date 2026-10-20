/**
 * This browser's session with the server.
 *
 * The credential is a cookie the server sets, `HttpOnly`, so this page can neither read nor store it: a script that
 * lands on this origin through a renderer bug can ride the session, but it cannot take it away. The pairing link is
 * spent by the server too — it sets the cookie and redirects to the bare page — so no token ever reaches the client
 * bundle, the address bar, or the history.
 *
 * What is left for the client is two small things: ask who it is, and open a socket the browser itself authenticates.
 */

export interface SessionDevice {
	readonly id: string;
	readonly label: string;
}

/** Where the socket lives for this origin. No credential in the URL: the browser attaches the cookie to the handshake. */
export function socketUrl(location: { readonly protocol: string; readonly host: string }): string {
	const scheme = location.protocol === "https:" ? "wss:" : "ws:";
	return `${scheme}//${location.host}/`;
}

/**
 * Who this browser is, or `undefined` when the server does not know it. A `401` is an answer — it means "not paired",
 * which is a screen with instructions on it, not a failure to report. Anything else is the caller's to handle.
 */
export async function probeSession(send: typeof fetch = fetch, base = ""): Promise<SessionDevice | undefined> {
	const response = await send(`${base}/api/session`, { headers: { accept: "application/json" } });
	if (response.status === 401) return undefined;
	if (!response.ok) throw new Error(`session probe: ${response.status}`);
	const body = (await response.json()) as { device?: { id?: unknown; label?: unknown } };
	const id = typeof body.device?.id === "string" ? body.device.id : undefined;
	const label = typeof body.device?.label === "string" ? body.device.label : undefined;
	return id === undefined || label === undefined ? undefined : { id, label };
}
