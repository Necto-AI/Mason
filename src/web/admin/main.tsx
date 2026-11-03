/**
 * The operator panel: the shell, the poll, and the writes.
 *
 * This is mason's own control plane, served from mason, and it is not a conversational client (#103): there is no
 * composer and no socket. The page asks `GET /api/admin/state` for what this device is allowed to see — the answer
 * carries a key per grant, and a missing key is a power this device does not have — and it polls, because a control
 * plane is read while the agent works and nobody is typing into it.
 *
 * The pairing rules are the console's, unchanged: the server prints a link once, opening it spends the token into an
 * `HttpOnly` cookie, and every later request carries the cookie. A browser without one is told so rather than shown an
 * empty room.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConnectorPatch, OperatorGrant, PanelState } from "../../shared/admin.ts";
import { ApiError, call, readState } from "./api.ts";
import { Access } from "./sections/Access.tsx";
import { Approvals } from "./sections/Approvals.tsx";
import { type ConnectorActions, Connectors } from "./sections/Connectors.tsx";
import { Conversation } from "./sections/Conversation.tsx";
import { Hooks } from "./sections/Hooks.tsx";
import { Overview } from "./sections/Overview.tsx";
import { Roster } from "./sections/Roster.tsx";
import { TraceView } from "./sections/TraceView.tsx";
import "../styles/tokens.css";
import "../styles/widgets.css";
import "./admin.css";

const POLL_MS = 2500;

interface Section {
	readonly id: string;
	readonly label: string;
	readonly available: (state: PanelState) => boolean;
}

const SECTIONS: readonly Section[] = [
	{ id: "overview", label: "Overview", available: () => true },
	{ id: "conversation", label: "Conversation", available: (state) => state.conversation !== undefined },
	{ id: "approvals", label: "Approvals", available: (state) => state.permissions !== undefined },
	{ id: "trace", label: "Trace", available: (state) => state.trace !== undefined },
	{ id: "connectors", label: "Connectors", available: (state) => state.config !== undefined },
	{ id: "roster", label: "Roster", available: (state) => state.config !== undefined },
	{ id: "access", label: "Access", available: (state) => state.config !== undefined },
	{ id: "hooks", label: "Hooks", available: (state) => state.config !== undefined },
];

/** The panel's state: the last answer, and whether the next one is late. */
interface Live {
	readonly state: PanelState | undefined;
	readonly booted: boolean;
	readonly unpaired: boolean;
	readonly error: string | undefined;
}

function sectionFromHash(): string {
	const hash = window.location.hash.replace(/^#\/?/, "");
	return SECTIONS.some((section) => section.id === hash) ? hash : "overview";
}

function usePanel(): Live & { readonly refresh: () => Promise<void> } {
	const [live, setLive] = useState<Live>({ state: undefined, booted: false, unpaired: false, error: undefined });
	const mounted = useRef(true);

	const read = useCallback(async () => {
		try {
			const state = await readState();
			if (!mounted.current) return;
			setLive({ state, booted: true, unpaired: false, error: undefined });
		} catch (reason) {
			if (!mounted.current) return;
			if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) {
				setLive({ state: undefined, booted: true, unpaired: true, error: undefined });
				return;
			}
			// A failed poll keeps the last answer on screen: a control plane that blanks out on one dropped request is a
			// control plane nobody trusts. The banner says it is stale.
			setLive((current) => ({
				...current,
				booted: true,
				error: reason instanceof Error ? reason.message : String(reason),
			}));
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		void read();
		const timer = setInterval(() => {
			if (document.hidden) return;
			void read();
		}, POLL_MS);
		const onVisible = () => {
			if (!document.hidden) void read();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			mounted.current = false;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [read]);

	return { ...live, refresh: read };
}

function Unpaired({ reason }: { readonly reason: "unpaired" | "unreachable" }) {
	return (
		<div className="gate" data-testid={reason === "unpaired" ? "unpaired" : "unreachable"}>
			<h1>{reason === "unpaired" ? "Not paired" : "The server is not answering"}</h1>
			{reason === "unpaired" ? (
				<>
					<p>
						This browser has no credential mason recognises. Open the pairing link the server printed — it looks
						like <code>http://127.0.0.1:8787/?token=…</code> — once, and this browser will remember it.
					</p>
					<p>
						No link? Mint one on the machine: <code>npm run token -- add --label browser</code>.
					</p>
				</>
			) : (
				<p>
					The page loaded but <code>/api/admin/state</code> did not answer. Is the server running, on this address?
				</p>
			)}
		</div>
	);
}

/** The writes, in one place: every one of them refetches the state, because the answer is the panel's truth. */
function actions(then: () => Promise<void>) {
	const connector: ConnectorActions = {
		async save(name, patch: ConnectorPatch) {
			return call("PUT", `/api/admin/connectors/${encodeURIComponent(name)}`, patch);
		},
		async create(name, toolsUrl, description) {
			const body =
				toolsUrl === ""
					? { name, connector: { events: { hooks: {} } } }
					: { name, description, tools: { url: toolsUrl } };
			return call("POST", "/api/admin/connectors", body);
		},
		async remove(name) {
			return call("DELETE", `/api/admin/connectors/${encodeURIComponent(name)}`);
		},
		async mintCredential(name, replace) {
			return call<{ credential: string }>("POST", `/api/admin/connectors/${encodeURIComponent(name)}/credential`, {
				replace,
			});
		},
		async revokeCredential(id) {
			return call("DELETE", `/api/admin/credentials/${encodeURIComponent(id)}`);
		},
		async mintTrigger(name, hook) {
			return call<{ secret: string }>("POST", `/api/admin/connectors/${encodeURIComponent(name)}/trigger`, { hook });
		},
		async removeTrigger(name) {
			return call("DELETE", `/api/admin/connectors/${encodeURIComponent(name)}/trigger`);
		},
	};
	return {
		connector,
		control: (action: "stop" | "compact") => call("POST", "/api/admin/control", { action }).then(then),
		answer: (permissionId: string, answer: "allow" | "deny") =>
			call("POST", `/api/permissions/${encodeURIComponent(permissionId)}`, { answer }).then(then),
		addPerson: (name: string) => call("POST", "/api/admin/roster", { name }),
		removePerson: (name: string) => call("DELETE", `/api/admin/roster/${encodeURIComponent(name)}`),
		mintDevice: (label: string, grants: OperatorGrant[]) =>
			call<{ token: string; id: string }>("POST", "/api/admin/tokens", { label, grants }),
		setGrants: (id: string, grants: OperatorGrant[]) =>
			call("PATCH", `/api/admin/tokens/${encodeURIComponent(id)}`, { grants }),
		revokeDevice: (id: string) => call("DELETE", `/api/admin/tokens/${encodeURIComponent(id)}`),
		setHook: (id: string, enabled: boolean) =>
			call("PATCH", `/api/admin/hooks/${encodeURIComponent(id)}`, { enabled }),
		fireHook: (id: string) => call("POST", `/api/admin/hooks/${encodeURIComponent(id)}/fire`),
	};
}

function Shell({ live }: { readonly live: Live & { readonly refresh: () => Promise<void> } }) {
	const [section, setSection] = useState(sectionFromHash);
	useEffect(() => {
		const onHash = () => setSection(sectionFromHash());
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);
	const go = (id: string) => {
		window.location.hash = `#/${id}`;
		setSection(id);
	};

	const state = live.state;
	const available = useMemo(() => SECTIONS.filter((entry) => state !== undefined && entry.available(state)), [state]);
	const current = available.some((entry) => entry.id === section) ? section : (available[0]?.id ?? "overview");
	const write = useMemo(() => actions(live.refresh), [live.refresh]);
	const config = state?.config;

	return (
		<div className="shell">
			<header className="topbar">
				<div className="wordmark">
					mason<span>operator</span>
				</div>
				<div className="topbar-right">
					{live.error === undefined ? null : (
						<span className="stale" title={live.error}>
							not updating
						</span>
					)}
					<LiveDot live={live} />
					{state === undefined ? null : (
						<span className="device">
							{state.session.device.label}
							{state.session.person === undefined ? "" : ` · ${state.session.person}`}
						</span>
					)}
				</div>
			</header>
			<nav className="rail" aria-label="panel sections">
				{available.map((entry) => (
					<button
						type="button"
						key={entry.id}
						className={`rail-item${current === entry.id ? " on" : ""}`}
						onClick={() => go(entry.id)}
					>
						{entry.label}
						{entry.id === "approvals" && (state?.permissions?.length ?? 0) > 0 ? (
							<span className="count">{state?.permissions?.length}</span>
						) : null}
					</button>
				))}
			</nav>
			<main className="pane">
				{state === undefined ? (
					<p className="empty">Reading the panel…</p>
				) : (
					<>
						{state.session.grants.length === 0 ? (
							<p className="error-note">
								This device has no grants. Ask the operator to give it one from the access page of a device that
								has the <code>admin</code> grant.
							</p>
						) : null}
						{current === "overview" ? <Overview state={state} /> : null}
						{current === "conversation" && state.conversation !== undefined ? (
							<Conversation conversation={state.conversation} onControl={write.control} />
						) : null}
						{current === "approvals" && state.permissions !== undefined ? (
							<Approvals permissions={state.permissions} onAnswer={write.answer} />
						) : null}
						{current === "trace" && state.trace !== undefined ? <TraceView trace={state.trace} /> : null}
						{current === "connectors" && config !== undefined ? (
							<Connectors
								config={config}
								credentials={config.credentials}
								actions={write.connector}
								refresh={live.refresh}
							/>
						) : null}
						{current === "roster" && config !== undefined ? (
							<Roster
								people={config.roster}
								onAdd={write.addPerson}
								onRemove={write.removePerson}
								refresh={live.refresh}
							/>
						) : null}
						{current === "access" && config !== undefined ? (
							<Access
								config={config}
								onMint={write.mintDevice}
								onGrants={write.setGrants}
								onRevoke={write.revokeDevice}
								onRevokeCredential={write.connector.revokeCredential}
								refresh={live.refresh}
							/>
						) : null}
						{current === "hooks" && config !== undefined ? (
							<Hooks
								hooks={config.hooks}
								onToggle={write.setHook}
								onFire={write.fireHook}
								refresh={live.refresh}
							/>
						) : null}
					</>
				)}
			</main>
		</div>
	);
}

/** A quiet dot: it says the poll is landing, not that the bot is happy. */
function LiveDot({ live }: { readonly live: Live }) {
	const tone = live.error !== undefined ? "stale" : live.state === undefined ? "waiting" : "live";
	return (
		<span className={`live-dot ${tone}`} title={tone === "live" ? "reading the server" : "the last read failed"} />
	);
}

function Root() {
	const live = usePanel();
	if (!live.booted) return null;
	// A device mason does not know and a server that is not answering are different sentences: one is a pairing link,
	// the other is a process.
	if (live.unpaired) return <Unpaired reason="unpaired" />;
	if (live.state === undefined && live.error !== undefined) return <Unpaired reason="unreachable" />;
	return <Shell live={live} />;
}

const container = document.getElementById("root");
if (container === null) throw new Error("missing #root");
createRoot(container).render(<Root />);
