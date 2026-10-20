/**
 * The browser's side of pairing: a token arrives in the URL once, is kept, and is used to open the socket.
 *
 * Pure functions on purpose — no DOM at import time, so the parsing is testable in node and the shell stays thin.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adoptToken, socketUrl, tokenFromSearch } from "../src/web/lib/token.ts";

function fakeWindow(search: string, stored: string | null = null) {
	const wrote: { value: string }[] = [];
	const replaced: string[] = [];
	return {
		wrote,
		replaced,
		window: {
			location: { search, pathname: "/", hash: "" },
			history: {
				replaceState: (_data: unknown, _unused: string, url?: string) => {
					replaced.push(url ?? "");
				},
			},
			localStorage: {
				getItem: () => stored,
				setItem: (_key: string, value: string) => {
					wrote.push({ value });
				},
			},
		},
	};
}

describe("the browser token", () => {
	it("reads the token out of a pairing link", () => {
		assert.equal(tokenFromSearch("?token=mason_abc"), "mason_abc");
		assert.equal(tokenFromSearch("?other=1&token=mason_abc"), "mason_abc");
		assert.equal(tokenFromSearch(""), undefined);
		assert.equal(tokenFromSearch("?token="), undefined);
		assert.equal(tokenFromSearch("?token=%20"), undefined);
	});

	it("keeps the token and drops it from the address bar", () => {
		const { window, wrote, replaced } = fakeWindow("?token=mason_abc");
		assert.equal(adoptToken(window), "mason_abc");
		assert.deepEqual(wrote, [{ value: "mason_abc" }]);
		assert.deepEqual(replaced, ["/"], "the credential does not stay in the URL");

		const later = fakeWindow("", "mason_stored");
		assert.equal(adoptToken(later.window), "mason_stored");
		assert.deepEqual(later.wrote, [], "a stored token is not written again");
	});

	it("says a browser without a token is not paired", () => {
		assert.equal(adoptToken(fakeWindow("").window), undefined);
		assert.equal(adoptToken(fakeWindow("?token=").window), undefined);
	});

	it("carries the token on the socket URL", () => {
		const origin = { protocol: "http:", host: "127.0.0.1:8787" };
		assert.equal(socketUrl(origin, "mason_abc"), "ws://127.0.0.1:8787/?token=mason_abc");
		assert.equal(socketUrl({ protocol: "https:", host: "box.lan" }, "a+b/c"), "wss://box.lan/?token=a%2Bb%2Fc");
		assert.equal(socketUrl(origin, undefined), "ws://127.0.0.1:8787/");
	});
});
