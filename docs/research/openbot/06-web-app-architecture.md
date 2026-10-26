# Web app: architecture, not chrome

## What it is

`app/` is one React 19 single-page application and it is the whole OpenBot product surface: channels,
chat, the live screen, settings, admin, onboarding (`app/src/routes/**`). In production the API server serves
the built bundle on its own origin; in development and on desktop Vite serves it and proxies `/api`
(`app/vite.config.ts:63-90`, `docs/architecture.md:16`). There is no SSR and no client state library; three
transports and two caches carry everything.

## How it works

Vite 7, React 19.2, Base UI/shadcn, Tailwind 4, `motion` (`app/package.json:1-70`); built with
`bun --bun vite build` and typechecked with `tsc --noEmit` (`app/package.json:8-14`). Routing is
`@tanstack/react-router` 1.170, file-based, with a generated `routeTree.gen.ts` (1492 lines,
`app/src/router.tsx:4`). Server state is `@tanstack/react-query` 5 behind one `QueryClient`
(`app/src/query-client.ts:3-10`); the conversation is CopilotKit `react-core` v2 1.77 plus AG-UI message
types (`app/src/lib/copilot/provider.tsx:37-38`). The query client, injected as router context, is the only
global the app has (`app/src/main.tsx:13-19`).

### Routing model

Routes are files under `app/src/routes`; pathless segments are the gates:

```
__root.tsx            an unknown address -> "/"
└ _authed.tsx         beforeLoad: /api/me -> /sign; unfinished onboarding -> /onboarding
  └ CopilotProvider   INSIDE the gate: the runtime needs a session
    ├ _app.tsx        sidebar shell, one viewport
    ├ admin/route.tsx beforeLoad: user.role !== "admin" -> "/"
    └ settings/route.tsx, onboarding.tsx
```

Gates are `beforeLoad` plus `context.queryClient.ensureQueryData` (`app/src/routes/_authed.tsx:7-25`,
`app/src/routes/_authed/admin/route.tsx:7-14`); `__root.tsx:13-15` sends any unknown address to `/`, so a
typo funnels through the auth guard instead of a dead end. The Copilot provider sits at `_authed` because a
provider above the gate "would open a run for a visitor who has not signed in yet"
(`app/src/routes/_authed.tsx:22-25`). There are no route loaders (grep for `loader:` in `src/routes`
returns nothing): components fetch with `useQuery`, and the only router prefetches are the gate and `/sign`
painting with its buttons (`app/src/routes/sign.tsx:46-71`). Search params are normalised to text because
`?flow_id=123` arrives as a number (`app/src/router.tsx:14-16`, `app/src/routes/sign.tsx:34-52`), and legacy
URLs redirect through a pure mapping module (`app/src/lib/agents/legacy-routes.ts:1-32`).

### Data layer

One transport for all REST: `app/src/lib/client.ts`. `send()` sets `credentials: "include"` and JSON only;
`client()` throws with the server's `body.error` or a caller-supplied fallback sentence, and a 200 whose
body is not an object counts as failure (`app/src/lib/client.ts:35-110`). `tryClient()` returns the
`Response` so a refusal can be a value — the 401 on `/api/me` is "not signed in", not "the request broke"
(`app/src/lib/auth/queries.ts:61-77`) — and the envelope key is a call-site argument, not a client guess
(`app/src/lib/client.ts:1-13`).

Each entity gets a folder in `src/lib` with `queries.ts` (a `queryOptions` factory and key factory) and
`mutations.ts` (`mutationOptions` that invalidate, never hand-patch): "Server-derived fields are invalidated
instead of patched by hand" (`app/src/lib/agents/mutations.ts:24-32`). Types are re-declared in the client
(`AgentProfile`, `app/src/lib/agents/queries.ts:12-56`) rather than imported, and server-decided
authorization facts (`canManage`, `mine`) are rendered as returned instead of recomputed
(`app/src/lib/agents/queries.ts:14-19`). Growing lists are paged (`app/src/lib/channels/queries.ts:66-88`);
component grants poll every 5s (`app/src/lib/components/queries.ts:50-60`).

### Streaming and chat state

The conversation is *not* React Query state. It is CopilotKit's agent instance from `useAgent()`,
subscribed to `OnMessagesChanged` and `OnRunStatusChanged`, read and written through `agent.messages` /
`agent.setMessages` (`app/src/components/channels/channel-chat.tsx:283-292`, `:389-420`). The provider
points at `runtimeUrl="/api/copilotkit"` with `credentials: "include"` and no public API key
(`app/src/lib/copilot/provider.tsx:17-40`). The runtime is mounted last, at the root with its own `basePath`,
so it cannot shadow an OpenBot route (`server/src/app.ts:1360-1372`, `server/src/copilot.ts:1707-1820`). The
browser never opens an SSE connection itself: the SDK owns the run transport, and AG-UI appears in the app
only as message types.

History comes back over a second, ordinary endpoint, `/api/copilotkit/threads/:id/messages`, read
fail-closed with a 1500 ms deadline so slow history never blocks the composer
(`app/src/lib/copilot/thread-messages.ts:60-78`). Each turn is parsed against AG-UI's `MessageSchema`; one
that does not parse is left out and counted, so the screen can say a message could not be read
(`app/src/lib/copilot/thread-messages.ts:78-100`, `app/src/components/channels/channel-chat.tsx:100-118`).
The store's `{id,name,args}` tool-call dialect is translated rather than discarded, because dropping it
deleted every turn in which a Bot used a tool (`app/src/lib/copilot/thread-messages.ts:118-160`).

Live roster updates arrive on one WebSocket, `/api/channels/events`, opened by the sidebar
(`app/src/components/app-sidebar/app-sidebar.tsx:227`, `app/src/lib/channels/use-channel-events.ts:200-280`).
Its whole job is patching the cached roster: `applyChannelEvent` is pure over the query's pages and returns
the same object when nothing changed; the socket reconnects with 500 ms to 30 s backoff, refetching on open
(`app/src/lib/channels/use-channel-events.ts:106-196`). The server calls this channel an optimisation and
never a source of truth, fanned out through Postgres `NOTIFY` because an in-process list is "silently wrong
the moment a second server instance exists", with a `resync` message covering what NOTIFY cannot replay
(`server/src/channels/events.ts:5-20`). Two more sockets serve the live computer screen and voice, the latter
connecting straight to `wss://api.x.ai/v1/realtime` with a server-minted client secret
(`app/src/components/computer/live-screen.tsx:248-250`, `app/src/lib/voice/websocket.ts:143-166`).

### Auth, session, splitting, tests

Better Auth session cookie, carried by `credentials: "include"` in the single fetch wrapper and the Copilot
provider. No token in JavaScript, no session in `localStorage`. The gate is a query:
`currentUserQueryOptions`, `staleTime: 60_000`, onboarding status riding on the user object
(`app/src/lib/auth/queries.ts:10-30`, `:88-110`). Capabilities
come from `/api/capabilities` before sign-in with `staleTime: Infinity` because they "cannot change without
the process restarting", and the response is a projection that never carries deployment secrets
(`app/src/lib/deployment/queries.ts:4-58`, `app/src/lib/auth/queries.ts:78-86`). The client then refuses to
enable what the server did not: the generative-UI option is spread in only when the capability says so,
because the SDK reads the option's presence as an enable (`app/src/lib/copilot/provider.tsx:44-56`).

Splitting is per route file, not per component: `autoCodeSplitting` plus five manual chunks —
`route-sign`, `route-chat-core` (the `_authed` and `_app` layouts and `_app/channel/*`), `route-admin`,
`route-settings`, `route-app-secondary` — with `onlyExplicitManualChunks: true`
(`app/vite.config.ts:113-171`), so the chat SDK lives in the layout chunk and every authenticated screen
loads it. Workspaces are `app`, `server`, `worker`, `shared`, `toolkit` (`package.json:9-15`); `shared/` is
plain TypeScript with no React and no server dependency, imported for vocabulary only
(`shared/package.json:1-15`, `app/src/lib/copilot/markers.ts`). The wire contract is not shared: each side
spells its own types. The one genuinely shared contract is the widget catalogue, where components declare
model-facing metadata beside the renderer, are discovered with `import.meta.glob`, and the build announces
the names it can draw so the server can own publication and grants
(`app/src/lib/copilot/gallery-registry.ts:1-130`, `docs/architecture.md:199-206`).

`bun test` from the repo root, happy-dom, `@testing-library/react`: 209 test files under `app/tests/` plus
ten beside their source, named after the decision or the bug they pin
(`app/tests/app-resilience-guards.test.ts:1-40`). The design supports that — the socket protocol's drop
rules are pure and exported so they are provable without a socket
(`app/src/lib/channels/use-channel-events.ts:54-104`), and `readableTurns` is exported "so it can be tested
against real stored shapes without a server" (`app/src/lib/copilot/thread-messages.ts:70-78`). End-to-end is
outside `bun test`: the journey suite is opt-in, needs a live deployment and a signed-in cookie
(`tests/smoke/journey.test.ts:1-56`).

## Decisions and their reasons

**Two state authorities, split by kind.** React Query owns server data; CopilotKit owns the conversation.
Cost: a merge and repair layer when the two disagree about one transcript
(`app/src/components/channels/channel-chat.tsx:130-180`, `app/src/lib/copilot/repair-history.ts`).

**REST with an envelope, no schema sharing.** Bought: no codegen, and a human sentence per endpoint. Cost:
`AgentProfile`, `ChannelSummary` and neighbours are hand-copied from the server, so a renamed field is a
silent `undefined` in a renderer rather than a type error.

**Sockets are never authoritative.** "Nothing may be knowable only through the socket"
(`server/src/channels/events.ts:5-20`): reconnect is a refetch, not a replay log, so the transcript needs its
own endpoint and transient facts vanish on refetch (`app/src/lib/channels/queries.ts:36-46`).

**Deployment facts come from the server; product facts are baked.** Providers and capabilities are fetched
because "the image is built once with no deployment environment" (`app/src/lib/auth/queries.ts:78-84`), and
the Vite plugin keeps the server's port out of the built HTML after a baked port broke a fleet
(`app/vite.config.ts:11-22`). Branding is the exception, generated into the bundle from a tenant package
(`scripts/generate-app-config.ts:18-30`, `app/package.json:11-13`).

## Mason-relevant

**Worth copying**

- The route-level gate. Mason's `src/web/lib/session.ts` + `screenFor` does it imperatively in the shell; with
a second screen, a guard on the boundary beats a status branch.
- `client.ts` as a shape for mason's REST edges (dictation `/asr`, the widget bridge): one transport,
envelope key and human sentence at the call site, malformed success counted as failure.
- A widget catalogue for `generateSandboxedUi`. Openbot's gallery is a middle ground mason lacks: compiled
components declaring their model-facing description, preview props and the data functions they read,
discovered by glob, with publication and grants server-side
(`app/src/lib/copilot/gallery-registry.ts:1-130`). That is a tool face for a widget rather than a generic
sandbox.
- One capability answer gating both halves of a feature (`provider.tsx:44-56`), the client-side twin of
mason's projection whitelist.

**Worth avoiding**

- Two owners of one conversation. Mason's Chord cells (`transcript`, `queued`, `agentStatus`) are one
authority; a query cache beside them would cost a merge layer.
- Hand-restated wire types per entity. Mason spells the contract once in `src/shared/contract.ts` with TypeBox
schemas; keep that.
- A chat queue held only in the mount: reload or navigation loses parked messages, because "the turn is
driven from the browser" (`app/src/components/channels/composer/queue.ts:23-48`). Mason's queue is durable in
`pi.inbox` with per-item withdraw, which is strictly better.
- Route-level splitting that still ships the chat SDK on every screen; split at the socket/widget boundary.
- The component volume: `components/ui` plus the gallery is tens of thousands of lines of chrome for a chat
that is one column.

**Already right in mason**

- The whitelist projection. Openbot ships AG-UI `Message` objects to the browser and renders tool calls from
client state (`app/src/lib/copilot/thread-messages.ts:1-40`); mason's `src/server/projection.ts` keeps
reasoning, calls and output server-side.
- One transport for both directions. Openbot needs REST + React Query + a roster socket + a runtime + a
history endpoint for one conversation; Chord carries state and controls over one socket.
- The working line derived from a status cell (`src/web/lib/working.ts`) over a `busy` boolean patched onto
roster rows by an event (`app/src/lib/channels/use-channel-events.ts:174-186`).
- A per-browser pairing cookie (`/join`, `src/web/lib/session.ts`) instead of re-running OAuth when a session
lapses.

## Open questions

- The run transport is not settled here: it lives inside `@copilotkit/react-core` and `@copilotkit/runtime`,
and the app never names a protocol. Reading those packages, or the network panel against a live deployment,
would settle it.
- Whether the two-owner transcript misbehaves in practice is inferred from `mergeStoredMessages` and
`repair-history.ts`; no test or comment records an observed failure.
- Chunk sizes are not recorded, so "the chat SDK ships on every authenticated screen" is structural
(`vite.config.ts:136-150`), not measured. `application-config.ts` is unverified for a white-label fork: a root
script writes it from `server/src/tenant-package`, and the clone lacks it until `generate:app-config` runs.
