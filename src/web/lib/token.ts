/**
 * The reader's credential in this browser.
 *
 * A first visit carries `?token=…`, because the server printed that link and a human is holding it. The page keeps the
 * token in `localStorage` and drops it from the address bar, so it stops travelling in URLs. Every later visit reads it
 * from storage; a browser that has none is not paired, and says so rather than connecting to nothing.
 *
 * The store is `localStorage` and not a cookie on purpose: a cookie is sent by the browser to whatever asks, while this
 * is only readable by scripts on this origin — which is what makes the server's Origin check the second gate rather
 * than the only one.
 */
const STORAGE_KEY = "mason.token";

/** The token in a query string, if any. Pure, so the parsing is testable without a browser. */
export function tokenFromSearch(search: string): string | undefined {
	const token = new URLSearchParams(search).get("token");
	return token === null || token.trim() === "" ? undefined : token.trim();
}

/** The socket URL for this origin: the token rides in the query because a browser cannot set a header on it. */
export function socketUrl(location: { protocol: string; host: string }, token: string | undefined): string {
	const scheme = location.protocol === "https:" ? "wss:" : "ws:";
	const query = token === undefined ? "" : `?token=${encodeURIComponent(token)}`;
	return `${scheme}//${location.host}/${query}`;
}

/** Take a token from the URL if this visit carried one, keep it, and return what this browser should use. */
export function adoptToken(win: {
	readonly location: { readonly search: string; readonly pathname: string; readonly hash: string };
	readonly history: { replaceState(data: unknown, unused: string, url?: string): void };
	readonly localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}): string | undefined {
	const fromUrl = tokenFromSearch(win.location.search);
	if (fromUrl === undefined) {
		const stored = win.localStorage.getItem(STORAGE_KEY);
		return stored === null || stored === "" ? undefined : stored;
	}
	win.localStorage.setItem(STORAGE_KEY, fromUrl);
	// The token is a credential, not a page address: leave the reader on the page, not on `/ ?token=…`.
	win.history.replaceState(null, "", `${win.location.pathname}${win.location.hash}`);
	return fromUrl;
}
